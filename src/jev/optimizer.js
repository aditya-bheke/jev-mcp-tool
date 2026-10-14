import { NEGATED_ERROR } from '../engines/patterns.js';
import { formatDuration, oneLine } from '../core/util.js';

// Context optimizer: the Noul question used to triage tool output, the compact state excerpt the
// model sees, deterministic core-signal extraction and the context receipt that replaces evicted output.

export const TRIAGE_QUESTION =
  'Must the coding agent read this tool output verbatim to decide its next step (failures, errors, assertion diffs, stack traces, compiler diagnostics, or a specific result it asked for)?';

export const TRIAGE_CRITERIA = {
  true: 'The output contains failure signals, errors, diagnostics, or specific results needed for the next step.',
  false: 'The output is routine: progress logs, downloads, passing tests, build success, or repetitive noise that a one-line summary covers.',
};

const SIGNAL_RE = /(?:error|failure|exception|fatal|undefined|rejected)/i;

/** First failure-marker line (ignoring "0 errors"-style negations), else the last non-empty line. */
export function extractCoreSignal(lines) {
  for (const line of lines) {
    const t = line.trim();
    if (t && SIGNAL_RE.test(t) && !NEGATED_ERROR.test(t)) return oneLine(t, 240);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return oneLine(t, 240);
  }
  return '(empty output)';
}

/** Compact state for the model: command metadata + first and last `excerptChars` characters. */
export function buildTriageState(text, { command = null, exitCode = null, lineCount = 0, excerptChars = 1000 } = {}) {
  const body = text.length <= excerptChars * 2
    ? text
    : `${text.slice(0, excerptChars)}\n...\n${text.slice(text.length - excerptChars)}`;
  return [
    command ? `Command: ${oneLine(command, 200)}` : null,
    exitCode != null ? `Exit code: ${exitCode}` : null,
    `Output: ${lineCount} lines, ${text.length} characters`,
    '---',
    body,
  ].filter((line) => line != null).join('\n');
}

export function receiptId(hash) {
  return String(hash).slice(0, 16);
}

/** The string injected in place of an evicted payload. */
export function buildReceipt({ hash, lineCount, bytes, pKeep, signal, command = null, exitCode = null, durationMs = null, extras = [] }) {
  const id = receiptId(hash);
  return [
    `[JEV CONTEXT RECEIPT #evict_${id}]`,
    `Original tool output: ${lineCount.toLocaleString('en-US')} lines (${bytes.toLocaleString('en-US')} bytes) evicted to conserve context.`,
    command ? `Command: \`${oneLine(command, 100)}\` · exit ${exitCode ?? '?'}${durationMs != null ? ` · ${formatDuration(durationMs)}` : ''}` : null,
    `Retention Probability P(keep): ${(pKeep * 100).toFixed(1)}%`,
    `Core Signal: ${signal}`,
    ...extras,
    `Full content preserved. To restore verbatim: call cortex_fetch_evicted(hash="${id}")`,
  ].filter((line) => line != null).join('\n');
}
