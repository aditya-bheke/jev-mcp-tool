import { errorSignature } from './errorIntel.js';
import { gitDiffForFiles } from '../core/git.js';
import { log } from '../core/logger.js';
import { normalizeRelPaths } from '../core/paths.js';
import { scrubSecrets } from '../core/secrets.js';
import { decomposeIdentifiers, ftsQuery, jaccard, overlapCoefficient, textTerms, tokenizeQuery } from '../core/tokenize.js';
import { CortexError, clamp, oneLine, round, safeJsonParse, truncate, uniq, uuid } from '../core/util.js';

export const OUTCOMES = ['in_progress', 'confirmed_solution', 'dead_end', 'partially_valid'];

const MATCH_THRESHOLD = 0.45;
const DUPLICATE_THRESHOLD = 0.8;

function publicInvestigation(row, extra = {}) {
  return {
    id: row.id,
    hypothesis: row.hypothesis,
    outcome: row.outcome,
    root_question: row.root_question ?? null,
    notes: row.notes ?? null,
    inspected_paths: safeJsonParse(row.inspected_paths, []),
    attempts: row.attempts,
    updated_at: row.updated_at,
    ...extra,
  };
}

/** Subsystems F + G: investigation ledger and duplicate-work prevention. */
export class InvestigationEngine {
  constructor(ctx) {
    this.ctx = ctx;
  }

  candidates(text, limit = 30) {
    const { terms, compounds } = tokenizeQuery(text);
    const tokens = [...compounds, ...terms].slice(0, 24);
    const run = (match) => {
      if (!match) return [];
      try {
        return this.ctx.db.all(
          `SELECT i.* FROM investigations_fts JOIN investigations i ON i.id = investigations_fts.id
           WHERE investigations_fts MATCH ? AND i.project_id = ?
           ORDER BY bm25(investigations_fts, 0.0, 4.0, 2.0, 1.0, 2.0) LIMIT ?`,
          match,
          this.ctx.projectId,
          limit,
        );
      } catch (err) {
        log.debug(`investigation lookup failed: ${err.message}`);
        return [];
      }
    };
    let rows = run(ftsQuery(tokens));
    if (!rows.length) rows = run(ftsQuery(tokens, { prefix: true }));
    return rows;
  }

  similarity(hypothesisTerms, row) {
    const direct = jaccard(hypothesisTerms, textTerms(row.hypothesis));
    const contextual = overlapCoefficient(hypothesisTerms, textTerms(`${row.root_question ?? ''} ${row.notes ?? ''}`)) * 0.5;
    return Math.max(direct, contextual);
  }

  check({ hypothesis, error_text = null, limit = 5 }) {
    const { db, projectId, root, engines } = this.ctx;
    const sig = error_text ? errorSignature(error_text, root, { fallback: true }) : null;
    const hypothesisTerms = textTerms(hypothesis);
    const byId = new Map();
    for (const row of this.candidates(`${hypothesis} ${sig ? sig.sample : ''}`)) byId.set(row.id, row);
    if (sig) {
      const sameError = db.all('SELECT * FROM investigations WHERE project_id = ? AND error_signature = ? ORDER BY updated_at DESC LIMIT 10', projectId, sig.signature);
      for (const row of sameError) byId.set(row.id, row);
    }
    const scored = [...byId.values()]
      .map((row) => {
        const sim = this.similarity(hypothesisTerms, row);
        const sameError = !!(sig && row.error_signature === sig.signature);
        return { row, sim, sameError, rank: sim + (sameError ? 0.3 : 0) };
      })
      .filter((s) => s.sim >= 0.2 || s.sameError)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, clamp(Number(limit) || 5, 1, 20));

    const best = scored.find((s) => s.sim >= MATCH_THRESHOLD);
    let status = best ? best.row.outcome : 'not_found';
    if (status === 'not_found' && scored.some((s) => s.sameError && s.row.outcome === 'confirmed_solution')) status = 'confirmed_solution';
    const knownFix = sig ? engines.errors.lookup(sig.signature) : null;
    if (status === 'not_found' && knownFix) status = 'known_fix';
    engines.telemetry.record('investigation_check', { hit: status !== 'not_found' });
    return {
      status,
      hypothesis,
      error_signature: sig?.signature ?? null,
      known_fix: knownFix,
      matches: scored.map((s) => publicInvestigation(s.row, { similarity: round(s.sim), same_error: s.sameError })),
    };
  }

  log({ id = null, hypothesis, outcome, notes = null, root_question = null, inspected_paths = [], error_text = null, fix_summary = null, fix_files = [] }) {
    const { db, projectId, root, engines } = this.ctx;
    if (!OUTCOMES.includes(outcome)) throw new CortexError('BAD_OUTCOME', `outcome must be one of: ${OUTCOMES.join(', ')}`);
    let redactions = 0;
    const clean = (value) => {
      if (value == null || value === '') return null;
      const r = scrubSecrets(String(value));
      redactions += r.count;
      return r.text;
    };
    const hyp = clean(hypothesis);
    if (!hyp) throw new CortexError('EMPTY', 'hypothesis is required.');
    const cleanNotes = clean(notes);
    const cleanQuestion = clean(root_question);
    const sig = error_text ? errorSignature(error_text, root, { fallback: true }) : null;
    const paths = normalizeRelPaths(inspected_paths, root);
    const keywords = decomposeIdentifiers(`${hyp} ${cleanQuestion ?? ''} ${cleanNotes ?? ''}`, { limit: 80 }).join(' ');
    const now = Date.now();

    let existing = null;
    if (id) {
      const prefix = String(id).trim().replace(/[^0-9a-fA-F-]/g, '');
      const rows = prefix.length >= 4 ? db.all('SELECT * FROM investigations WHERE project_id = ? AND id LIKE ? LIMIT 2', projectId, `${prefix}%`) : [];
      if (rows.length !== 1) throw new CortexError('NOT_FOUND', `No unique investigation matches "${id}".`);
      existing = rows[0];
    } else {
      const terms = textTerms(hyp);
      existing = this.candidates(hyp, 10)
        .map((row) => ({ row, sim: jaccard(terms, textTerms(row.hypothesis)) }))
        .filter((s) => s.sim >= DUPLICATE_THRESHOLD)
        .sort((a, b) => b.sim - a.sim)[0]?.row ?? null;
    }

    let recordId;
    let status;
    if (existing) {
      recordId = existing.id;
      status = 'updated';
      const mergedPaths = uniq([...safeJsonParse(existing.inspected_paths, []), ...paths]).slice(0, 50);
      const mergedNotes = cleanNotes
        ? truncate(existing.notes && existing.notes !== cleanNotes ? `${existing.notes}\n---\n${cleanNotes}` : cleanNotes, 4000)
        : existing.notes;
      db.run(
        `UPDATE investigations SET hypothesis = ?, outcome = ?, notes = ?, root_question = COALESCE(?, root_question), inspected_paths = ?,
          error_signature = COALESCE(?, error_signature), keywords = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
        hyp,
        outcome,
        mergedNotes,
        cleanQuestion,
        JSON.stringify(mergedPaths),
        sig?.signature ?? null,
        keywords,
        now,
        recordId,
      );
    } else {
      recordId = uuid();
      status = 'created';
      db.run(
        `INSERT INTO investigations (id, project_id, root_question, hypothesis, outcome, notes, inspected_paths, error_signature,
          keywords, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        recordId,
        projectId,
        cleanQuestion,
        hyp,
        outcome,
        cleanNotes,
        JSON.stringify(paths),
        sig?.signature ?? null,
        keywords,
        now,
        now,
      );
    }
    if (sig) engines.errors.ensure(sig);

    let fix = null;
    let memory = null;
    if (outcome === 'confirmed_solution' && sig) {
      const files = normalizeRelPaths(fix_files, root);
      const diff = files.length ? gitDiffForFiles(root, files) : null;
      const summary = clean(fix_summary) ?? cleanNotes ?? hyp;
      engines.errors.recordFix(sig, {
        fix_summary: summary,
        fix_files: files,
        fix_diff: diff ? scrubSecrets(diff).text : null,
        investigation_id: recordId,
      });
      fix = { signature: sig.signature, files, captured_diff: !!diff };
      try {
        const saved = engines.memory.save({
          title: `Fix: ${oneLine(sig.sample.split('\n')[0], 90)}`,
          category: 'fix',
          content: `Error: ${oneLine(sig.sample, 300)}\nCause: ${hyp}\nFix: ${summary}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`,
          source_type: 'test_result',
          confidence: 0.8,
          scope_paths: files,
          tags: ['error-fix'],
          reason: `confirmed solution ${recordId}`,
        });
        memory = { id: saved.memory.id, status: saved.status };
      } catch (err) {
        log.warn(`could not save fix memory: ${err.message}`);
      }
    }
    return { id: recordId, status, outcome, error_signature: sig?.signature ?? null, fix, memory, redactions };
  }

  recent({ since = 0, outcomes = OUTCOMES, limit = 5 } = {}) {
    const list = outcomes.filter((o) => OUTCOMES.includes(o));
    if (!list.length) return [];
    const rows = this.ctx.db.all(
      `SELECT * FROM investigations WHERE project_id = ? AND updated_at >= ? AND outcome IN (${list.map(() => '?').join(', ')})
       ORDER BY updated_at DESC LIMIT ?`,
      this.ctx.projectId,
      since,
      ...list,
      limit,
    );
    return rows.map((row) => publicInvestigation(row));
  }

  related(text, limit = 3) {
    const terms = textTerms(text);
    return this.candidates(text, 15)
      .map((row) => ({ row, sim: this.similarity(terms, row) }))
      .filter((s) => s.sim >= 0.15)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit)
      .map((s) => publicInvestigation(s.row, { similarity: round(s.sim) }));
  }
}
