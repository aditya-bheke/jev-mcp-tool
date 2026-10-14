import { END_KEYWORD_LANGS, FAMILY, METHOD_PARENTS, detectLanguage, lexerOptions, matchDecl } from './languages.js';

// Structural chunking: files are split along class / function / method / section boundaries so
// search can return a focused, line-addressed snippet instead of a whole file.

const MAX_CHUNKS_PER_FILE = 2000;
const BRACE_LOOKAHEAD = 8;
const MAX_BLOCK_SCAN = 4000;

const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|export\s+\*\s+from\b|export\s+\{[^}]*\}\s+from\b|#include\b|#import\b|using\s+[\w.]+\s*;|use\s+[\w:{}, *]+;|(?:const|let|var)\s+.*=\s*require\(|require\(|package\s+[\w.]+;?\s*$|@import\b|extern\s+crate\b|library\s+[\w.]+;)/;

function isTrivial(line) {
  const t = line.trim();
  return t === '' || /^[}\])][}\]);,]*$/.test(t) || t === 'end' || t === 'end;' || t === 'fi' || t === 'esac';
}

function indentWidth(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

/** Character-level scanner that reports structural characters outside strings and comments. */
class Lexer {
  constructor(opts) {
    this.opts = opts;
    this.state = null; // null | { type: 'block' } | { type: 'string', quote, multiline }
  }

  scan(line) {
    const out = [];
    const o = this.opts;
    if (this.state && this.state.type === 'string' && !this.state.multiline) this.state = null;
    let i = 0;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      if (this.state) {
        if (this.state.type === 'block') {
          const j = line.indexOf('*/', i);
          if (j === -1) {
            i = n;
            break;
          }
          this.state = null;
          i = j + 2;
          continue;
        }
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (line.startsWith(this.state.quote, i)) {
          i += this.state.quote.length;
          this.state = null;
          continue;
        }
        i++;
        continue;
      }
      if (o.slashComments && c === '/' && line[i + 1] === '/') break;
      if (o.hashComments && c === '#') break;
      if (o.slashComments && c === '/' && line[i + 1] === '*') {
        this.state = { type: 'block' };
        i += 2;
        continue;
      }
      if (c === '"') {
        if (o.tripleQuotes && line.startsWith('"""', i)) {
          this.state = { type: 'string', quote: '"""', multiline: true };
          i += 3;
          continue;
        }
        this.state = { type: 'string', quote: '"', multiline: false };
        i++;
        continue;
      }
      if (c === '`' && o.backtick) {
        this.state = { type: 'string', quote: '`', multiline: true };
        i++;
        continue;
      }
      if (c === "'") {
        if (o.singleQuoteStrings) {
          this.state = { type: 'string', quote: "'", multiline: false };
          i++;
          continue;
        }
        // char literal ('x', '\n', '\u{1F600}') or a lifetime / tick that is not a string
        if (line[i + 1] === '\\') {
          const j = line.indexOf("'", i + 2);
          i = j === -1 ? n : j + 1;
          continue;
        }
        if (line[i + 2] === "'") {
          i += 3;
          continue;
        }
        i++;
        continue;
      }
      if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ';') out.push(c);
      i++;
    }
    return out;
  }
}

function nextNonBlank(lines, from, hi) {
  for (let i = from; i <= hi; i++) if (lines[i].trim()) return i;
  return -1;
}

const CONTINUES_AFTER = /(?:[,(:=|&+.\-<>]|=>|->|\b(?:extends|implements|throws|where|with))\s*$/;
const CONTINUES_BEFORE = /^\s*(?:\{|throws\b|where\b|extends\b|implements\b|:|->|=>|\.|,|with\b|\)|&|\|)/;

/** Find the end of a `decl ... { ... }` block. Returns { end, body } or null when unterminated. */
function findBraceEnd(lines, start, hi, lexOpts) {
  const lexer = new Lexer(lexOpts);
  let opened = false;
  let depth = 0;
  let parens = 0;
  const limit = Math.min(hi, start + MAX_BLOCK_SCAN);
  for (let i = start; i <= limit; i++) {
    for (const ch of lexer.scan(lines[i])) {
      if (!opened) {
        if (ch === '(' || ch === '[') parens++;
        else if (ch === ')' || ch === ']') parens = Math.max(0, parens - 1);
        else if (ch === '{' && parens === 0) {
          opened = true;
          depth = 1;
        } else if (ch === ';' && parens === 0) {
          return { end: i, body: false };
        }
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return { end: i, body: true };
      }
    }
    if (!opened) {
      if (i - start >= BRACE_LOOKAHEAD) return null;
      if (parens === 0) {
        const trimmed = lines[i].replace(/\/\/.*$/, '').trim();
        const next = nextNonBlank(lines, i + 1, hi);
        const continues = CONTINUES_AFTER.test(trimmed) || (next !== -1 && CONTINUES_BEFORE.test(lines[next]));
        if (!continues) return { end: i, body: false };
      }
    }
  }
  return null;
}

/** Balanced-expression end (describe(..., () => {...}), const x = {...}). */
function findCallEnd(lines, start, hi, lexOpts) {
  const lexer = new Lexer(lexOpts);
  let depth = 0;
  let opened = false;
  const limit = Math.min(hi, start + MAX_BLOCK_SCAN);
  for (let i = start; i <= limit; i++) {
    for (const ch of lexer.scan(lines[i])) {
      if (ch === '(' || ch === '{' || ch === '[') {
        depth++;
        opened = true;
      } else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
        if (opened && depth <= 0) return { end: i, body: i > start };
      }
    }
  }
  return null;
}

/** Indentation-delimited block (Python, Ruby/Lua/Elixir with `end`, brace-language fallback). */
function findIndentEnd(lines, start, hi, { endKeyword = false, header = false } = {}) {
  const base = indentWidth(lines[start]);
  let headerEnd = start;
  if (header) {
    let depth = 0;
    let i = start;
    for (; i <= hi && i - start < 30; i++) {
      const code = lines[i].replace(/#.*$/, '');
      for (const ch of code) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
      }
      if (depth <= 0) break;
    }
    headerEnd = i <= hi && i - start < 30 ? i : start;
  }
  let last = headerEnd;
  for (let j = headerEnd + 1; j <= hi; j++) {
    const line = lines[j];
    if (!line.trim()) continue;
    const width = indentWidth(line);
    if (width > base) {
      last = j;
      continue;
    }
    if (endKeyword && width === base && /^\s*(?:end\b|\}|\)|\])/.test(line)) last = j;
    else if (!endKeyword && width === base && /^\s*[}\])]/.test(line)) last = j;
    break;
  }
  return { end: last, body: last > headerEnd };
}

function extendLeading(lines, declIdx, floor) {
  let start = declIdx;
  for (let j = declIdx - 1; j >= floor && declIdx - j <= 40; j--) {
    const t = lines[j].trim();
    if (!t) break;
    if (/^(?:@|#\[|#!\[|\[[A-Za-z]|\/\/|\/\*|\*|--|"""|''')/.test(t) || (/^#(?!include|define|if|endif|else|elif|import|pragma|undef)/.test(t))) {
      start = j;
      continue;
    }
    break;
  }
  return start;
}

function isImportBlock(lines, s, e) {
  let meaningful = 0;
  let imports = 0;
  for (let i = s; i <= e; i++) {
    const t = lines[i].trim();
    const isComment = t.startsWith('//') || (t.startsWith('#') && !t.startsWith('#include') && !t.startsWith('#import'));
    if (!t || isTrivial(lines[i]) || isComment) continue;
    meaningful++;
    if (IMPORT_LINE.test(lines[i])) imports++;
  }
  return meaningful > 0 && imports / meaningful >= 0.6;
}

function joinName(parent, name, type) {
  if (!parent) return name;
  return type === 'test' ? `${parent} > ${name}` : `${parent}.${name}`;
}

class ChunkSink {
  constructor(lines, opts) {
    this.lines = lines;
    this.opts = opts;
    this.chunks = [];
  }

  push(type, name, parent, s, e) {
    if (this.chunks.length >= MAX_CHUNKS_PER_FILE || e < s) return;
    const content = this.lines.slice(s, e + 1).join('\n');
    if (!content.trim()) return;
    this.chunks.push({
      symbol_type: type,
      symbol_name: name ?? null,
      parent_symbol: parent ?? null,
      start_line: s + 1,
      end_line: e + 1,
      content,
    });
  }

  /** Emit a range, splitting oversized ranges into windows. */
  emit(type, name, parent, s, e) {
    if (e < s) return;
    if (e - s + 1 > this.opts.maxChunkLines) {
      for (let a = s; a <= e; a += this.opts.windowLines) {
        this.push(type, name, parent, a, Math.min(e, a + this.opts.windowLines - 1));
      }
    } else {
      this.push(type, name, parent, s, e);
    }
  }
}

function chunkCode(lines, language, family, opts) {
  const sink = new ChunkSink(lines, opts);
  const lexOpts = lexerOptions(language);
  const endKeyword = END_KEYWORD_LANGS.has(language);

  const findEnd = (i, hi, decl) => {
    if (family === 'indent') return findIndentEnd(lines, i, hi, { endKeyword, header: language === 'python' });
    if (decl.mode === 'call') return findCallEnd(lines, i, hi, lexOpts);
    return findBraceEnd(lines, i, hi, lexOpts) ?? findIndentEnd(lines, i, hi, { endKeyword: false });
  };

  const emitGap = (s, e, parent, depth, header) => {
    let a = s;
    let b = e;
    while (a <= b && isTrivial(lines[a])) a++;
    while (b >= a && isTrivial(lines[b])) b--;
    if (header) {
      sink.emit(header.type, header.name, header.parent, header.start, a <= b ? b : header.declLine);
      return;
    }
    if (a > b) return;
    const imports = depth === 0 && isImportBlock(lines, a, b);
    sink.emit(imports ? 'imports' : 'block', imports ? '(imports)' : null, parent, a, b);
  };

  const walk = (lo, hi, parent, parentType, depth, header) => {
    let pendingHeader = header;
    let gapStart = lo;
    let i = lo;
    while (i <= hi) {
      const decl = matchDecl(lines[i], language, family, { parentType, depth });
      if (decl) {
        const found = findEnd(i, hi, decl);
        if (found && (!decl.requireBody || found.body)) {
          const start = extendLeading(lines, i, gapStart);
          emitGap(gapStart, start - 1, parent, depth, pendingHeader);
          pendingHeader = null;
          emitDecl(decl, start, i, found.end, parent, parentType, depth);
          i = found.end + 1;
          gapStart = i;
          continue;
        }
      }
      i++;
    }
    emitGap(gapStart, hi, parent, depth, pendingHeader);
  };

  const emitDecl = (decl, start, declLine, end, parent, parentType, depth) => {
    const parentName = decl.parent ?? parent;
    const type = decl.type === 'function' && parentType && METHOD_PARENTS.has(parentType) ? 'method' : decl.type;
    const size = end - start + 1;
    if (decl.container && size > opts.smallContainerLines && depth < 4 && end - declLine >= 2) {
      const closes = /^\s*(?:[}\])]|end\b)/.test(lines[end]);
      const bodyHi = closes ? end - 1 : end;
      walk(declLine + 1, bodyHi, joinName(parentName, decl.name, decl.type), decl.type, depth + 1, {
        type,
        name: decl.name,
        parent: parentName,
        start,
        declLine,
      });
      return;
    }
    sink.emit(type, decl.name, parentName, start, end);
  };

  walk(0, lines.length - 1, null, null, 0, null);
  return sink.chunks;
}

function chunkMarkdown(lines, relPath, opts) {
  const sink = new ChunkSink(lines, opts);
  const sections = [];
  const stack = [];
  let inFence = false;
  let fenceChar = '';
  let current = { start: 0, name: relPath.split('/').pop(), parent: null };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const level = heading[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].name : null;
    stack.push({ level, name: heading[2] });
    if (i > current.start) sections.push({ ...current, end: i - 1 });
    current = { start: i, name: heading[2], parent };
  }
  sections.push({ ...current, end: lines.length - 1 });
  for (const s of sections) sink.emit('section', s.name, s.parent, s.start, s.end);
  return sink.chunks;
}

const SQL_DECL = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:MATERIALIZED\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER|TYPE|SEQUENCE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`[\]]+)/i;

function chunkSql(lines, opts) {
  const sink = new ChunkSink(lines, opts);
  let gapStart = 0;
  let i = 0;
  while (i < lines.length) {
    const m = SQL_DECL.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    let end = i;
    let dollar = 0;
    for (let j = i; j < lines.length && j - i < 600; j++) {
      dollar += (lines[j].match(/\$\$/g) || []).length;
      end = j;
      if (dollar % 2 === 0 && /;\s*(?:--.*)?$/.test(lines[j])) break;
    }
    if (i > gapStart) sink.emit('block', null, null, gapStart, i - 1);
    const kind = m[1].toUpperCase();
    const type = kind === 'FUNCTION' || kind === 'PROCEDURE' || kind === 'TRIGGER' ? 'function' : kind === 'TABLE' || kind === 'VIEW' || kind === 'TYPE' ? 'type' : 'block';
    sink.emit(type, m[2].replace(/["`[\]]/g, ''), null, i, end);
    i = end + 1;
    gapStart = i;
  }
  if (gapStart < lines.length) sink.emit('block', null, null, gapStart, lines.length - 1);
  return sink.chunks;
}

function chunkWindows(lines, opts) {
  const sink = new ChunkSink(lines, opts);
  for (let a = 0; a < lines.length; a += opts.windowLines) {
    sink.push('block', null, null, a, Math.min(lines.length - 1, a + opts.windowLines - 1));
  }
  return sink.chunks;
}

/**
 * Split a file into structural chunks.
 * @returns {{ language: string, chunks: Array<{symbol_type, symbol_name, parent_symbol, start_line, end_line, content}> }}
 */
export function chunkSource(text, relPath, opts) {
  const language = detectLanguage(relPath);
  const lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return { language, chunks: [] };
  const family = FAMILY[language];
  let chunks;
  if (family === 'markdown') chunks = chunkMarkdown(lines, relPath, opts);
  else if (family === 'sql') chunks = chunkSql(lines, opts);
  else if (family) chunks = chunkCode(lines, language, family, opts);
  else chunks = chunkWindows(lines, opts);
  return { language, chunks };
}
