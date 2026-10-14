import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createSensitiveMatcher } from './files.js';
import { log } from '../core/logger.js';
import { scrubSecrets } from '../core/secrets.js';
import { ftsQuery, lightStem, pathTerms, splitIdentifier, tokenizeQuery } from '../core/tokenize.js';
import { CortexError, clamp, estimateTokens, round, truncate } from '../core/util.js';

/** Declaration-level chunk types (used by symbol_only). */
export const SYMBOL_TYPES = ['class', 'interface', 'enum', 'type', 'struct', 'module', 'function', 'method', 'impl', 'macro', 'test', 'route', 'resource'];
const SYMBOL_SET = new Set(SYMBOL_TYPES);

const RELEVANCE_LEVELS = {
  1: 'unrelated to the query',
  2: 'only shares a few terms with the query',
  3: 'related code, but not what the query asks for',
  4: 'relevant implementation or usage',
  5: 'exactly what the query asks for',
};

function normalizePathFilter(raw) {
  const p = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  if (!p) return null;
  if (/[*?[]/.test(p)) {
    // SQLite GLOB: '*' already crosses '/', so collapse '**' forms.
    const glob = p.replace(/\/\*\*\//g, '/*').replace(/^\*\*\//, '*').replace(/\*\*/g, '*');
    return { raw: p, glob };
  }
  return { raw: p, substring: p };
}

function diversify(rows, k) {
  const out = [];
  const perFile = new Map();
  const deferred = [];
  for (const r of rows) {
    if (out.length >= k) break;
    if (out.some((o) => o.file_path === r.file_path && o.start_line <= r.end_line && r.start_line <= o.end_line)) continue;
    const n = perFile.get(r.file_path) ?? 0;
    if (n >= 2) {
      deferred.push(r);
      continue;
    }
    perFile.set(r.file_path, n + 1);
    out.push(r);
  }
  for (const r of deferred) {
    if (out.length >= k) break;
    out.push(r);
  }
  return out;
}

function findDeclLine(lines, name) {
  if (!name) return 0;
  const simple = String(name).split(/[.> ]/).pop();
  const idx = lines.findIndex((l) => l.includes(simple));
  return idx === -1 ? 0 : idx;
}

/** Pick the densest window of query-term matches; always keep the declaration line for orientation. */
function buildSnippet(row, terms, maxLines) {
  const lines = row.content.split('\n');
  const width = String(row.end_line).length;
  const fmt = (offset) => `${String(row.start_line + offset).padStart(width)}| ${truncate(lines[offset], 240)}`;
  if (lines.length <= maxLines) {
    return { start: row.start_line, count: lines.length, text: lines.map((_, i) => fmt(i)).join('\n') };
  }
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const scores = lines.map((l) => {
    const lower = l.toLowerCase();
    let s = 0;
    for (const t of lowerTerms) if (lower.includes(t)) s++;
    return s;
  });
  let bestStart = 0;
  let bestSum = -1;
  let sum = 0;
  for (let i = 0; i < lines.length; i++) {
    sum += scores[i];
    if (i >= maxLines) sum -= scores[i - maxLines];
    if (i >= maxLines - 1 && sum > bestSum) {
      bestSum = sum;
      bestStart = i - maxLines + 1;
    }
  }
  const out = [];
  if (bestStart > 0) {
    const decl = findDeclLine(lines, row.symbol_name);
    if (decl < bestStart) {
      out.push(fmt(decl));
      if (decl + 1 < bestStart) out.push(`${' '.repeat(width)}| …`);
    }
  }
  const end = Math.min(lines.length, bestStart + Math.max(4, maxLines - out.length));
  for (let i = bestStart; i < end; i++) out.push(fmt(i));
  if (end < lines.length) out.push(`${' '.repeat(width)}| … (+${lines.length - end} lines to ${row.end_line})`);
  return { start: row.start_line + bestStart, count: out.length, text: out.join('\n') };
}

/**
 * Subsystem C query side: FTS5/BM25 candidates → identifier-aware rerank →
 * Jev Score rerank (optional) → diversified top-k with line-numbered snippets → ripgrep fallback.
 */
export class SearchEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.sensitive = null;
  }

  async search({ query, symbol_only = false, path_filter = null, max_results = null, snippets = true } = {}) {
    const { ctx } = this;
    if (!ctx.root) {
      throw new CortexError('NO_PROJECT', 'Code search needs a project root. Start Codex inside a repository or set CORTEX_PROJECT_ROOT.');
    }
    const t0 = performance.now();
    const cfg = ctx.config.search;
    const k = clamp(Number(max_results ?? cfg.default_max_results) || cfg.default_max_results, 1, 20);
    const freshness = await ctx.engines.indexer.ensureFresh();
    const { terms, compounds } = tokenizeQuery(query);
    const pathFilter = path_filter ? normalizePathFilter(path_filter) : null;
    const tokens = [...compounds, ...terms];
    const opts = { symbolOnly: !!symbol_only, pathFilter, limit: cfg.candidate_pool };

    let strategy = 'bm25';
    let rows = [];
    if (tokens.length) {
      rows = this.candidates(ftsQuery(tokens), opts);
      if (!rows.length) {
        rows = this.candidates(ftsQuery(tokens, { prefix: true }), opts);
        if (rows.length) strategy = 'bm25-prefix';
      }
    }
    let ranked = this.rerank(rows, terms, compounds);
    const jevRerank = cfg.jev_rerank;
    if (ranked.length > 1 && jevRerank.enabled && ctx.jev) {
      const reranked = await this.jevRerank(query, ranked.slice(0, jevRerank.top_k), jevRerank.weight);
      if (reranked) {
        ranked = [...reranked, ...ranked.slice(jevRerank.top_k)];
        strategy += '+jev';
      }
    }
    let results = diversify(ranked, k).map((row, i) => this.toResult(row, i + 1, terms, snippets));
    if (!results.length && cfg.rg_fallback) {
      results = this.ripgrep(query, pathFilter, k);
      if (results.length) strategy = results[0].via;
    }

    const latency = round(performance.now() - t0, 1);
    const tokensSaved = snippets ? this.estimateSavings(results) : 0;
    ctx.engines.telemetry.record('search', {
      latency_ms: latency,
      hit: results.length > 0,
      tokens_saved: tokensSaved,
      meta: { strategy, results: results.length },
    });
    const index = ctx.engines.indexer.stats();
    return {
      query,
      strategy,
      latency_ms: latency,
      results,
      index: { files: index.files, chunks: index.chunks, last_sync_at: index.last_sync_at, warming: freshness.warming ?? null },
    };
  }

  candidates(match, { symbolOnly, pathFilter, limit }) {
    if (!match) return [];
    const params = [match, this.ctx.projectId];
    let sql = `SELECT c.id, c.file_path, c.language, c.symbol_type, c.symbol_name, c.parent_symbol, c.start_line,
        c.end_line, c.chunk_hash, c.decomposed_tokens, c.content, bm25(code_search_index, 2.0, 10.0, 4.0, 1.0) AS bm
      FROM code_search_index JOIN code_chunks c ON c.id = code_search_index.rowid
      WHERE code_search_index MATCH ? AND c.project_id = ?`;
    if (symbolOnly) {
      sql += ` AND c.symbol_type IN (${SYMBOL_TYPES.map(() => '?').join(', ')})`;
      params.push(...SYMBOL_TYPES);
    }
    if (pathFilter?.glob) {
      sql += ' AND c.file_path GLOB ?';
      params.push(pathFilter.glob);
    } else if (pathFilter?.substring) {
      sql += ' AND instr(c.file_path, ?) > 0';
      params.push(pathFilter.substring);
    }
    sql += ' ORDER BY bm LIMIT ?';
    params.push(limit);
    try {
      return this.ctx.db.all(sql, ...params);
    } catch (err) {
      log.warn(`FTS query failed (${match}): ${err.message}`);
      return [];
    }
  }

  /** Jev Score (1-5 relevance) blended with the lexical score; null when the engine is unavailable. */
  async jevRerank(query, rows, weight) {
    try {
      const maxLexical = Math.max(...rows.map((r) => r.score), 1e-9);
      const scored = [];
      for (const r of rows) {
        const res = await this.ctx.jev.evaluate({
          primitive: 'score',
          state: `File: ${r.file_path}${r.symbol_name ? `\nSymbol: ${r.symbol_type} ${r.symbol_name}` : ''}\n${r.content.slice(0, 1500)}`,
          question: `How relevant is this code to the search query "${query.slice(0, 300)}"?`,
          criteria: RELEVANCE_LEVELS,
        });
        scored.push({ ...r, relevance: res.score, score: round((1 - weight) * (r.score / maxLexical) + weight * ((res.score - 1) / 4), 4) });
      }
      return scored.sort((a, b) => b.score - a.score);
    } catch (err) {
      log.debug(`Jev rerank skipped: ${err.message}`);
      return null;
    }
  }

  /** Blend BM25 with query-term coverage of the symbol name, path and decomposed identifiers. */
  rerank(rows, terms, compounds) {
    if (!rows.length) return [];
    const stems = terms.map(lightStem);
    const best = Math.min(...rows.map((r) => r.bm));
    const scored = rows.map((r) => {
      const symParts = new Set([...splitIdentifier(r.symbol_name ?? ''), ...splitIdentifier(r.parent_symbol ?? '')].map(lightStem));
      const pathParts = new Set(pathTerms(r.file_path).map(lightStem));
      const decomposed = new Set(String(r.decomposed_tokens ?? '').split(' ').filter(Boolean).map(lightStem));
      const lower = r.content.toLowerCase();
      let sym = 0;
      let pth = 0;
      let any = 0;
      stems.forEach((s, idx) => {
        const inSym = symParts.has(s);
        const inPath = pathParts.has(s);
        if (inSym) sym++;
        if (inPath) pth++;
        if (inSym || inPath || decomposed.has(s) || lower.includes(terms[idx])) any++;
      });
      const n = Math.max(1, stems.length);
      const symName = String(r.symbol_name ?? '').toLowerCase();
      const exact = compounds.includes(symName) || (terms.length === 1 && symName === terms[0]);
      const bmNorm = best < 0 ? r.bm / best : 0;
      const score = bmNorm + (any / n) * 1.5 + (sym / n) * 1.2 + (pth / n) * 0.4 + (exact ? 2 : 0) + (SYMBOL_SET.has(r.symbol_type) ? 0.15 : 0);
      return { ...r, score: round(score, 3) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  toResult(row, rank, terms, withSnippet) {
    const result = {
      rank,
      file_path: row.file_path,
      symbol_type: row.symbol_type,
      symbol_name: row.symbol_name,
      parent_symbol: row.parent_symbol,
      start_line: row.start_line,
      end_line: row.end_line,
      score: row.score,
    };
    if (withSnippet) {
      const snippet = buildSnippet(row, terms, this.ctx.config.search.snippet_lines);
      result.snippet_start = snippet.start;
      result.snippet = snippet.text;
    }
    return result;
  }

  /** Tokens a full-file read of each hit would have cost, minus what the snippets cost. */
  estimateSavings(results) {
    const byFile = new Map();
    for (const r of results) byFile.set(r.file_path, (byFile.get(r.file_path) ?? 0) + (r.snippet?.length ?? 0));
    let saved = 0;
    for (const [file, snippetChars] of byFile) {
      const row = this.ctx.db.get('SELECT size FROM indexed_files WHERE project_id = ? AND file_path = ?', this.ctx.projectId, file);
      if (row) saved += Math.max(0, estimateTokens(row.size) - estimateTokens(snippetChars));
    }
    return saved;
  }

  /** Exact-text fallback when the index has no match (stale index, excluded file, odd tokens). */
  ripgrep(query, pathFilter, k) {
    const root = this.ctx.root;
    const pattern = String(query ?? '').trim();
    if (!pattern) return [];
    const args = ['--line-number', '--no-heading', '--color=never', '--fixed-strings', '--smart-case', '--max-count=3', '--max-columns=300', '--max-filesize=1M'];
    if (pathFilter?.glob) args.push('--glob', pathFilter.raw);
    else if (pathFilter?.substring && !fs.existsSync(path.join(root, pathFilter.substring))) args.push('--glob', `*${pathFilter.substring}*`);
    args.push('-e', pattern);
    // Always pass a path: with no path and a piped stdin, rg searches stdin instead of the tree.
    args.push('--', pathFilter?.substring && fs.existsSync(path.join(root, pathFilter.substring)) ? pathFilter.substring : '.');
    let via = 'ripgrep';
    const spawnOpts = { cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    let r = spawnSync('rg', args, spawnOpts);
    if (r.error && r.error.code === 'ENOENT') {
      via = 'git-grep';
      r = spawnSync('git', ['grep', '-n', '-I', '-F', '-e', pattern], spawnOpts);
    }
    if (r.error || (r.status !== 0 && r.status !== 1) || !r.stdout) return [];
    if (!this.sensitive) this.sensitive = createSensitiveMatcher();
    const byFile = new Map();
    for (const line of r.stdout.split('\n')) {
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const file = m[1].replace(/^\.\//, '');
      if (this.sensitive(file)) continue;
      if (!byFile.has(file)) {
        if (byFile.size >= k) continue;
        byFile.set(file, []);
      }
      const hits = byFile.get(file);
      if (hits.length < 3) hits.push({ line: Number(m[2]), text: m[3] });
    }
    return [...byFile.entries()].map(([file, hits], i) => ({
      rank: i + 1,
      file_path: file,
      symbol_type: 'match',
      symbol_name: null,
      parent_symbol: null,
      start_line: hits[0].line,
      end_line: hits[hits.length - 1].line,
      score: null,
      snippet_start: hits[0].line,
      snippet: hits.map((h) => `${h.line}| ${truncate(scrubSecrets(h.text, { strict: true }).text.trim(), 240)}`).join('\n'),
      via,
    }));
  }
}
