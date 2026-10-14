import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './util.js';

const STRONG_MARKERS = ['.git', 'AGENTS.md', '.codex'];
const WEAK_MARKERS = [
  'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'composer.json', 'Gemfile', 'mix.exs', 'Package.swift', 'CMakeLists.txt',
  'Makefile', 'deno.json',
];

export function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function walkUp(start, predicate) {
  let dir = start;
  for (;;) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate the project root for `startDir`.
 * Order: $CORTEX_PROJECT_ROOT, nearest dir with .git/AGENTS.md/.codex, nearest dir with a build manifest.
 * The home directory and filesystem root are never auto-detected (indexing $HOME would be a disaster).
 */
export function findProjectRoot(startDir = process.cwd()) {
  const fromEnv = process.env.CORTEX_PROJECT_ROOT;
  if (fromEnv) return realpath(path.resolve(fromEnv));
  const home = realpath(os.homedir());
  const forbidden = (dir) => {
    const real = realpath(dir);
    return real === home || real === path.parse(real).root;
  };
  const start = path.resolve(startDir);
  const strong = walkUp(start, (dir) => !forbidden(dir) && STRONG_MARKERS.some((m) => fs.existsSync(path.join(dir, m))));
  if (strong) return realpath(strong);
  const weak = walkUp(start, (dir) => !forbidden(dir) && WEAK_MARKERS.some((m) => fs.existsSync(path.join(dir, m))));
  return weak ? realpath(weak) : null;
}

/**
 * mkdir -p, one level at a time. fs.mkdirSync(dir, { recursive: true }) can spin forever on pseudo
 * filesystems (e.g. a data path under /proc); a plain mkdir throws instead, so callers can fall back.
 */
export function ensureDir(dir) {
  const missing = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const d of missing.reverse()) {
    try {
      fs.mkdirSync(d);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

export function codexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

export function globalDbPath() {
  return process.env.CORTEX_GLOBAL_DB
    ? path.resolve(process.env.CORTEX_GLOBAL_DB)
    : path.join(codexHome(), 'global_cortex.db');
}

/** Data dir defaults to `<root>/.codex`; without a project we fall back to the global DB. */
export function resolvePaths(root) {
  const dataDir = process.env.CORTEX_DATA_DIR
    ? path.resolve(process.env.CORTEX_DATA_DIR)
    : root
      ? path.join(root, '.codex')
      : codexHome();
  const dbPath = process.env.CORTEX_DB_PATH
    ? path.resolve(process.env.CORTEX_DB_PATH)
    : root
      ? path.join(dataDir, 'cortex.db')
      : globalDbPath();
  return { dataDir, dbPath };
}

export function projectIdFor(root) {
  return root ? sha256(root).slice(0, 16) : 'global';
}

/** Normalise user/agent supplied paths to unique, root-relative POSIX paths. */
export function normalizeRelPaths(paths, root, limit = 50) {
  const out = [];
  for (const raw of paths ?? []) {
    if (typeof raw !== 'string') continue;
    let p = raw.trim().replace(/\\/g, '/');
    if (!p) continue;
    if (root && path.isAbsolute(p)) {
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) p = rel;
    }
    p = p.replace(/^\.\//, '');
    if (!out.includes(p)) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
