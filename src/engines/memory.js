import { globToRegExp } from '../core/glob.js';
import { log } from '../core/logger.js';
import { normalizeRelPaths } from '../core/paths.js';
import { scrubSecrets } from '../core/secrets.js';
import { decomposeIdentifiers, ftsQuery, jaccard, textTerms, tokenizeQuery } from '../core/tokenize.js';
import { CortexError, clamp, round, safeJsonParse, sha256, truncate, uuid } from '../core/util.js';

export const MEMORY_CATEGORIES = ['architecture', 'convention', 'decision', 'fix', 'task'];
export const SOURCE_TYPES = ['user_instruction', 'agent_observation', 'test_result'];
export const MANAGE_ACTIONS = ['get', 'history', 'verify', 'rollback', 'delete'];

const NEGATION = /\b(?:not|never|no longer|don't|do not|doesn't|does not|avoid|instead of|deprecated|forbid(?:den)?|disallow(?:ed)?|must not|shouldn't|should not|stop(?:ped)? using|without)\b/i;

const MEMORY_FIELDS = [
  'category', 'title', 'content', 'confidence', 'source_type', 'is_contested', 'contest_note', 'needs_verification',
  'scope_paths', 'invalidation_rule', 'tags', 'keywords', 'content_hash', 'hit_count', 'created_at', 'updated_at',
  'last_verified_at',
];

const INSERT_MEMORY = `INSERT INTO memories (id, project_id, category, title, content, confidence, source_type, is_contested,
  contest_note, needs_verification, scope_paths, invalidation_rule, tags, keywords, content_hash, hit_count, created_at,
  updated_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const FTS_SELECT = `SELECT m.*, bm25(memories_fts, 0.0, 6.0, 2.0, 3.0, 2.0) AS bm
  FROM memories_fts JOIN memories m ON m.id = memories_fts.id
  WHERE memories_fts MATCH ? AND m.project_id = ?`;

function normalizeForHash(title, content) {
  return `${title}\n${content}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function scopeMatches(scope, filePath) {
  if (/[*?[]/.test(scope)) return globToRegExp(scope).test(filePath);
  const s = scope.replace(/\/+$/, '');
  return filePath === s || filePath.startsWith(`${s}/`);
}

export function publicMemory(row, scope) {
  return {
    id: row.id,
    scope,
    category: row.category,
    title: row.title,
    content: row.content,
    confidence: round(row.confidence, 3),
    source_type: row.source_type,
    contested: !!row.is_contested,
    contest_note: row.contest_note ?? null,
    stale: !!row.needs_verification,
    scope_paths: safeJsonParse(row.scope_paths, []),
    tags: row.tags ? row.tags.split(' ').filter(Boolean) : [],
    invalidation_rule: row.invalidation_rule ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_verified_at: row.last_verified_at,
  };
}

/**
 * Subsystem A (+H conflict handling, +J versioning): long-term project memory with provenance,
 * confidence caps for agent-derived facts, contradiction detection, staleness decay when the
 * files in a memory's scope change, and a full version log with rollback.
 */
export class MemoryEngine {
  constructor(ctx) {
    this.ctx = ctx;
  }

  stores() {
    const list = [{ db: this.ctx.db, projectId: this.ctx.projectId, scope: this.ctx.root ? 'project' : 'global' }];
    const g = this.ctx.getGlobal();
    if (g && !(g.db === this.ctx.db && g.projectId === this.ctx.projectId)) list.push({ ...g, scope: 'global' });
    return list;
  }

  target(scope) {
    if (scope === 'global') {
      const g = this.ctx.getGlobal();
      if (!g) throw new CortexError('GLOBAL_UNAVAILABLE', 'The global memory store (~/.codex/global_cortex.db) is unavailable.');
      return { ...g, scope: 'global' };
    }
    return { db: this.ctx.db, projectId: this.ctx.projectId, scope: this.ctx.root ? 'project' : 'global' };
  }

  /** Find a memory by id or unique id prefix across the project and global stores. */
  locate(idOrPrefix) {
    const id = String(idOrPrefix ?? '').trim().replace(/[^0-9a-fA-F-]/g, '');
    if (id.length < 4) throw new CortexError('BAD_ID', 'A memory id (or a prefix of at least 4 characters) is required.');
    for (const store of this.stores()) {
      const rows = store.db.all('SELECT * FROM memories WHERE project_id = ? AND id LIKE ? LIMIT 2', store.projectId, `${id}%`);
      if (rows.length > 1) throw new CortexError('AMBIGUOUS_ID', `Memory id prefix "${id}" is ambiguous; use more characters.`);
      if (rows.length === 1) return { ...store, row: rows[0] };
    }
    return null;
  }

  require(idOrPrefix) {
    const found = this.locate(idOrPrefix);
    if (!found) throw new CortexError('NOT_FOUND', `No memory matches id "${idOrPrefix}".`);
    return found;
  }

  logVersion(db, projectId, memoryId, operation, before, after, reason) {
    db.run(
      `INSERT INTO memory_versions (memory_id, project_id, operation, content_before, content_after, snapshot_before,
        snapshot_after, altered_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      memoryId,
      projectId,
      operation,
      before ? before.content : null,
      after ? after.content : null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      reason ?? null,
      Date.now(),
    );
  }

  insertRow(db, r) {
    db.run(
      INSERT_MEMORY,
      r.id,
      r.project_id,
      r.category,
      r.title,
      r.content,
      r.confidence,
      r.source_type,
      r.is_contested ? 1 : 0,
      r.contest_note ?? null,
      r.needs_verification ? 1 : 0,
      r.scope_paths ?? '[]',
      r.invalidation_rule ?? null,
      r.tags ?? '',
      r.keywords ?? '',
      r.content_hash,
      r.hit_count ?? 0,
      r.created_at,
      r.updated_at,
      r.last_verified_at,
    );
  }

  updateRow(db, id, fields) {
    const keys = Object.keys(fields).filter((k) => MEMORY_FIELDS.includes(k));
    if (!keys.length) return;
    db.run(`UPDATE memories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  }

  row(db, id) {
    return db.get('SELECT * FROM memories WHERE id = ?', id);
  }

  findSimilar(db, projectId, title, content) {
    const { terms, compounds } = tokenizeQuery(`${title} ${content}`);
    const match = ftsQuery([...compounds, ...terms].slice(0, 20));
    if (!match) return [];
    let rows;
    try {
      rows = db.all(`${FTS_SELECT} ORDER BY bm LIMIT 25`, match, projectId);
    } catch (err) {
      log.debug(`memory similarity lookup failed: ${err.message}`);
      return [];
    }
    const titleTerms = textTerms(title);
    const allTerms = textTerms(`${title} ${content}`);
    return rows
      .map((row) => ({
        row,
        titleSim: jaccard(titleTerms, textTerms(row.title)),
        contentSim: jaccard(allTerms, textTerms(`${row.title} ${row.content}`)),
      }))
      .filter((s) => s.titleSim >= 0.3 || s.contentSim >= 0.2)
      .sort((a, b) => b.contentSim - a.contentSim);
  }

  result(status, row, scope, warnings, extra = {}) {
    return { status, memory: publicMemory(row, scope), warnings, ...extra };
  }

  save(input) {
    const store = this.target(input.scope);
    const { db, projectId } = store;
    const category = input.category;
    if (!MEMORY_CATEGORIES.includes(category)) {
      throw new CortexError('BAD_CATEGORY', `category must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
    }
    const t = scrubSecrets(String(input.title ?? '').trim());
    const c = scrubSecrets(String(input.content ?? '').trim());
    const title = t.text;
    const content = c.text;
    if (!title || !content) throw new CortexError('EMPTY', 'title and content are required.');

    const cfg = this.ctx.config.memory;
    const source = SOURCE_TYPES.includes(input.source_type) ? input.source_type : 'agent_observation';
    const warnings = [];
    const redactions = t.count + c.count;
    if (redactions) warnings.push(`${redactions} secret(s) were redacted before storage.`);
    let confidence = clamp(Number(input.confidence ?? (source === 'agent_observation' ? cfg.agent_confidence_cap : 1)), 0, 1);
    if (source === 'agent_observation' && confidence > cfg.agent_confidence_cap) {
      confidence = cfg.agent_confidence_cap;
      warnings.push(`Agent-derived memories are capped at ${cfg.agent_confidence_cap}. After the user confirms it, call cortex_memory_manage action=verify.`);
    }

    const now = Date.now();
    const base = {
      category,
      title,
      content,
      confidence,
      source_type: source,
      scope_paths: JSON.stringify(normalizeRelPaths(input.scope_paths ?? [], this.ctx.root)),
      invalidation_rule: input.invalidation_rule ? scrubSecrets(String(input.invalidation_rule)).text : null,
      tags: (input.tags ?? []).map((tag) => String(tag).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean).join(' '),
      keywords: decomposeIdentifiers(`${title} ${content}`, { limit: 120 }).join(' '),
      content_hash: sha256(normalizeForHash(title, content)),
    };

    // 1. Explicit overwrite: the caller confirmed this replaces an existing memory.
    if (input.supersedes) {
      const found = this.require(input.supersedes);
      const before = found.row;
      this.updateRow(found.db, before.id, {
        ...base,
        is_contested: 0,
        contest_note: null,
        needs_verification: 0,
        updated_at: now,
        last_verified_at: now,
      });
      const after = this.row(found.db, before.id);
      this.logVersion(found.db, found.projectId, before.id, 'update', before, after, input.reason ?? 'explicit supersede');
      this.ctx.engines.telemetry.record('memory_save', { meta: { status: 'updated' } });
      return this.result('updated', after, found.scope, warnings);
    }

    // 2. Exact duplicate: refresh verification time only.
    const dup = db.get('SELECT * FROM memories WHERE project_id = ? AND content_hash = ?', projectId, base.content_hash);
    if (dup) {
      const fields = { last_verified_at: now, updated_at: now };
      if (confidence > dup.confidence) fields.confidence = confidence;
      if (source === 'user_instruction' && dup.source_type !== 'user_instruction') fields.source_type = source;
      this.updateRow(db, dup.id, fields);
      return this.result('unchanged', this.row(db, dup.id), store.scope, warnings);
    }

    // 3. Same topic: update in place, unless it contradicts a high-confidence memory.
    const similar = this.findSimilar(db, projectId, title, content);
    const sameTopic = similar.find((s) => s.row.category === category && s.titleSim >= 0.75);
    if (sameTopic) {
      const existing = sameTopic.row;
      const strong = existing.confidence >= 0.8 && !existing.is_contested;
      if (strong && sameTopic.contentSim < 0.8 && source !== 'user_instruction') {
        return this.contest(db, projectId, existing, { title, content }, store.scope, warnings, 'same topic, different content');
      }
      this.updateRow(db, existing.id, { ...base, is_contested: 0, contest_note: null, needs_verification: 0, updated_at: now, last_verified_at: now });
      const after = this.row(db, existing.id);
      this.logVersion(db, projectId, existing.id, 'update', existing, after, input.reason ?? 'newer observation on the same topic');
      this.ctx.engines.telemetry.record('memory_save', { meta: { status: 'updated' } });
      return this.result('updated', after, store.scope, warnings);
    }

    // 4. Opposite polarity on a closely related high-confidence memory → contested.
    const conflict = similar.find(
      (s) => s.contentSim >= cfg.contest_similarity && s.row.confidence >= 0.8 && !s.row.is_contested && NEGATION.test(s.row.content) !== NEGATION.test(content),
    );
    if (conflict && source !== 'user_instruction') {
      return this.contest(db, projectId, conflict.row, { title, content }, store.scope, warnings, 'possible contradiction');
    }

    // 5. New memory.
    const id = uuid();
    this.insertRow(db, {
      id,
      project_id: projectId,
      ...base,
      is_contested: 0,
      contest_note: null,
      needs_verification: 0,
      hit_count: 0,
      created_at: now,
      updated_at: now,
      last_verified_at: now,
    });
    const saved = this.row(db, id);
    this.logVersion(db, projectId, id, 'create', null, saved, input.reason ?? null);
    this.ctx.engines.telemetry.record('memory_save', { meta: { status: 'created' } });
    const related = similar
      .filter((s) => s.contentSim >= 0.3)
      .slice(0, 3)
      .map((s) => ({ id: s.row.id, title: s.row.title, similarity: round(s.contentSim) }));
    return this.result('created', saved, store.scope, warnings, { related });
  }

  /** Mark an existing memory as contested and refuse to overwrite it without confirmation. */
  contest(db, projectId, existing, proposal, scope, warnings, reason) {
    const now = Date.now();
    const note = `${new Date(now).toISOString().slice(0, 10)} proposal "${truncate(proposal.title, 120)}": ${truncate(proposal.content, 400)}`;
    this.updateRow(db, existing.id, { is_contested: 1, contest_note: note, updated_at: now });
    const after = this.row(db, existing.id);
    this.logVersion(db, projectId, existing.id, 'contest', existing, after, `${reason}: ${truncate(proposal.content, 500)}`);
    const short = existing.id.slice(0, 8);
    warnings.push(`Contradicts memory ${short} "${existing.title}" (confidence ${round(existing.confidence)}): ${truncate(existing.content, 240)}`);
    warnings.push(
      `Not saved. Ask the user which is correct, then call cortex_memory_save(..., supersedes="${short}") to replace it, or cortex_memory_manage(action="verify", id="${short}") to keep the existing memory.`,
    );
    this.ctx.engines.telemetry.record('memory_save', { meta: { status: 'contested' } });
    return this.result('contested', after, scope, warnings);
  }

  query({ query = '', category = null, min_confidence = null, limit = 8, include_global = true } = {}) {
    const minConfidence = min_confidence ?? this.ctx.config.memory.default_min_confidence;
    const max = clamp(Number(limit) || 8, 1, 50);
    const q = String(query ?? '').trim();
    const stores = include_global ? this.stores() : this.stores().slice(0, 1);
    const results = [];
    let hidden = 0;
    for (const store of stores) {
      const rows = !q || q === '*' ? this.listRows(store, category, max * 3) : this.ftsRows(store, q, category, max * 3);
      for (const row of rows) {
        if (row.confidence < minConfidence && !row.is_contested) {
          hidden++;
          continue;
        }
        const relevance = q && q !== '*' ? -row.bm : 1;
        const score = relevance * (0.5 + row.confidence) * (store.scope === 'global' ? 0.9 : 1) + (row.is_contested ? 0.5 : 0);
        results.push({ row, store, score });
      }
    }
    results.sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at);
    const top = results.slice(0, max);
    for (const r of top) {
      try {
        r.store.db.run('UPDATE memories SET hit_count = hit_count + 1 WHERE id = ?', r.row.id);
      } catch {
        /* best effort */
      }
    }
    this.ctx.engines.telemetry.record('memory_query', { hit: top.length > 0 });
    return {
      query: q,
      category: category ?? null,
      min_confidence: minConfidence,
      memories: top.map((r) => publicMemory(r.row, r.store.scope)),
      hidden_low_confidence: hidden,
    };
  }

  listRows(store, category, limit) {
    const params = [store.projectId];
    let sql = 'SELECT *, 0.0 AS bm FROM memories WHERE project_id = ?';
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    sql += ' ORDER BY is_contested DESC, confidence DESC, updated_at DESC LIMIT ?';
    params.push(limit);
    return store.db.all(sql, ...params);
  }

  ftsRows(store, q, category, limit) {
    const { terms, compounds } = tokenizeQuery(q);
    const tokens = [...compounds, ...terms];
    const run = (match) => {
      if (!match) return [];
      const params = [match, store.projectId];
      let sql = FTS_SELECT;
      if (category) {
        sql += ' AND m.category = ?';
        params.push(category);
      }
      sql += ' ORDER BY bm LIMIT ?';
      params.push(limit);
      try {
        return store.db.all(sql, ...params);
      } catch (err) {
        log.debug(`memory FTS query failed: ${err.message}`);
        return [];
      }
    };
    let rows = run(ftsQuery(tokens));
    if (!rows.length) rows = run(ftsQuery(tokens, { prefix: true }));
    return rows;
  }

  /** Decay confidence (once) for memories whose scope paths intersect changed files. */
  flagStale(paths) {
    if (!paths?.length) return 0;
    const { db, projectId } = this.ctx;
    const rows = db.all("SELECT * FROM memories WHERE project_id = ? AND scope_paths != '[]' AND needs_verification = 0", projectId);
    if (!rows.length) return 0;
    const decay = this.ctx.config.memory.decay_factor;
    let flagged = 0;
    for (const row of rows) {
      const scopes = safeJsonParse(row.scope_paths, []);
      const hit = paths.find((p) => scopes.some((s) => typeof s === 'string' && scopeMatches(s, p)));
      if (!hit) continue;
      this.updateRow(db, row.id, {
        needs_verification: 1,
        confidence: round(Math.max(0.05, row.confidence * decay), 3),
        updated_at: Date.now(),
      });
      this.logVersion(db, projectId, row.id, 'decay', row, this.row(db, row.id), `scope file changed: ${hit}`);
      flagged++;
    }
    return flagged;
  }

  manage({ action, id = null, version_id = null, confidence = null, reason = null }) {
    const now = Date.now();
    switch (action) {
      case 'get': {
        const found = this.require(id);
        const versions = found.db.all(
          'SELECT id, operation, altered_reason, created_at FROM memory_versions WHERE memory_id = ? ORDER BY id DESC LIMIT 10',
          found.row.id,
        );
        return { action, memory: publicMemory(found.row, found.scope), versions };
      }
      case 'history': {
        const versions = [];
        const prefix = id ? String(id).trim().replace(/[^0-9a-fA-F-]/g, '') : null;
        for (const store of this.stores()) {
          const rows = prefix
            ? store.db.all(
              'SELECT id, memory_id, operation, content_before, content_after, altered_reason, created_at FROM memory_versions WHERE project_id = ? AND memory_id LIKE ? ORDER BY id DESC LIMIT 20',
              store.projectId,
              `${prefix}%`,
            )
            : store.db.all(
              'SELECT id, memory_id, operation, content_before, content_after, altered_reason, created_at FROM memory_versions WHERE project_id = ? ORDER BY id DESC LIMIT 20',
              store.projectId,
            );
          for (const v of rows) versions.push({ ...v, scope: store.scope });
        }
        versions.sort((a, b) => b.created_at - a.created_at);
        return { action, id: prefix, versions: versions.slice(0, 20) };
      }
      case 'verify': {
        const found = this.require(id);
        const before = found.row;
        this.updateRow(found.db, before.id, {
          confidence: clamp(Number(confidence ?? 1), 0, 1),
          needs_verification: 0,
          is_contested: 0,
          contest_note: null,
          last_verified_at: now,
          updated_at: now,
        });
        const after = this.row(found.db, before.id);
        this.logVersion(found.db, found.projectId, before.id, 'verify', before, after, reason ?? 'confirmed by user');
        return { action, memory: publicMemory(after, found.scope) };
      }
      case 'delete': {
        const found = this.require(id);
        found.db.run('DELETE FROM memories WHERE id = ?', found.row.id);
        this.logVersion(found.db, found.projectId, found.row.id, 'delete', found.row, null, reason ?? 'deleted');
        return { action, deleted: publicMemory(found.row, found.scope) };
      }
      case 'rollback':
        return this.rollback(version_id, reason);
      default:
        throw new CortexError('BAD_ACTION', `action must be one of: ${MANAGE_ACTIONS.join(', ')}`);
    }
  }

  /** Restore a memory to the state it had *before* the given version was applied. */
  rollback(versionId, reason) {
    const vid = Number(versionId);
    if (!Number.isInteger(vid) || vid <= 0) throw new CortexError('BAD_VERSION', 'version_id (an integer from action=history) is required.');
    for (const store of this.stores()) {
      const version = store.db.get('SELECT * FROM memory_versions WHERE id = ? AND project_id = ?', vid, store.projectId);
      if (!version) continue;
      const target = safeJsonParse(version.snapshot_before, null);
      const current = this.row(store.db, version.memory_id) ?? null;
      store.db.transaction(() => {
        if (!target) {
          if (current) store.db.run('DELETE FROM memories WHERE id = ?', version.memory_id);
        } else if (current) {
          const fields = {};
          for (const key of MEMORY_FIELDS) if (target[key] !== undefined) fields[key] = target[key];
          this.updateRow(store.db, version.memory_id, fields);
        } else {
          this.insertRow(store.db, { ...target, id: version.memory_id, project_id: store.projectId });
        }
        const after = this.row(store.db, version.memory_id) ?? null;
        this.logVersion(store.db, store.projectId, version.memory_id, 'rollback', current, after, reason ?? `rollback to state before version ${vid}`);
      });
      const restored = this.row(store.db, version.memory_id);
      return {
        action: 'rollback',
        version_id: vid,
        memory_id: version.memory_id,
        result: restored ? 'restored' : 'removed',
        memory: restored ? publicMemory(restored, store.scope) : null,
      };
    }
    throw new CortexError('NOT_FOUND', `No memory version ${vid}.`);
  }

  exportAll({ min_confidence = 0.7 } = {}) {
    const rows = this.ctx.db.all(
      'SELECT * FROM memories WHERE project_id = ? AND is_contested = 0 AND confidence >= ? ORDER BY category, title',
      this.ctx.projectId,
      min_confidence,
    );
    return rows.map((r) => ({
      category: r.category,
      title: r.title,
      content: r.content,
      confidence: r.confidence,
      source_type: r.source_type,
      tags: r.tags ? r.tags.split(' ').filter(Boolean) : [],
      scope_paths: safeJsonParse(r.scope_paths, []),
      invalidation_rule: r.invalidation_rule ?? undefined,
    }));
  }

  importAll(records, { scope = 'project' } = {}) {
    const counts = { created: 0, updated: 0, unchanged: 0, contested: 0, failed: 0 };
    for (const rec of records ?? []) {
      try {
        const res = this.save({
          title: rec.title,
          content: rec.content,
          category: rec.category,
          confidence: rec.confidence,
          source_type: rec.source_type ?? 'user_instruction',
          tags: Array.isArray(rec.tags) ? rec.tags : [],
          scope_paths: Array.isArray(rec.scope_paths) ? rec.scope_paths : [],
          invalidation_rule: rec.invalidation_rule,
          scope,
          reason: 'import',
        });
        counts[res.status] = (counts[res.status] ?? 0) + 1;
      } catch (err) {
        counts.failed++;
        log.warn(`memory import skipped "${rec?.title ?? '?'}": ${err.message}`);
      }
    }
    return counts;
  }
}
