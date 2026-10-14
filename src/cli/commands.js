import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createContext } from '../core/context.js';
import { tokenizeQuery } from '../core/tokenize.js';
import { clamp, median, oneLine, round } from '../core/util.js';
import * as R from '../tools/render.js';

function write(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function emit(json, data, text) {
  write(json ? JSON.stringify(data, null, 2) : text);
}

function num(value, fallback = undefined) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function withContext(fn) {
  const ctx = createContext({ mode: 'cli', logLevel: 'warn' });
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

export async function cmdServe(argv) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' } }, strict: true });
  const { startServer } = await import('../server.js');
  await startServer({ root: values.root ?? null });
  return undefined; // keep running: stdin keeps the process alive
}

async function cmdIndex(argv) {
  const { values } = parseArgs({ args: argv, options: { full: { type: 'boolean' }, json: { type: 'boolean' } }, strict: true });
  return withContext(async (ctx) => {
    const stats = await ctx.engines.indexer.sync({ force: !!values.full, reason: 'cli' });
    emit(values.json, stats, R.renderIndexSync(stats));
    return 0;
  });
}

async function cmdSearch(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { path: { type: 'string' }, symbols: { type: 'boolean' }, limit: { type: 'string', short: 'n' }, json: { type: 'boolean' } },
  });
  const query = positionals.join(' ').trim();
  if (!query) throw new Error('usage: cortex search <query> [--path <p>] [--symbols] [-n <k>]');
  return withContext(async (ctx) => {
    const data = await ctx.engines.search.search({ query, path_filter: values.path ?? null, symbol_only: !!values.symbols, max_results: num(values.limit, null) });
    emit(values.json, data, R.renderSearch(data));
    return data.results.length ? 0 : 1;
  });
}

async function cmdFetch(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { query: { type: 'string', short: 'q' }, start: { type: 'string' }, end: { type: 'string' }, context: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (!positionals[0]) throw new Error('usage: cortex fetch <hash> [--query <q>] [--start <n>] [--end <n>]');
  return withContext(async (ctx) => {
    const data = ctx.engines.evicted.fetch({
      hash: positionals[0],
      query: values.query ?? null,
      start_line: num(values.start, null),
      end_line: num(values.end, null),
      context_lines: num(values.context, 2),
    });
    emit(values.json, data, R.renderFetch(data));
    return 0;
  });
}

async function cmdMemory(argv) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      category: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
      confidence: { type: 'string' },
      source: { type: 'string' },
      global: { type: 'boolean' },
      scope: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      supersedes: { type: 'string' },
      reason: { type: 'string' },
      'min-confidence': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  return withContext(async (ctx) => {
    const memory = ctx.engines.memory;
    switch (sub ?? 'list') {
      case 'list': {
        const data = memory.query({ query: '', category: values.category ?? null, min_confidence: num(values['min-confidence'], 0), limit: 50 });
        emit(values.json, data, R.renderMemoryQuery(data));
        return 0;
      }
      case 'search': {
        const data = memory.query({ query: positionals.join(' '), category: values.category ?? null, min_confidence: num(values['min-confidence'], null), limit: 20 });
        emit(values.json, data, R.renderMemoryQuery(data));
        return 0;
      }
      case 'add': {
        if (!values.title || !values.content || !values.category) throw new Error('memory add requires --title, --content and --category');
        const data = memory.save({
          title: values.title,
          content: values.content,
          category: values.category,
          confidence: num(values.confidence),
          source_type: values.source ?? 'user_instruction',
          scope: values.global ? 'global' : 'project',
          scope_paths: values.scope ?? [],
          tags: values.tag ?? [],
          supersedes: values.supersedes,
          reason: values.reason,
        });
        emit(values.json, data, R.renderMemorySave(data));
        return 0;
      }
      case 'verify':
      case 'delete':
      case 'history':
      case 'get': {
        const data = memory.manage({ action: sub, id: positionals[0] ?? null, confidence: num(values.confidence, null), reason: values.reason ?? null });
        emit(values.json, data, R.renderMemoryManage(data));
        return 0;
      }
      case 'rollback': {
        const data = memory.manage({ action: 'rollback', version_id: num(positionals[0], null), reason: values.reason ?? null });
        emit(values.json, data, R.renderMemoryManage(data));
        return 0;
      }
      case 'export': {
        const records = memory.exportAll({ min_confidence: num(values['min-confidence'], 0.7) });
        const json = JSON.stringify({ version: 1, exported_at: new Date().toISOString(), project: ctx.projectName, memories: records }, null, 2);
        if (positionals[0]) {
          fs.writeFileSync(positionals[0], `${json}\n`);
          write(`exported ${records.length} memories → ${positionals[0]}`);
        } else {
          write(json);
        }
        return 0;
      }
      case 'import': {
        if (!positionals[0]) throw new Error('usage: cortex memory import <file> [--global]');
        const parsed = JSON.parse(fs.readFileSync(positionals[0], 'utf8'));
        const records = Array.isArray(parsed) ? parsed : parsed.memories ?? [];
        const counts = memory.importAll(records, { scope: values.global ? 'global' : 'project' });
        emit(values.json, counts, `imported ${records.length} record(s): ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        return counts.failed ? 1 : 0;
      }
      default:
        throw new Error(`unknown memory subcommand "${sub}" (list, search, add, get, verify, delete, history, rollback, export, import)`);
    }
  });
}

async function cmdCheckpoint(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { list: { type: 'boolean' }, id: { type: 'string' }, json: { type: 'boolean' } } });
  return withContext(async (ctx) => {
    const data = ctx.engines.checkpoints.resume({ checkpoint_id: values.id ?? null, list: !!values.list });
    emit(values.json, data, R.renderCheckpointResume(data));
    return 0;
  });
}

async function cmdRoute(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { json: { type: 'boolean' } } });
  const task = positionals.join(' ').trim();
  if (!task) throw new Error('usage: cortex route "<task description>"');
  return withContext(async (ctx) => {
    const data = await ctx.engines.router.route({ task });
    emit(values.json, data, R.renderRoute(data));
    return 0;
  });
}

async function cmdStats(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { days: { type: 'string' }, json: { type: 'boolean' } } });
  return withContext(async (ctx) => {
    const data = ctx.engines.telemetry.summary({ days: clamp(num(values.days, 7), 1, 3650) });
    emit(values.json, data, R.renderStats(data));
    return 0;
  });
}

function ripgrepCount(root, terms) {
  const args = ['--count-matches', '--ignore-case', '--no-messages', ...terms.flatMap((t) => ['-e', t]), '--', '.'];
  const t0 = performance.now();
  const r = spawnSync('rg', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const elapsed = performance.now() - t0;
  if (r.error) return null;
  let matches = 0;
  let files = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /:(\d+)$/.exec(line);
    if (m) {
      matches += Number(m[1]);
      files++;
    }
  }
  return { ms: elapsed, matches, files };
}

async function cmdBench(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { runs: { type: 'string' }, json: { type: 'boolean' } } });
  if (!positionals.length) throw new Error('usage: cortex bench "<query>" ["<query>" ...] [--runs <n>]');
  const runs = clamp(num(values.runs, 3), 1, 20);
  return withContext(async (ctx) => {
    if (!ctx.root) throw new Error('bench needs a project root');
    await ctx.engines.indexer.sync({ reason: 'bench' });
    const rows = [];
    for (const query of positionals) {
      const indexTimes = [];
      let results = 0;
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const res = await ctx.engines.search.search({ query, max_results: 5 });
        indexTimes.push(performance.now() - t0);
        results = res.results.length;
      }
      const { terms } = tokenizeQuery(query);
      const rgTimes = [];
      let rg = null;
      for (let i = 0; i < runs && terms.length; i++) {
        rg = ripgrepCount(ctx.root, terms);
        if (!rg) break;
        rgTimes.push(rg.ms);
      }
      const row = {
        query,
        index_ms: round(median(indexTimes), 1),
        index_results: results,
        rg_ms: rgTimes.length ? round(median(rgTimes), 1) : null,
        rg_matching_lines: rg ? rg.matches : null,
        rg_files: rg ? rg.files : null,
      };
      rows.push(row);
      ctx.engines.telemetry.record('bench', { latency_ms: row.index_ms, meta: row });
    }
    const text = [
      `Benchmark (${runs} run(s), median): indexed top-5 snippets vs a ripgrep scan of the same terms`,
      ...rows.map((r) => `- "${oneLine(r.query, 50)}": index ${r.index_ms}ms (${r.index_results} results) · ripgrep ${r.rg_ms == null ? 'n/a' : `${r.rg_ms}ms`}${r.rg_matching_lines != null ? ` (${r.rg_matching_lines} matching lines in ${r.rg_files} files the agent would have to sift)` : ''}`),
    ].join('\n');
    emit(values.json, rows, text);
    return 0;
  });
}

async function cmdConfig(argv) {
  // Always JSON; --json is accepted for symmetry with the other commands.
  parseArgs({ args: argv, strict: true, options: { json: { type: 'boolean' } } });
  return withContext(async (ctx) => {
    write(JSON.stringify({ root: ctx.root, project_id: ctx.projectId, data_dir: ctx.dataDir, db_path: ctx.dbPath, config: ctx.config }, null, 2));
    return 0;
  });
}

export const COMMANDS = {
  index: cmdIndex,
  search: cmdSearch,
  fetch: cmdFetch,
  memory: cmdMemory,
  checkpoint: cmdCheckpoint,
  route: cmdRoute,
  stats: cmdStats,
  bench: cmdBench,
  config: cmdConfig,
};
