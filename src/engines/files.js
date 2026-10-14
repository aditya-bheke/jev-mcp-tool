import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitListFiles } from '../core/git.js';
import { createMatcher } from '../core/glob.js';
import { toPosix } from '../core/util.js';

// Name fragments that suggest credentials. Applied only to structured data/config extensions so
// that source (src/auth/tokenService.ts) and prose (docs/topics/auth/passwords.txt) stay searchable.
const SENSITIVE_WORDS = ['secret', 'secrets', 'token', 'tokens', 'credential', 'credentials', 'password', 'passwords'];
const DATA_EXTENSIONS = ['json', 'yaml', 'yml', 'env', 'ini', 'conf', 'cfg', 'properties', 'toml', 'xml', 'csv'];

const SENSITIVE_PATTERNS = [
  '.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.p8', '*.der',
  'id_rsa', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '*.kdbx', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials', '.htpasswd', 'credentials', 'credentials.*', '*.tfstate', '*.tfstate.*', '*.tfvars',
  'service-account*.json', 'serviceAccount*.json', 'google-services.json', 'GoogleService-Info.plist',
  'secret.txt', 'secrets.txt', 'token.txt', 'tokens.txt', 'credentials.txt',
  ...SENSITIVE_WORDS.flatMap((word) => DATA_EXTENSIONS.map((ext) => `*${word}*.${ext}`)),
];
const SENSITIVE_ALLOW = /^\.env\.(?:example|sample|template|dist|defaults)$/i;

export function createSensitiveMatcher() {
  const matches = createMatcher(SENSITIVE_PATTERNS, { caseInsensitive: true });
  return (relPath) => {
    const base = relPath.split('/').pop() ?? relPath;
    if (SENSITIVE_ALLOW.test(base)) return false;
    return matches(relPath);
  };
}

function readGitignore(root) {
  try {
    return fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function rgListFiles(root) {
  const r = spawnSync('rg', ['--files', '--hidden', '--no-require-git', '--glob', '!.git'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return r.stdout.split('\n').filter(Boolean);
}

function walkFiles(root, isExcluded, maxFiles = 250_000) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!isExcluded(rel)) stack.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
        if (out.length >= maxFiles) return out;
      }
    }
  }
  return out;
}

/**
 * List indexable files. Prefers `git ls-files` (respects .gitignore), then `rg --files`, then a
 * manual walk honouring the root .gitignore. Config excludes and sensitive files are always removed.
 */
export function discoverFiles(root, config) {
  const isExcluded = createMatcher(config.index.exclude);
  const isSensitive = createSensitiveMatcher();
  let list = null;
  let source = null;
  if (config.index.respect_gitignore !== false) {
    list = gitListFiles(root);
    if (list) source = 'git';
    if (!list) {
      list = rgListFiles(root);
      if (list) source = 'rg';
    }
  }
  if (!list) {
    const walkExcluded = config.index.respect_gitignore !== false
      ? createMatcher([...config.index.exclude, ...readGitignore(root)])
      : isExcluded;
    list = walkFiles(root, walkExcluded);
    source = 'walk';
  }
  const files = [];
  const seen = new Set();
  let excluded = 0;
  let sensitive = 0;
  for (const raw of list) {
    const rel = toPosix(raw).replace(/^\.\//, '');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    if (isExcluded(rel)) {
      excluded++;
      continue;
    }
    if (isSensitive(rel)) {
      sensitive++;
      continue;
    }
    files.push(rel);
  }
  return { files, source, excluded, sensitive };
}

export function isBinaryBuffer(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** Minified / generated bundles: huge average line length. */
export function looksMinified(text) {
  if (text.length < 4000) return false;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++;
  return text.length / (newlines + 1) > 300;
}
