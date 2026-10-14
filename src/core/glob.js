/**
 * Convert a gitignore-style glob to a RegExp tested against root-relative POSIX paths.
 * - `name` / `*.ext`   match at any depth (and everything beneath a matching directory)
 * - `/path` or `a/b`   anchored to the root
 * - `dir/`             only things beneath the directory
 * - `**`, `*`, `?`, `[...]` behave like gitignore
 */
export function globToRegExp(pattern, { caseInsensitive = false } = {}) {
  let g = String(pattern).trim().replace(/\\/g, '/');
  let anchored = false;
  if (g.startsWith('/')) {
    anchored = true;
    g = g.slice(1);
  }
  let dirOnly = false;
  if (g.endsWith('/')) {
    dirOnly = true;
    g = g.replace(/\/+$/, '');
  }
  if (g.startsWith('**/')) g = g.slice(3);
  else if (!anchored && g.includes('/')) anchored = true;

  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const prevSlash = i === 0 || g[i - 1] === '/';
        const nextSlash = g[i + 2] === '/';
        const atEnd = i + 2 >= g.length;
        if (prevSlash && nextSlash) {
          re += '(?:[^/]*/)*';
          i += 2;
          continue;
        }
        if (prevSlash && atEnd) {
          re += '.*';
          i += 1;
          continue;
        }
        re += '[^/]*';
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = g.indexOf(']', i + 2);
      if (close === -1) {
        re += '\\[';
        continue;
      }
      let body = g.slice(i + 1, close);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = close;
    } else if ('.+^$(){}|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  const suffix = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(prefix + re + suffix, caseInsensitive ? 'i' : '');
}

/** Compile a list of globs (comments, blanks and negations ignored) into a predicate. */
export function createMatcher(patterns, opts = {}) {
  const regexes = [];
  for (const raw of patterns ?? []) {
    const p = String(raw ?? '').trim();
    if (!p || p.startsWith('#') || p.startsWith('!')) continue;
    try {
      regexes.push(globToRegExp(p, opts));
    } catch {
      /* skip malformed pattern */
    }
  }
  return (relPath) => regexes.some((re) => re.test(relPath));
}
