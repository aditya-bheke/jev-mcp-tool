import { BARE_FAIL_HEADER, FRAME, isErrorLine, isSummaryLine } from './patterns.js';
import { scrubSecrets } from '../core/secrets.js';
import { safeJsonParse, sha256 } from '../core/util.js';

// Volatile fragments stripped before hashing so the same failure yields the same signature.
const VOLATILE = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>'],
  [/\b0x[0-9a-fA-F]+\b/g, '<addr>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{12,64}\b/g, '<hex>'],
  [/\b(?:thread|Thread|tid|pid|PID|worker)[-_ #:]*\d+\b/g, '<thread>'],
  [/\(\s*\d+(?:\.\d+)?\s*m?s\s*\)/g, '(<dur>)'],
  [/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|min|mins|minutes)\b/g, '<dur>'],
  [/:\d+:\d+\b/g, ':<l>:<c>'],
  [/:\d+\b/g, ':<l>'],
  [/\(\d+,\d+\)/g, '(<l>,<c>)'],
  [/\bline \d+\b/gi, 'line <l>'],
  [/\/(?:private\/)?(?:var|tmp)\/[^\s:'")]+/g, '<tmp>'],
  [/\/(?:Users|home)\/[^/\s]+\//g, '~/'],
];

export function normalizeErrorText(text, root) {
  let s = String(text ?? '');
  if (root) s = s.split(`${root}/`).join('').split(root).join('');
  for (const [re, replacement] of VOLATILE) s = s.replace(re, replacement);
  return s.replace(/[ \t]+/g, ' ').trim();
}

/** Error lines (no stack frames, no summaries) in order of appearance. */
export function extractErrorLines(text, max = 4) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const t = raw.trim();
    if (!t || t.length > 500 || FRAME.test(raw) || isSummaryLine(t)) continue;
    if (isErrorLine(t)) {
      out.push(t);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * Deterministic error signature: hash of the first meaningful error line with volatile data
 * (timestamps, addresses, line numbers, temp paths) removed.
 * @param {{fallback?: boolean}} opts fallback=true uses the first non-empty lines when no error line is found.
 */
export function errorSignature(text, root, { fallback = false } = {}) {
  let lines = extractErrorLines(text, 6);
  if (!lines.length && fallback) {
    lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  }
  if (!lines.length) return null;
  const primary = lines.find((l) => !BARE_FAIL_HEADER.test(l)) ?? lines[0];
  const normalized = normalizeErrorText(primary, root);
  if (!normalized) return null;
  return {
    signature: sha256(normalized).slice(0, 16),
    sample: scrubSecrets(lines.slice(0, 3).join('\n')).text.slice(0, 600),
    normalized,
  };
}

/** Subsystem G: error signatures, occurrence counts and the verified fixes that resolved them. */
export class ErrorIntel {
  constructor(ctx) {
    this.ctx = ctx;
  }

  recordOccurrence(sig) {
    const now = Date.now();
    this.ctx.db.run(
      `INSERT INTO error_signatures (project_id, signature, sample, occurrences, fix_files, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 1, '[]', ?, ?)
       ON CONFLICT(project_id, signature) DO UPDATE SET occurrences = occurrences + 1, last_seen_at = excluded.last_seen_at`,
      this.ctx.projectId,
      sig.signature,
      sig.sample,
      now,
      now,
    );
  }

  ensure(sig) {
    const now = Date.now();
    this.ctx.db.run(
      `INSERT OR IGNORE INTO error_signatures (project_id, signature, sample, occurrences, fix_files, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 1, '[]', ?, ?)`,
      this.ctx.projectId,
      sig.signature,
      sig.sample,
      now,
      now,
    );
  }

  recordFix(sig, { fix_summary, fix_files = [], fix_diff = null, investigation_id = null }) {
    const now = Date.now();
    this.ctx.db.run(
      `INSERT INTO error_signatures (project_id, signature, sample, occurrences, fix_summary, fix_files, fix_diff,
         investigation_id, first_seen_at, last_seen_at, resolved_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, signature) DO UPDATE SET fix_summary = excluded.fix_summary, fix_files = excluded.fix_files,
         fix_diff = excluded.fix_diff, investigation_id = excluded.investigation_id, resolved_at = excluded.resolved_at,
         last_seen_at = excluded.last_seen_at`,
      this.ctx.projectId,
      sig.signature,
      sig.sample,
      fix_summary,
      JSON.stringify(fix_files),
      fix_diff,
      investigation_id,
      now,
      now,
      now,
    );
  }

  /** Known fix for a signature, or null. */
  lookup(signature) {
    if (!signature) return null;
    const row = this.ctx.db.get(
      'SELECT * FROM error_signatures WHERE project_id = ? AND signature = ? AND fix_summary IS NOT NULL',
      this.ctx.projectId,
      signature,
    );
    if (!row) return null;
    return {
      signature: row.signature,
      sample: row.sample,
      occurrences: row.occurrences,
      fix_summary: row.fix_summary,
      fix_files: safeJsonParse(row.fix_files, []),
      fix_diff: row.fix_diff,
      investigation_id: row.investigation_id,
      resolved_at: row.resolved_at,
      last_seen_at: row.last_seen_at,
    };
  }
}
