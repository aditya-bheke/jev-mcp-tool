import { errorSignature, normalizeErrorText } from './errorIntel.js';
import { writeSpool } from './evicted.js';
import { analyzeOutput, buildStub, classifyCommand, knownFixLine, repeatLine } from './pruner.js';
import { buildReceipt, buildTriageState, extractCoreSignal } from '../jev/optimizer.js';
import { log } from '../core/logger.js';
import { estimateTokens, sha256 } from '../core/util.js';

const REPEAT_WINDOW_MS = 6 * 3600 * 1000;

function splitLines(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function signatureSample(text) {
  if (text.length <= 2_000_000) return text;
  return `${text.slice(0, 1_000_000)}\n${text.slice(-1_000_000)}`;
}

function findRepeat(ctx, command, outputSignature) {
  if (!command) return null;
  return (
    ctx.db.get(
      `SELECT created_at, evicted_hash FROM command_runs
       WHERE project_id = ? AND command = ? AND output_signature = ? AND exit_code IS NOT NULL AND exit_code != 0 AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      ctx.projectId,
      command,
      outputSignature,
      Date.now() - REPEAT_WINDOW_MS,
    ) ?? null
  );
}

/**
 * Context optimization for one command output.
 *
 *   size gate (< jev.min_chars)            → intact
 *   Jev Noul P(keep) >= jev.keep_threshold → intact, or condensed when larger than jev.keep_max_chars
 *   Jev Noul P(keep) <  jev.keep_threshold → evicted, replaced by a JEV CONTEXT RECEIPT
 *   Jev unavailable                         → deterministic: intact when small, else condensed stub
 *
 * Condensed and evicted payloads are stored verbatim (DB, or a spool file when the DB is not
 * writable) and restorable with cortex_fetch_evicted.
 *
 * @param {object} p
 * @param {object|null} p.ctx       full context (DB available) or null
 * @param {object|null} p.fallback  { root, dataDir, projectId, config } when ctx is null
 * @param {(state: string) => Promise<{probability: number, latency_ms?: number, via?: string}|null>} [p.decide]
 */
export async function processOutput({
  ctx = null, fallback = null, text, command = null, exitCode = null, durationMs = null, toolName = 'cortex run', truncatedBytes = 0, maxLines = null, decide = null,
}) {
  const env = ctx ?? fallback;
  const { config } = env;
  const root = env.root ?? null;
  const p = config.pruning;
  const j = config.jev;
  const lines = splitLines(text);
  const failed = exitCode != null ? exitCode !== 0 : null;
  const sig = failed === false ? null : errorSignature(text, root);
  const outputSignature = sha256(normalizeErrorText(signatureSample(text), root)).slice(0, 24);

  let known = null;
  let repeat = null;
  if (ctx) {
    try {
      if (sig) known = ctx.engines.errors.lookup(sig.signature);
    } catch (err) {
      log.debug(`known-fix lookup failed: ${err.message}`);
    }
    try {
      if (failed) repeat = findRepeat(ctx, command, outputSignature);
    } catch (err) {
      log.debug(`repeat lookup failed: ${err.message}`);
    }
  }
  const extras = [];
  if (known) extras.push(knownFixLine(known));
  if (repeat) extras.push(repeatLine(repeat));
  if (truncatedBytes) extras.push(`capture truncated: ${truncatedBytes.toLocaleString('en-US')} bytes dropped from the middle`);

  // 1. Decide.
  let pKeep = null;
  let jevLatency = null;
  let decidedBy = 'heuristic';
  let mode;
  if (text.length < j.min_chars) {
    mode = 'intact';
  } else {
    if (decide && j.enabled) {
      try {
        const verdict = await decide(buildTriageState(text, { command, exitCode, lineCount: lines.length, excerptChars: j.excerpt_chars }));
        if (verdict && Number.isFinite(verdict.probability)) {
          pKeep = verdict.probability;
          jevLatency = verdict.latency_ms ?? null;
          decidedBy = `jev:${verdict.via ?? 'local'}`;
        }
      } catch (err) {
        log.debug(`Jev triage unavailable: ${err.message}`);
      }
    }
    if (pKeep == null) mode = lines.length <= p.inline_max_lines && text.length <= p.inline_max_chars ? 'intact' : 'condensed';
    else if (pKeep >= j.keep_threshold) mode = text.length <= j.keep_max_chars ? 'intact' : 'condensed';
    else mode = 'evicted';
  }

  // 2. Render.
  let output = null;
  let hash = null;
  let signal = null;
  if (mode === 'evicted') {
    hash = sha256(text);
    signal = extractCoreSignal(lines);
    output = buildReceipt({ hash, lineCount: lines.length, bytes: Buffer.byteLength(text, 'utf8'), pKeep, signal, command, exitCode, durationMs, extras });
    if (output.length >= text.length * 0.7) {
      mode = 'intact'; // the receipt would not save anything
      hash = null;
    }
  } else if (mode === 'condensed') {
    hash = sha256(text);
    const analysis = analyzeOutput(lines, { command, root });
    signal = analysis.signalText ?? analysis.summary ?? null;
    output = buildStub({
      analysis,
      hash,
      command,
      exitCode,
      durationMs,
      known,
      repeat,
      maxLines: Number(maxLines) > 0 ? Number(maxLines) : p.stub_max_lines,
      lineMax: p.line_max_chars,
      lineCount: lines.length,
      charCount: text.length,
      truncatedBytes,
      pKeep,
    });
  }
  if (mode === 'intact') {
    output = String(text).replace(/\n+$/, '');
    const notes = extras.filter((e) => !e.startsWith('capture truncated'));
    if (notes.length) output += `${output ? '\n' : ''}${notes.map((e) => `[cortex] ${e}`).join('\n')}`;
  }

  // 3. Persist the full payload.
  if (hash) {
    const record = {
      hash,
      tool_name: toolName,
      command,
      exit_code: exitCode,
      original_size: text.length,
      line_count: lines.length,
      stub: output,
      signal,
      error_signature: sig?.signature ?? null,
      p_keep: pKeep,
      raw_content: text,
    };
    let stored = false;
    if (ctx) {
      try {
        ctx.engines.evicted.store(record);
        stored = true;
      } catch (err) {
        log.warn(`could not store evicted payload in the database: ${err.message}`);
      }
    }
    if (!stored && !writeSpool({ root, dataDir: env.dataDir ?? null, projectId: env.projectId ?? 'global' }, record)) {
      output += '\n[cortex] warning: the full output could not be saved (no writable storage); rerun with `cortex run --raw` if you need it';
    }
  }

  // 4. Bookkeeping.
  if (ctx) {
    try {
      ctx.db.run(
        `INSERT INTO command_runs (project_id, command, exit_code, duration_ms, output_signature, output_hash, error_signature,
          evicted_hash, line_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.projectId,
        command ?? '(stdin)',
        exitCode,
        durationMs == null ? null : Math.round(durationMs),
        outputSignature,
        hash ?? sha256(text),
        sig?.signature ?? null,
        hash,
        lines.length,
        Date.now(),
      );
    } catch (err) {
      log.debug(`command run log failed: ${err.message}`);
    }
    if (sig && failed !== false) {
      try {
        ctx.engines.errors.recordOccurrence(sig);
      } catch (err) {
        log.debug(`error signature log failed: ${err.message}`);
      }
    }
    if (pKeep != null) {
      ctx.engines.telemetry.record('jev_triage', { latency_ms: jevLatency, meta: { p_keep: pKeep, mode, via: decidedBy } });
    }
    if (hash) {
      ctx.engines.telemetry.record('eviction', {
        input_chars: text.length,
        output_chars: output.length,
        tokens_saved: Math.max(0, estimateTokens(text.length) - estimateTokens(output.length)),
        meta: { command, lines: lines.length, exit_code: exitCode, mode, p_keep: pKeep, decided_by: decidedBy },
      });
    }
    if (failed && command && config.checkpoint.auto_on_test_failure && classifyCommand(command) === 'test output') {
      try {
        ctx.engines.checkpoints.autoSnapshot({ command, errorText: sig?.sample ?? lines.slice(-15).join('\n') });
      } catch (err) {
        log.debug(`auto checkpoint failed: ${err.message}`);
      }
    }
  }
  return { output, mode, hash, failed, p_keep: pKeep, decided_by: decidedBy };
}
