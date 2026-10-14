import { spawnSync } from 'node:child_process';

/** Run git and return stdout, or null on any failure (git missing, not a repo, timeout). */
export function git(cwd, args, { timeout = 10_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  if (!cwd) return null;
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

export function gitTopLevel(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() || null : null;
}

/** Tracked + untracked-but-not-ignored files (respects .gitignore). */
export function gitListFiles(root) {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    timeout: 60_000,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (out == null) return null;
  return out.split('\0').filter(Boolean);
}

export function gitState(root) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(root, ['rev-parse', '--short=10', 'HEAD']);
  return { branch: branch ? branch.trim() : null, head: head ? head.trim() : null };
}

export function gitStatus(root, limit = 25) {
  const out = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (out == null) return null;
  const lines = out.split('\n').filter(Boolean);
  return {
    total: lines.length,
    entries: lines.slice(0, limit).map((line) => ({ status: line.slice(0, 2).trim() || '?', path: line.slice(3) })),
  };
}

/** Diff that (most likely) fixed something: working tree vs HEAD, else the last commit touching the files. */
export function gitDiffForFiles(root, files, maxChars = 4000) {
  if (!root || !files?.length) return null;
  let out = git(root, ['diff', 'HEAD', '--no-color', '--unified=2', '--', ...files]);
  if (!out || !out.trim()) out = git(root, ['show', '--no-color', '--unified=2', '--format=', 'HEAD', '--', ...files]);
  if (!out || !out.trim()) return null;
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…(diff truncated)` : out;
}
