import { errorSignature, normalizeErrorText } from './errorIntel.js';
import { writeSpool } from './evicted.js';
import { analyzeOutput, buildStub, classifyCommand, knownFixLine, repeatLine } from './pruner.js';
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

function lastLines(text, n) {
  return splitLines(text).slice(-n).join('\n');
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
 * Jev-style non-destructive pruning of a command's output.
 * Small outputs pass through untouched; large ones are stored verbatim (DB, or a spool file when
 * the DB is not writable) and replaced by a compact stub with the core signal and a restore hash.
 *
 * @param {object} p
 * @param {object|null} p.ctx      full context (DB available) or null
 * @param {object|null} p.fallback { root, dataDir, projectId, config } when ctx is null
 */
export function processOutput({
  ctx = null, fallback = null, text, command = null, exitCode = null, durationMs = null, toolName = 'cortex run', truncatedBytes = 0, maxLines = null,
}) {
  const env = ctx ?? fallback;
  const config = env.config;
  const root = env.root ?? null;
  const p = config.pruning;
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

  const small = lines.length <= p.inline_max_lines && text.length <= p.inline_max_chars;
  let output;
  let hash = null;
  let evicted = false;
  if (small) {
    const extras = [];
    if (known) extras.push(knownFixLine(known));
    if (repeat) extras.push(repeatLine(repeat));
    output = String(text).replace(/\n+$/, '');
    if (extras.length) output += `${output ? '\n' : ''}${extras.map((e) => `[cortex] ${e}`).join('\n')}`;
  } else {
    const analysis = analyzeOutput(lines, { command, root });
    hash = sha256(text);
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
    });
    evicted = true;
    const record = {
      hash,
      tool_name: toolName,
      command,
      exit_code: exitCode,
      original_size: text.length,
      line_count: lines.length,
      stub: output,
      signal: analysis.signalText ?? analysis.summary ?? null,
      error_signature: sig?.signature ?? null,
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
    if (!stored) {
      const dir = writeSpool({ root, dataDir: env.dataDir ?? null, projectId: env.projectId ?? 'global' }, record);
      if (!dir) output += '\n[cortex] warning: the full output could not be saved (no writable storage); rerun with `cortex run --raw` if you need it';
    }
  }

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
    if (evicted) {
      ctx.engines.telemetry.record('eviction', {
        input_chars: text.length,
        output_chars: output.length,
        tokens_saved: Math.max(0, estimateTokens(text.length) - estimateTokens(output.length)),
        meta: { command, lines: lines.length, exit_code: exitCode },
      });
    }
    if (failed && command && config.checkpoint.auto_on_test_failure && classifyCommand(command) === 'test output') {
      try {
        ctx.engines.checkpoints.autoSnapshot({ command, errorText: sig?.sample ?? lastLines(text, 15) });
      } catch (err) {
        log.debug(`auto checkpoint failed: ${err.message}`);
      }
    }
  }
  return { output, evicted, hash, failed };
}
