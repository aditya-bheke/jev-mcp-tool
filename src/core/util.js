import crypto from 'node:crypto';

/** Error with a stable machine-readable code; surfaced to the agent as `CODE: message`. */
export class CortexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CortexError';
    this.code = code;
  }
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function uuid() {
  return crypto.randomUUID();
}

/** Rough token estimate (~4 chars per token) used for savings accounting. */
export function estimateTokens(value) {
  const n = typeof value === 'number' ? value : String(value ?? '').length;
  return Math.ceil(Math.max(0, n) / 4);
}

export function truncate(value, max) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function oneLine(value, max = 200) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function safeJsonParse(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function relTime(ms, ref = Date.now()) {
  if (!ms) return 'never';
  const diff = Math.max(0, ref - ms);
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function isoTime(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function formatCount(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return Math.round(v).toLocaleString('en-US');
}

// Matches ANSI escape sequences (colors, cursor movement, OSC hyperlinks).
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

/** Strip ANSI codes and collapse carriage-return progress redraws to their final state. */
export function normalizeOutput(text) {
  const clean = stripAnsi(text).replace(/\r\n/g, '\n');
  if (!clean.includes('\r')) return clean;
  return clean
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r').filter((p) => p.length > 0);
      return parts.length ? parts[parts.length - 1] : '';
    })
    .join('\n');
}

export function toPosix(p) {
  return String(p).split('\\').join('/');
}

export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CortexError('TIMEOUT', `${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout]);
}

export function shortId(id) {
  return id ? String(id).slice(0, 8) : '';
}

export function shortHash(hash) {
  return hash ? String(hash).slice(0, 12) : '';
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function median(values) {
  return percentile(values, 50);
}

export function uniq(values) {
  return [...new Set(values)];
}

/** Run fn and return fallback on any exception (used for best-effort enrichment). */
export function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
