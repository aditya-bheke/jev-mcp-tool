import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../core/logger.js';
import { ensureDir } from '../core/paths.js';
import { scrubSecrets } from '../core/secrets.js';
import { CortexError, clamp } from '../core/util.js';

const FULL_FETCH_MAX_CHARS = 2_000_000;
const QUERY_FETCH_MAX_LINES = 400;

// Payloads are restored verbatim, so only high-precision credential formats (keys, tokens, JWTs,
// PEM blocks) are redacted; ordinary log lines stay byte-identical.
const scrubPayload = (text) => scrubSecrets(text, { strict: true }).text;

/**
 * Spool directories used when the database is not writable (e.g. `cortex run` inside a
 * read-only sandbox). The MCP server imports spooled payloads on startup and on fetch.
 */
export function spoolDirs({ root = null, dataDir = null, projectId = 'global' } = {}) {
  const dirs = [];
  if (dataDir) dirs.push(path.join(dataDir, 'spool'));
  if (root) dirs.push(path.join(root, '.cortex-spool'));
  dirs.push(path.join(os.tmpdir(), 'cortex-local-spool', projectId || 'global'));
  return dirs;
}

export function writeSpool(location, record) {
  const payload = JSON.stringify({ v: 1, ...record, raw_content: scrubPayload(record.raw_content), created_at: Date.now() });
  for (const dir of spoolDirs(location)) {
    try {
      ensureDir(dir);
      fs.writeFileSync(path.join(dir, `${record.hash}.json`), payload);
      return dir;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Subsystem B recovery store: verbatim payloads addressed by SHA-256 (credentials redacted). */
export class EvictionStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.insertsSincePrune = 0;
  }

  store(rec) {
    const { db, projectId } = this.ctx;
    const now = Date.now();
    const existing = db.get('SELECT hash FROM evicted_payloads WHERE hash = ?', rec.hash);
    if (existing) {
      db.run(
        `UPDATE evicted_payloads SET seen_count = seen_count + 1, last_seen_at = ?, stub = ?, command = COALESCE(?, command),
          exit_code = ?, p_keep = COALESCE(?, p_keep) WHERE hash = ?`,
        now,
        rec.stub ?? null,
        rec.command ?? null,
        rec.exit_code ?? null,
        rec.p_keep ?? null,
        rec.hash,
      );
      return { hash: rec.hash, existed: true };
    }
    db.run(
      `INSERT INTO evicted_payloads (hash, project_id, tool_name, command, exit_code, original_size, line_count, stub, signal,
        error_signature, p_keep, raw_content, seen_count, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      rec.hash,
      projectId,
      rec.tool_name ?? 'cortex run',
      rec.command ?? null,
      rec.exit_code ?? null,
      rec.original_size ?? rec.raw_content.length,
      rec.line_count ?? rec.raw_content.split('\n').length,
      rec.stub ?? null,
      rec.signal ?? null,
      rec.error_signature ?? null,
      rec.p_keep ?? null,
      scrubPayload(rec.raw_content),
      rec.created_at ?? now,
      now,
    );
    this.insertsSincePrune++;
    if (this.insertsSincePrune >= 25) {
      this.insertsSincePrune = 0;
      this.prune();
    }
    return { hash: rec.hash, existed: false };
  }

  importSpool() {
    let imported = 0;
    for (const dir of spoolDirs(this.ctx)) {
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
        try {
          const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (rec && typeof rec.hash === 'string' && typeof rec.raw_content === 'string') {
            this.store(rec);
            imported++;
          }
          fs.unlinkSync(full);
        } catch (err) {
          log.debug(`spool import skipped ${full}: ${err.message}`);
        }
      }
    }
    if (imported) log.info(`imported ${imported} spooled payload(s)`);
    return imported;
  }

  resolve(hashOrPrefix) {
    const clean = String(hashOrPrefix ?? '').trim().replace(/^#/, '').replace(/^evict_/i, '').toLowerCase();
    if (clean.length < 6 || !/^[0-9a-f]+$/.test(clean)) {
      throw new CortexError('BAD_HASH', 'Pass the hash from the eviction stub (at least 6 hex characters).');
    }
    const find = () => this.ctx.db.all('SELECT * FROM evicted_payloads WHERE hash LIKE ? LIMIT 2', `${clean}%`);
    let rows = find();
    if (!rows.length && this.importSpool()) rows = find();
    if (rows.length > 1) throw new CortexError('AMBIGUOUS_HASH', `Hash prefix ${clean} is ambiguous; pass more characters.`);
    if (!rows.length) {
      throw new CortexError('NOT_FOUND', `No evicted payload #${clean}. It may have expired (retention ${this.ctx.config.retention.evicted_days} days).`);
    }
    return rows[0];
  }

  /** Progressive disclosure: grep with context, a line range, or the full payload (paged). */
  fetch({ hash, query = null, start_line = null, end_line = null, context_lines = 2 } = {}) {
    const row = this.resolve(hash);
    const lines = row.raw_content.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // trailing newline is not a line
    const total = lines.length;
    let mode;
    let content;
    let note;
    if (query) {
      mode = 'query';
      let matcher = null;
      const rx = /^\/(.+)\/([imsu]*)$/.exec(query);
      if (rx) {
        try {
          const re = new RegExp(rx[1], rx[2]);
          matcher = (l) => re.test(l);
        } catch {
          matcher = null;
        }
      }
      if (!matcher) {
        const q = query.toLowerCase();
        matcher = (l) => l.toLowerCase().includes(q);
      }
      const hits = [];
      for (let i = 0; i < total; i++) if (matcher(lines[i])) hits.push(i);
      const hitSet = new Set(hits);
      const ctxLines = clamp(Number(context_lines ?? 2), 0, 20);
      const ranges = [];
      for (const i of hits) {
        const a = Math.max(0, i - ctxLines);
        const b = Math.min(total - 1, i + ctxLines);
        const last = ranges[ranges.length - 1];
        if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
        else ranges.push([a, b]);
      }
      const out = [];
      let truncated = false;
      for (const [a, b] of ranges) {
        if (out.length >= QUERY_FETCH_MAX_LINES) {
          truncated = true;
          break;
        }
        if (out.length) out.push('…');
        for (let i = a; i <= b; i++) {
          if (out.length >= QUERY_FETCH_MAX_LINES) {
            truncated = true;
            break;
          }
          out.push(`L${i + 1}${hitSet.has(i) ? '>' : ':'} ${lines[i]}`);
        }
      }
      content = out.join('\n');
      note = hits.length ? `${hits.length} matching line(s) for "${query}"` : `no lines match "${query}"`;
      if (truncated) note += ' (truncated; narrow the query)';
    } else if (start_line != null || end_line != null) {
      mode = 'range';
      const a = clamp(Number(start_line ?? 1) || 1, 1, total);
      const b = clamp(Number(end_line ?? a + 199) || a + 199, a, Math.min(total, a + 999));
      content = lines.slice(a - 1, b).map((l, idx) => `L${a + idx}: ${l}`).join('\n');
      note = `lines ${a}-${b} of ${total}${b < total ? ` · continue with start_line=${b + 1}` : ''}`;
    } else {
      mode = 'full';
      if (row.raw_content.length <= FULL_FETCH_MAX_CHARS) {
        content = row.raw_content;
        note = `${total} lines, verbatim`;
      } else {
        let chars = 0;
        let count = 0;
        while (count < total && chars + lines[count].length + 1 <= FULL_FETCH_MAX_CHARS) chars += lines[count++].length + 1;
        content = lines.slice(0, count).join('\n');
        note = `first ${count} of ${total} lines (payload over ${FULL_FETCH_MAX_CHARS.toLocaleString('en-US')} chars) · continue with start_line=${count + 1}`;
      }
    }
    this.ctx.engines.telemetry.record('evicted_fetch', { output_chars: content.length, meta: { mode } });
    return {
      hash: row.hash,
      command: row.command,
      exit_code: row.exit_code,
      p_keep: row.p_keep ?? null,
      created_at: row.created_at,
      total_lines: total,
      mode,
      note,
      content,
    };
  }

  recent({ since = 0, limit = 3 } = {}) {
    return this.ctx.db.all(
      `SELECT hash, command, exit_code, line_count, signal, p_keep, last_seen_at FROM evicted_payloads
       WHERE project_id = ? AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT ?`,
      this.ctx.projectId,
      since,
      limit,
    );
  }

  prune() {
    const { db, projectId, config } = this.ctx;
    const cutoff = Date.now() - config.retention.evicted_days * 86_400_000;
    db.run('DELETE FROM evicted_payloads WHERE project_id = ? AND last_seen_at < ?', projectId, cutoff);
    db.run('DELETE FROM command_runs WHERE project_id = ? AND created_at < ?', projectId, cutoff);
    const maxBytes = config.retention.evicted_max_mb * 1024 * 1024;
    const total = db.get('SELECT COALESCE(SUM(original_size), 0) AS s FROM evicted_payloads WHERE project_id = ?', projectId).s;
    if (total > maxBytes) {
      const rows = db.all('SELECT hash, original_size FROM evicted_payloads WHERE project_id = ? ORDER BY last_seen_at ASC', projectId);
      let excess = total - maxBytes;
      db.transaction(() => {
        for (const r of rows) {
          if (excess <= 0) break;
          db.run('DELETE FROM evicted_payloads WHERE hash = ?', r.hash);
          excess -= r.original_size;
        }
      });
    }
  }
}
