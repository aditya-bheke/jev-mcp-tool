import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { normalizeOutput } from '../core/util.js';

// `cortex run -- <cmd>` is the interception point for context optimization. Codex executes it with
// its own shell tool, so Codex's sandbox and approval policy still apply to the wrapped command; the
// MCP server never executes arbitrary commands itself.

/** Bounded capture: keeps the head and a rolling tail when output exceeds maxBytes. */
class OutputCapture {
  constructor(maxBytes) {
    this.max = Math.max(1024 * 1024, maxBytes);
    this.headMax = Math.floor(this.max / 4);
    this.head = [];
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.droppedBytes = 0;
  }

  push(chunk) {
    let data = chunk;
    if (this.headBytes < this.headMax) {
      const room = this.headMax - this.headBytes;
      if (data.length <= room) {
        this.head.push(data);
        this.headBytes += data.length;
        return;
      }
      this.head.push(data.subarray(0, room));
      this.headBytes += room;
      data = data.subarray(room);
    }
    this.tail.push(data);
    this.tailBytes += data.length;
    const tailMax = this.max - this.headMax;
    while (this.tailBytes > tailMax && this.tail.length > 1) {
      const dropped = this.tail.shift();
      this.tailBytes -= dropped.length;
      this.droppedBytes += dropped.length;
    }
    if (this.tailBytes > tailMax && this.tail.length === 1) {
      const only = this.tail[0];
      const cut = only.length - tailMax;
      this.tail[0] = only.subarray(cut);
      this.tailBytes = this.tail[0].length;
      this.droppedBytes += cut;
    }
  }

  toString() {
    if (!this.droppedBytes) return Buffer.concat([...this.head, ...this.tail]).toString('utf8');
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    return `${head}\n[cortex: ${this.droppedBytes} bytes omitted from the middle of the output]\n${tail}`;
  }
}

function writeOut(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Context with DB if possible; otherwise a fallback env so output can still be pruned + spooled. */
async function loadEnvironment() {
  try {
    const { createContext } = await import('../core/context.js');
    return { ctx: createContext({ mode: 'cli', logLevel: 'error' }), fallback: null };
  } catch {
    // Database unavailable (read-only sandbox, native module mismatch, ...). Prune anyway.
  }
  const { configureLogger } = await import('../core/logger.js');
  configureLogger({ level: 'error' });
  const { findProjectRoot, projectIdFor, resolvePaths } = await import('../core/paths.js');
  const { loadConfig } = await import('../core/config.js');
  let root = null;
  try {
    root = findProjectRoot(process.cwd());
  } catch {
    root = null;
  }
  const { dataDir } = resolvePaths(root);
  let config;
  try {
    config = loadConfig(root ? dataDir : null);
  } catch {
    config = loadConfig(null);
  }
  return { ctx: null, fallback: { root, dataDir, projectId: projectIdFor(root), config } };
}

/**
 * Jev triage for a CLI process: ask the MCP server's already-loaded model over the local socket;
 * otherwise (no server, sandboxed socket) load the model in-process when allowed. Null = deterministic.
 */
async function createDecider(jevConfig) {
  if (!jevConfig.enabled) return null;
  const { keepProbability, triageRequest } = await import('../jev/optimizer.js');
  return async (state) => {
    const params = triageRequest(state, jevConfig.triage_temperature);
    try {
      const { requestEvaluation } = await import('../jev/ipc.js');
      const result = await requestEvaluation(params, { timeoutMs: jevConfig.timeout_ms });
      return { probability: keepProbability(result), latency_ms: result.latency_ms, via: 'server' };
    } catch {
      // no reachable server: fall through
    }
    if (!jevConfig.cli_inprocess) return null;
    const { JevEngine } = await import('../jev/engine.js');
    const engine = new JevEngine(jevConfig);
    try {
      const result = await engine.evaluate(params);
      return { probability: keepProbability(result), latency_ms: result.latency_ms, via: 'local' };
    } catch {
      return null;
    } finally {
      await engine.dispose();
    }
  };
}

async function pruneAndPrint({ text, command, exitCode, durationMs, truncatedBytes, maxLines, toolName }) {
  let env = null;
  try {
    env = await loadEnvironment();
    const config = env.ctx?.config ?? env.fallback.config;
    const { processOutput } = await import('../engines/output.js');
    const decide = await createDecider(config.jev);
    const res = await processOutput({ ...env, text, command, exitCode, durationMs, toolName, truncatedBytes, maxLines, decide });
    writeOut(res.output);
  } catch (err) {
    // Never lose the command's output because of a cortex problem: fall back to passthrough.
    writeOut(`${text.replace(/\n+$/, '')}\n[cortex] pruning unavailable: ${err?.message ?? err}`);
  } finally {
    try {
      env?.ctx?.close();
    } catch {
      /* ignore */
    }
  }
}

export async function cmdRun(argv) {
  const sep = argv.indexOf('--');
  const optionArgs = sep === -1 ? [] : argv.slice(0, sep);
  const commandArgs = sep === -1 ? argv : argv.slice(sep + 1);
  const { values } = parseArgs({
    args: optionArgs,
    strict: true,
    options: {
      label: { type: 'string' },
      'max-lines': { type: 'string' },
      timeout: { type: 'string' },
      raw: { type: 'boolean' },
    },
  });
  if (!commandArgs.length) {
    process.stderr.write('usage: cortex run [--label <s>] [--max-lines <n>] [--timeout <sec>] [--raw] -- <command...>\n');
    return 2;
  }

  const useShell = commandArgs.length === 1 && /[\s|&;<>()$`*?~'"]/.test(commandArgs[0]);
  const display = values.label ?? commandArgs.join(' ');
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  const startedAt = Date.now();

  if (values.raw) {
    const child = useShell
      ? spawn(commandArgs[0], { shell: true, stdio: 'inherit' })
      : spawn(commandArgs[0], commandArgs.slice(1), { shell: process.platform === 'win32', stdio: 'inherit' });
    return new Promise((resolve) => {
      child.on('error', (err) => {
        process.stderr.write(`cortex run: failed to start "${display}": ${err.message}\n`);
        resolve(127);
      });
      child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1)));
    });
  }

  const { loadConfig } = await import('../core/config.js');
  const maxCapture = loadConfig(null).pruning.max_capture_bytes;
  const capture = new OutputCapture(maxCapture);
  const child = useShell
    ? spawn(commandArgs[0], { shell: true, env, stdio: ['inherit', 'pipe', 'pipe'] })
    : spawn(commandArgs[0], commandArgs.slice(1), { shell: process.platform === 'win32', env, stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => capture.push(d));
  child.stderr?.on('data', (d) => capture.push(d));

  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  let timedOut = false;
  const timeoutSec = Number(values.timeout);
  const timer = Number.isFinite(timeoutSec) && timeoutSec > 0
    ? setTimeout(() => {
      timedOut = true;
      forward('SIGTERM');
      setTimeout(() => forward('SIGKILL'), 3000).unref();
    }, timeoutSec * 1000)
    : null;

  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on('error', (err) => done({ code: null, signal: null, error: err }));
    child.on('close', (code, signal) => done({ code, signal, error: null }));
  });
  if (timer) clearTimeout(timer);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);

  if (result.error) {
    process.stderr.write(`cortex run: failed to start "${display}": ${result.error.message}\n`);
    return 127;
  }
  const exitCode = result.code ?? (result.signal ? 128 + (os.constants.signals[result.signal] ?? 1) : 1);
  let text = normalizeOutput(capture.toString());
  if (timedOut) text += `\n[cortex] command timed out after ${timeoutSec}s and was terminated`;

  await pruneAndPrint({
    text,
    command: display,
    exitCode,
    durationMs: Date.now() - startedAt,
    truncatedBytes: capture.droppedBytes,
    maxLines: values['max-lines'] ? Number(values['max-lines']) : null,
    toolName: 'cortex run',
  });
  return exitCode;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function cmdCompress(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      label: { type: 'string' },
      'exit-code': { type: 'string' },
      'max-lines': { type: 'string' },
    },
  });
  if (process.stdin.isTTY) {
    process.stderr.write('usage: <command> 2>&1 | cortex compress [--label <s>] [--exit-code <n>]\n');
    return 2;
  }
  const text = normalizeOutput(await readStdin());
  const exitCode = values['exit-code'] != null && values['exit-code'] !== '' && Number.isFinite(Number(values['exit-code']))
    ? Number(values['exit-code'])
    : null;
  await pruneAndPrint({
    text,
    command: values.label ?? null,
    exitCode,
    durationMs: null,
    truncatedBytes: 0,
    maxLines: values['max-lines'] ? Number(values['max-lines']) : null,
    toolName: 'cortex compress',
  });
  return 0;
}
