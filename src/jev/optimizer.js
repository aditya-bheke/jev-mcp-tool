import { NEGATED_ERROR, isSummaryLine } from '../engines/patterns.js';
import { formatDuration, oneLine } from '../core/util.js';

// Context optimizer: the triage request used to classify tool output, the compact state excerpt the
// model sees, deterministic core-signal extraction and the context receipt that replaces evicted output.

// Triage is a two-option Choice (a binary softmax over the letter tokens A/B) rather than a true/false
// Noul: measured on Qwen2.5-0.5B over 16 real build/test/lint/install outputs, true/false answers
// track "does this look fine?" whatever the question says (5/10 correct), while this framing,
// with "failure" listed first, separated keep from evict cases 15/16 at T=1 and 16/16 at T=0.6.
export const TRIAGE_QUESTION = 'What kind of command output is this?';
export const TRIAGE_CRITERIA = {
  failure: 'errors, failed tests, exceptions, or a failed build',
  success: 'routine output; everything succeeded',
};

/** Evaluation request whose `failure` probability is P(keep). */
export function triageRequest(state, temperature) {
  return { primitive: 'choice', state, question: TRIAGE_QUESTION, criteria: TRIAGE_CRITERIA, temperature };
}

export function keepProbability(result) {
  return result.distribution.failure;
}

const SIGNAL_RE = /(?:error|failure|exception|fatal|undefined|rejected)/i;

/**
 * Deterministic core signal: the first failure-marker line (ignoring "0 errors"-style negations);
 * otherwise the last summary line near the end ("BUILD SUCCESS", "45 passed"); otherwise the last
 * non-empty line.
 */
export function extractCoreSignal(lines) {
  for (const line of lines) {
    const t = line.trim();
    if (t && SIGNAL_RE.test(t) && !NEGATED_ERROR.test(t)) return oneLine(t, 240);
  }
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
    const t = lines[i].trim();
    if (t && isSummaryLine(t)) return oneLine(t, 240);
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
