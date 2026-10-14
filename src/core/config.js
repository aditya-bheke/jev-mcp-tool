import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

/** Jev decision model (Qwen2.5-0.5B-Instruct, 8-bit GGUF, ~530 MB), shared by every repository. */
export const DEFAULT_MODEL_FILE = 'qwen2.5-0.5b-instruct-q8_0.gguf';
export const DEFAULT_MODEL_URL = 'https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q8_0.gguf';
export const MODELS_DIR = fileURLToPath(new URL('../../models/', import.meta.url));

/** Paths never worth indexing: dependencies, build output, caches, lockfiles and binaries. */
export const DEFAULT_EXCLUDES = [
  '.git', '.hg', '.svn', '.codex', '.cortex-spool', '.agents',
  'node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn', '.npm',
  'dist', 'build', 'out', 'target', 'obj', 'bin/Debug', 'bin/Release',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', '.vercel', '.output', '.expo',
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.venv', 'venv', '.eggs', '*.egg-info', '.gradle', '.idea', 'Pods', 'DerivedData', '.dart_tool',
  '.terraform', 'vendor/bundle', '.bundle', '.DS_Store',
  '*.min.js', '*.min.css', '*.map', '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'bun.lockb',
  'flake.lock', 'npm-shrinkwrap.json',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.ico', '*.icns', '*.bmp', '*.tif', '*.tiff', '*.psd',
  '*.svg', '*.pdf', '*.zip', '*.gz', '*.tgz', '*.bz2', '*.xz', '*.7z', '*.rar', '*.jar', '*.war', '*.ear',
  '*.class', '*.o', '*.a', '*.so', '*.dylib', '*.dll', '*.exe', '*.bin', '*.wasm', '*.pyc', '*.pyo',
  '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot', '*.mp3', '*.mp4', '*.mov', '*.avi', '*.wav', '*.flac',
  '*.ogg', '*.webm', '*.sqlite', '*.sqlite3', '*.db', '*.db-wal', '*.db-shm', '*.parquet', '*.npy',
  '*.npz', '*.pkl', '*.pt', '*.onnx', '*.h5', '*.ckpt', '*.safetensors', '*.gguf', '*.dmg', '*.iso',
];

export const DEFAULT_CONFIG = {
  index: {
    exclude: [],
    replace_default_excludes: false,
    respect_gitignore: true,
    max_file_bytes: 1_000_000,
    batch_size: 150,
    auto_sync_interval_sec: 60,
    index_on_startup: true,
    max_chunk_lines: 120,
    small_container_lines: 60,
    window_lines: 80,
  },
  search: {
    default_max_results: 5,
    snippet_lines: 24,
    candidate_pool: 60,
    rg_fallback: true,
    // Rerank the top BM25 hits with the Jev Score primitive (MCP server only; ~50 ms per candidate).
    jev_rerank: { enabled: false, top_k: 6, weight: 0.4 },
  },
  pruning: {
    inline_max_lines: 40,
    inline_max_chars: 6000,
    stub_max_lines: 14,
    line_max_chars: 220,
    max_capture_bytes: 20_000_000,
  },
  memory: {
    default_min_confidence: 0.7,
    agent_confidence_cap: 0.8,
    decay_factor: 0.85,
    contest_similarity: 0.45,
  },
  checkpoint: {
    auto_on_test_failure: true,
  },
  retention: {
    evicted_days: 14,
    evicted_max_mb: 256,
    telemetry_days: 90,
    checkpoints_keep: 200,
  },
  jev: {
    enabled: true,
    model_path: null, // default: <cortex-local>/models/<DEFAULT_MODEL_FILE>; $CORTEX_JEV_MODEL overrides
    model_url: DEFAULT_MODEL_URL,
    gpu: 'auto', // 'auto' | 'metal' | 'cuda' | 'vulkan' | false
    context_size: 4096,
    batch_size: 2048,
    temperature: 1.0, // calibration temperature T_cal of the candidate softmax
    triage_temperature: 0.6, // T_cal used for output triage (calibrated on real build/test logs)
    keep_threshold: 0.7, // P(keep) >= threshold → output stays in context
    min_chars: 300, // size gate: smaller outputs are never triaged
    excerpt_chars: 1000, // head/tail characters shown to the model
    keep_max_chars: 20000, // high-signal output larger than this is condensed instead of kept verbatim
    preload: true, // load the model when the MCP server starts
    host: true, // serve evaluations to `cortex run` over a local socket
    cli_inprocess: true, // `cortex run` loads the model itself when no server is reachable
    timeout_ms: 30000, // per evaluation; generous for CPU-only machines (Metal passes take tens of ms)
    load_timeout_ms: 60000,
  },
  output_format: 'text',
  log_level: 'info',
  log_to_file: false,
};

/** What `cortex init` writes to .codex/config.json (only the knobs people actually tune). */
export const USER_CONFIG_TEMPLATE = {
  index: { exclude: [], max_file_bytes: 1_000_000, auto_sync_interval_sec: 60 },
  search: { default_max_results: 5, snippet_lines: 24 },
  pruning: { inline_max_lines: 40, stub_max_lines: 14 },
  memory: { default_min_confidence: 0.7 },
  jev: { enabled: true, keep_threshold: 0.7, min_chars: 300, keep_max_chars: 20000 },
  output_format: 'text',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) target[key] = deepMerge(target[key], value);
    else if (value !== undefined) target[key] = value;
  }
  return target;
}

/** A user config can replace a section with a scalar (e.g. "jev": null); put the default object back. */
function restoreShape(target, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!isPlainObject(value)) continue;
    if (!isPlainObject(target[key])) target[key] = structuredClone(value);
    else restoreShape(target[key], value);
  }
}

function clampKey(obj, key, lo, hi, fallback) {
  const v = Number(obj[key]);
  obj[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function validate(cfg) {
  const d = DEFAULT_CONFIG;
  clampKey(cfg.index, 'max_file_bytes', 1_000, 50_000_000, d.index.max_file_bytes);
  clampKey(cfg.index, 'batch_size', 10, 5_000, d.index.batch_size);
  clampKey(cfg.index, 'auto_sync_interval_sec', 0, 86_400, d.index.auto_sync_interval_sec);
  clampKey(cfg.index, 'max_chunk_lines', 20, 2_000, d.index.max_chunk_lines);
  clampKey(cfg.index, 'small_container_lines', 5, 2_000, d.index.small_container_lines);
  clampKey(cfg.index, 'window_lines', 10, 2_000, d.index.window_lines);
  clampKey(cfg.search, 'default_max_results', 1, 20, d.search.default_max_results);
  clampKey(cfg.search, 'snippet_lines', 4, 200, d.search.snippet_lines);
  clampKey(cfg.search, 'candidate_pool', 10, 500, d.search.candidate_pool);
  clampKey(cfg.pruning, 'inline_max_lines', 0, 10_000, d.pruning.inline_max_lines);
  clampKey(cfg.pruning, 'inline_max_chars', 0, 1_000_000, d.pruning.inline_max_chars);
  clampKey(cfg.pruning, 'stub_max_lines', 6, 200, d.pruning.stub_max_lines);
  clampKey(cfg.pruning, 'line_max_chars', 60, 2_000, d.pruning.line_max_chars);
  clampKey(cfg.pruning, 'max_capture_bytes', 1_048_576, 500_000_000, d.pruning.max_capture_bytes);
  clampKey(cfg.memory, 'default_min_confidence', 0, 1, d.memory.default_min_confidence);
  clampKey(cfg.memory, 'agent_confidence_cap', 0, 1, d.memory.agent_confidence_cap);
  clampKey(cfg.memory, 'decay_factor', 0.1, 1, d.memory.decay_factor);
  clampKey(cfg.memory, 'contest_similarity', 0.05, 1, d.memory.contest_similarity);
  clampKey(cfg.retention, 'evicted_days', 1, 3_650, d.retention.evicted_days);
  clampKey(cfg.retention, 'evicted_max_mb', 1, 100_000, d.retention.evicted_max_mb);
  clampKey(cfg.retention, 'telemetry_days', 1, 3_650, d.retention.telemetry_days);
  clampKey(cfg.retention, 'checkpoints_keep', 5, 100_000, d.retention.checkpoints_keep);
  clampKey(cfg.search.jev_rerank, 'top_k', 2, 20, d.search.jev_rerank.top_k);
  clampKey(cfg.search.jev_rerank, 'weight', 0, 1, d.search.jev_rerank.weight);
  if (!['text', 'json'].includes(cfg.output_format)) cfg.output_format = 'text';
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(cfg.log_level)) cfg.log_level = 'info';
  if (!Array.isArray(cfg.index.exclude)) cfg.index.exclude = [];

  const j = cfg.jev;
  clampKey(j, 'context_size', 512, 32768, d.jev.context_size);
  clampKey(j, 'batch_size', 32, 8192, d.jev.batch_size);
  j.context_size = Math.round(j.context_size);
  j.batch_size = Math.min(Math.round(j.batch_size), j.context_size);
  clampKey(j, 'temperature', 0.05, 10, d.jev.temperature);
  clampKey(j, 'triage_temperature', 0.05, 10, d.jev.triage_temperature);
  clampKey(j, 'keep_threshold', 0, 1, d.jev.keep_threshold);
  clampKey(j, 'min_chars', 0, 10_000_000, d.jev.min_chars);
  clampKey(j, 'excerpt_chars', 100, 20_000, d.jev.excerpt_chars);
  clampKey(j, 'keep_max_chars', 0, 10_000_000, d.jev.keep_max_chars);
  clampKey(j, 'timeout_ms', 500, 600_000, d.jev.timeout_ms);
  clampKey(j, 'load_timeout_ms', 1000, 600_000, d.jev.load_timeout_ms);
  if (!['auto', 'metal', 'cuda', 'vulkan', false].includes(j.gpu)) j.gpu = d.jev.gpu;
  for (const key of ['enabled', 'preload', 'host', 'cli_inprocess']) j[key] = j[key] !== false;
  cfg.search.jev_rerank.enabled = cfg.search.jev_rerank.enabled === true;
  return cfg;
}

function resolveModelPath(configured, baseDir) {
  const raw = process.env.CORTEX_JEV_MODEL || configured;
  if (!raw) return path.join(MODELS_DIR, DEFAULT_MODEL_FILE);
  const expanded = String(raw).startsWith('~/') ? path.join(os.homedir(), String(raw).slice(2)) : String(raw);
  return path.resolve(baseDir, expanded);
}

/** Load defaults merged with `<dataDir>/config.json` (if present). */
export function loadConfig(dataDir) {
  const config = structuredClone(DEFAULT_CONFIG);
  let user = {};
  const file = dataDir ? path.join(dataDir, 'config.json') : null;
  if (file && fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log.warn(`ignoring invalid config ${file}: ${err.message}`);
      user = {};
    }
  }
  deepMerge(config, user);
  restoreShape(config, DEFAULT_CONFIG);
  config.jev.model_path = resolveModelPath(config.jev.model_path, file ? path.dirname(file) : process.cwd());
  const userExcludes = Array.isArray(user?.index?.exclude) ? user.index.exclude.filter((p) => typeof p === 'string') : [];
  config.index.exclude = config.index.replace_default_excludes ? userExcludes : [...DEFAULT_EXCLUDES, ...userExcludes];
  return validate(config);
}
