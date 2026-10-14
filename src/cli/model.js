import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../core/config.js';
import { configureLogger } from '../core/logger.js';
import { findProjectRoot, resolvePaths } from '../core/paths.js';
import { clamp, percentile, round } from '../core/util.js';
import { downloadModel } from '../jev/download.js';
import { JevEngine } from '../jev/engine.js';
import { buildTriageState, keepProbability, triageRequest } from '../jev/optimizer.js';

function jevConfig() {
  const root = findProjectRoot(process.cwd());
  return loadConfig(root ? resolvePaths(root).dataDir : null).jev;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function pull(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { force: { type: 'boolean' }, url: { type: 'string' } } });
  const cfg = jevConfig();
  const url = values.url ?? cfg.model_url;
  process.stderr.write(`downloading ${url}\n        → ${cfg.model_path}\n`);
  let lastShown = -1;
  const res = await downloadModel({
    url,
    dest: cfg.model_path,
    force: !!values.force,
    onProgress: (received, total) => {
      const step = total ? Math.floor((received / total) * 100) : Math.floor(received / (25 * 1024 * 1024));
      if (step === lastShown) return;
      lastShown = step;
      const text = total ? `${step}% (${mb(received)} of ${mb(total)})` : mb(received);
      if (process.stderr.isTTY) process.stderr.write(`\r  ${text}   `);
      else if (!total || step % 10 === 0) process.stderr.write(`  ${text}\n`);
    },
  });
  if (process.stderr.isTTY && !res.skipped) process.stderr.write('\n');
  process.stdout.write(res.skipped ? `model already present: ${res.dest} (${mb(res.bytes)}); use --force to re-download\n` : `model ready: ${res.dest} (${mb(res.bytes)})\n`);
  return 0;
}

async function status() {
  const cfg = jevConfig();
  const exists = fs.existsSync(cfg.model_path);
  const lines = [
    `model: ${cfg.model_path} ${exists ? `(${mb(fs.statSync(cfg.model_path).size)})` : '(missing; run `cortex model pull`)'}`,
    `enabled: ${cfg.enabled} · gpu: ${cfg.gpu} · context ${cfg.context_size} · batch ${cfg.batch_size} · keep threshold ${cfg.keep_threshold}`,
  ];
  if (!exists || !cfg.enabled) {
    process.stdout.write(`${lines.join('\n')}\n`);
    return exists ? 0 : 1;
  }
  const engine = new JevEngine(cfg);
  try {
    await engine.load();
    const s = engine.status();
    lines.push(`loaded on ${s.gpu} in ${s.load_ms}ms`);
    const trace = 'java.lang.AssertionError: expected:<1> but was:<0>\n\tat com.example.OrderServiceTest.testProcess(OrderServiceTest.java:94)\n[INFO] BUILD FAILURE';
    const probe = await engine.evaluate(triageRequest(buildTriageState(trace, { command: 'mvn test', exitCode: 1, lineCount: 3 }), cfg.triage_temperature));
    lines.push(`probe (failing assertion): P(keep) = ${(keepProbability(probe) * 100).toFixed(1)}% in ${probe.latency_ms}ms (${probe.prompt_tokens} tokens)`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    lines.push(`load/evaluate failed: ${err.message}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 1;
  } finally {
    await engine.dispose();
  }
}

/** Spec §8.1: warm forward-pass latency and RSS stability over N consecutive passes. */
async function bench(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { runs: { type: 'string' } } });
  const runs = clamp(Number(values.runs ?? 100) || 100, 1, 10_000);
  const cfg = jevConfig();
  const engine = new JevEngine(cfg);
  const state = [
    'Command: mvn -q package',
    'Exit code: 0',
    '---',
    ...Array.from({ length: 24 }, (_, i) => `[INFO] Downloading from central: https://repo.maven.apache.org/maven2/org/example/lib-${i}/1.${i}.0/lib-${i}-1.${i}.0.jar`),
    '[INFO] BUILD SUCCESS',
    '[INFO] Total time:  4.211 s',
  ].join('\n');
  const params = triageRequest(state, cfg.triage_temperature);
  try {
    const rssStart = process.memoryUsage().rss;
    await engine.load();
    for (let i = 0; i < 3; i++) await engine.evaluate(params); // warm-up
    const rssWarm = process.memoryUsage().rss;
    let rssPeak = rssWarm;
    const forward = [];
    const wall = [];
    let probability = null;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const res = await engine.evaluate(params);
      wall.push(performance.now() - t0);
      forward.push(res.latency_ms);
      probability = keepProbability(res);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }
    const rssEnd = process.memoryUsage().rss;
    const s = engine.status();
    const stat = (v) => `p50 ${round(percentile(v, 50), 1)}ms · p95 ${round(percentile(v, 95), 1)}ms · max ${round(Math.max(...v), 1)}ms`;
    process.stdout.write([
      `Jev bench: ${runs} warm passes · ${s.gpu} · load ${s.load_ms}ms · P(keep) on a routine build log = ${(probability * 100).toFixed(1)}%`,
      `forward pass   ${stat(forward)}   (target 30-55 ms)`,
      `end-to-end     ${stat(wall)}`,
      `RSS            start ${mb(rssStart)} · after warm-up ${mb(rssWarm)} · peak ${mb(rssPeak)} · end ${mb(rssEnd)} (target < 600 MB, flat across passes)`,
    ].join('\n') + '\n');
    return 0;
  } finally {
    await engine.dispose();
  }
}

export async function cmdModel(argv) {
  configureLogger({ level: 'warn' });
  const [sub, ...rest] = argv;
  switch (sub ?? 'status') {
    case 'pull':
      return pull(rest);
    case 'status':
      return status();
    case 'bench':
      return bench(rest);
    default:
      throw new Error(`unknown model subcommand "${sub}" (pull, status, bench)`);
  }
}
