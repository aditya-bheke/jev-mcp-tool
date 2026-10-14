// Language detection, lexer settings and declaration patterns for the structural chunker.
// Deterministic regex heuristics (no tree-sitter dependency); see chunker.js for block detection.

const EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  vue: 'vue', svelte: 'svelte',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala', groovy: 'groovy', gradle: 'groovy',
  cs: 'csharp', go: 'go', rs: 'rust', swift: 'swift', dart: 'dart',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ipp: 'cpp', m: 'objc', mm: 'objc',
  php: 'php', py: 'python', pyi: 'python', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', lua: 'lua', ex: 'elixir', exs: 'elixir',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  sql: 'sql', md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  proto: 'proto', graphql: 'graphql', gql: 'graphql', tf: 'hcl', hcl: 'hcl',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', htm: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  txt: 'text', rst: 'text', adoc: 'text',
};

const FILENAMES = {
  dockerfile: 'dockerfile', makefile: 'make', gnumakefile: 'make', rakefile: 'ruby', gemfile: 'ruby',
  podfile: 'ruby', vagrantfile: 'ruby', brewfile: 'ruby', jenkinsfile: 'groovy', 'cmakelists.txt': 'cmake',
};

export function detectLanguage(relPath) {
  const base = String(relPath).split('/').pop().toLowerCase();
  if (FILENAMES[base]) return FILENAMES[base];
  if (base.startsWith('dockerfile')) return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'text';
  return EXT[base.slice(dot + 1)] ?? 'text';
}

/** Chunking family: brace-structured ("c"), JS-like ("js"), indentation ("indent"), markdown, sql. */
export const FAMILY = {
  javascript: 'js', typescript: 'js', vue: 'js', svelte: 'js',
  java: 'c', kotlin: 'c', scala: 'c', groovy: 'c', csharp: 'c', dart: 'c', swift: 'c', c: 'c', cpp: 'c',
  objc: 'c', php: 'c', go: 'c', rust: 'c', proto: 'c', graphql: 'c', hcl: 'c', shell: 'c',
  python: 'indent', ruby: 'indent', lua: 'indent', elixir: 'indent',
  markdown: 'markdown', sql: 'sql',
};

const SINGLE_QUOTE_STRINGS = new Set(['javascript', 'typescript', 'vue', 'svelte', 'php', 'python', 'ruby', 'shell', 'dart', 'groovy', 'lua', 'elixir', 'hcl']);
const BACKTICK_STRINGS = new Set(['javascript', 'typescript', 'vue', 'svelte', 'go', 'shell']);
const TRIPLE_QUOTES = new Set(['java', 'kotlin', 'swift', 'scala', 'groovy', 'dart', 'csharp', 'python']);
const HASH_COMMENTS = new Set(['shell', 'php', 'hcl', 'graphql', 'python', 'ruby', 'elixir']);
const NO_SLASH_COMMENTS = new Set(['shell', 'python', 'ruby', 'elixir', 'graphql', 'lua']);

export function lexerOptions(language) {
  return {
    slashComments: !NO_SLASH_COMMENTS.has(language),
    hashComments: HASH_COMMENTS.has(language),
    singleQuoteStrings: SINGLE_QUOTE_STRINGS.has(language),
    backtick: BACKTICK_STRINGS.has(language),
    tripleQuotes: TRIPLE_QUOTES.has(language),
  };
}

/** Indentation-family languages whose blocks end with an `end` keyword. */
export const END_KEYWORD_LANGS = new Set(['ruby', 'lua', 'elixir']);

/** Container types whose nested functions are reported as methods. */
export const METHOD_PARENTS = new Set(['class', 'interface', 'struct', 'impl', 'enum', 'module', 'object']);

// ---------------------------------------------------------------------------------------------
// Declaration patterns. Each entry: { re, type, name?, nameGroup?, container?, requireBody?, mode?,
// member?, reserved?, parent? }. `mode: 'call'` means the block is a balanced (...) / {...} expression.
// ---------------------------------------------------------------------------------------------

const JS_RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'await', 'yield', 'do',
  'else', 'try', 'throw', 'super', 'import', 'export', 'delete', 'void', 'in', 'of', 'with', 'case',
  'default', 'var', 'let', 'const',
]);
const CLASS_NAME_RESERVED = new Set(['extends', 'implements']);

const JS_PATTERNS = [
  { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, type: 'class', container: true, reserved: CLASS_NAME_RESERVED },
  { re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, type: 'interface' },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, type: 'enum' },
  { re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, type: 'type' },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/, type: 'module', container: true },
  { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/, type: 'function', requireBody: true },
  {
    re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|\(\s*$|<[^>]*>\s*\()/,
    type: 'function',
    requireBody: true,
  },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:[A-Za-z_$][\w$.]*\s*\(\s*)?[{[]\s*$/, type: 'variable', requireBody: true, mode: 'call' },
  { re: /^module\.exports\s*=\s*\{\s*$/, type: 'variable', name: 'module.exports', requireBody: true, mode: 'call' },
  { re: /^(describe|context|suite)(?:\.(?:only|skip|each\s*\(.*?\)))?\s*\(\s*(['"`])(.+?)\2/, type: 'test', container: true, name: (m) => `${m[1]} ${m[3]}`, mode: 'call' },
  { re: /^(it|test|specify|bench)(?:\.(?:only|skip|todo|concurrent|each\s*\(.*?\)))?\s*\(\s*(['"`])(.+?)\2/, type: 'test', name: (m) => m[3], mode: 'call' },
  { re: /^(?:app|router|server|api|routes?|fastify)\.(get|post|put|patch|delete|all|options|head)\s*\(\s*(['"`])(.+?)\2/i, type: 'route', name: (m) => `${m[1].toUpperCase()} ${m[3]}`, mode: 'call' },
  {
    member: true,
    re: /^(?:(?:public|private|protected|static|readonly|abstract|override|async|declare|get|set|accessor)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/,
    type: 'method',
    requireBody: true,
    reserved: JS_RESERVED,
  },
  {
    member: true,
    re: /^(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
    type: 'method',
    requireBody: true,
    reserved: JS_RESERVED,
  },
];

const CF_MODS = String.raw`(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|override|virtual|async|extern|inline|partial|data|inner|annotation|suspend|tailrec|operator|infix|unsafe|synchronized|native|transient|strictfp|lateinit|actual|expect|fileprivate|mutating|nonmutating|dynamic|required|convenience|lazy|weak|implicit|readonly|volatile|constexpr|explicit|friend|value|enum|case|export|default|non-sealed|const|declare|pub(?:\([^)]*\))?)\s+)*`;

const CF_CONTAINER_RE = new RegExp(String.raw`^${CF_MODS}(class|interface|enum|record|struct|trait|object|protocol|extension|namespace|module|union|@interface|companion\s+object)\s+([A-Za-z_][\w.:]*)`);

function containerType(keyword) {
  const k = keyword.replace(/\s+/g, ' ');
  if (['interface', 'protocol', 'trait'].includes(k)) return 'interface';
  if (k === 'enum') return 'enum';
  if (k === 'struct' || k === 'union') return 'struct';
  if (k === 'namespace' || k === 'module') return 'module';
  return 'class';
}

const CF_CONTAINER = { re: CF_CONTAINER_RE, type: (m) => containerType(m[1]), name: (m) => m[2], container: true, reserved: CLASS_NAME_RESERVED };

const KOTLIN_FUN = { re: new RegExp(String.raw`^${CF_MODS}fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?, ]+\.)?([A-Za-z_]\w*)\s*\(`), type: 'function' };
const SWIFT_FUNC = { re: new RegExp(String.raw`^${CF_MODS}func\s+([A-Za-z_]\w*)`), type: 'function' };
const SWIFT_INIT = { re: new RegExp(String.raw`^${CF_MODS}(?:convenience\s+)?(init|deinit)\b`), type: 'method', requireBody: true };
const SCALA_DEF = { re: new RegExp(String.raw`^${CF_MODS}def\s+([A-Za-z_]\w*)\s*[(\[:=]`), type: 'function' };
const PHP_FUNCTION = { re: new RegExp(String.raw`^${CF_MODS}function\s+&?\s*([A-Za-z_]\w*)\s*\(`), type: 'function', requireBody: true };

const GO_PATTERNS = [
  { re: /^func\s+\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)/, type: 'method', name: (m) => m[2], parent: (m) => m[1], requireBody: true },
  { re: /^func\s+([A-Za-z_]\w*)/, type: 'function', requireBody: true },
  { re: /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/, type: (m) => (m[2] === 'struct' ? 'struct' : 'interface'), requireBody: true },
];

const RUST_PATTERNS = [
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+([A-Za-z_]\w*)/, type: 'function' },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(struct|enum|union)\s+([A-Za-z_]\w*)/, type: (m) => (m[1] === 'enum' ? 'enum' : 'struct'), name: (m) => m[2] },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, type: 'interface', container: true },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/, type: 'module', container: true },
  { re: /^(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+([^{]+?)\s*(?:where\b[^{]*)?\{?\s*$/, type: 'impl', container: true, name: (m) => m[1].replace(/\s+/g, ' ').trim() },
  { re: /^macro_rules!\s*([A-Za-z_]\w*)/, type: 'macro' },
];

const SHELL_PATTERNS = [
  { re: /^function\s+([A-Za-z_][\w:.-]*)/, type: 'function', requireBody: true },
  { re: /^([A-Za-z_][\w:.-]*)\s*\(\s*\)/, type: 'function', requireBody: true },
];

const PROTO_PATTERNS = [
  { re: /^(message|service|enum|oneof|extend)\s+([A-Za-z_][\w.]*)/, type: (m) => (m[1] === 'enum' ? 'enum' : m[1] === 'service' ? 'interface' : 'class'), name: (m) => m[2], container: true },
  { re: /^rpc\s+([A-Za-z_]\w*)/, type: 'method' },
];

const GRAPHQL_PATTERNS = [
  { re: /^(?:extend\s+)?(?:type|input|enum|interface|union|scalar|schema|directive)\s+@?([A-Za-z_]\w*)/, type: 'type' },
  { re: /^(?:query|mutation|subscription|fragment)\s+([A-Za-z_]\w*)/, type: 'function' },
];

const HCL_PATTERNS = [
  {
    re: /^(resource|data|module|variable|output|provider|locals|terraform)\b\s*(?:"([^"]+)")?\s*(?:"([^"]+)")?/,
    type: 'resource',
    name: (m) => [m[1], m[2], m[3]].filter(Boolean).join('.'),
    requireBody: true,
  },
];

const PYTHON_PATTERNS = [
  { re: /^class\s+([A-Za-z_]\w*)/, type: 'class', container: true },
  { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, type: 'function' },
];

const RUBY_PATTERNS = [
  { re: /^(class|module)\s+([A-Z][\w:]*)/, type: (m) => (m[1] === 'class' ? 'class' : 'module'), name: (m) => m[2], container: true },
  { re: /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, type: 'function' },
  { re: /^(?:RSpec\.)?(describe|context)\s+(?:(['"])(.+?)\2|([A-Z][\w:]*))/, type: 'test', container: true, name: (m) => `${m[1]} ${m[3] ?? m[4]}` },
  { re: /^it\s+(['"])(.+?)\1/, type: 'test', name: (m) => m[2] },
];

const LUA_PATTERNS = [{ re: /^(?:local\s+)?function\s+([\w.:]+)/, type: 'function' }];

const ELIXIR_PATTERNS = [
  { re: /^defmodule\s+([\w.]+)/, type: 'module', container: true },
  { re: /^(?:def|defp|defmacro|defmacrop)\s+([\w?!]+)/, type: 'function' },
];

const C_LIKE = [CF_CONTAINER];

const PATTERNS = {
  javascript: JS_PATTERNS, typescript: JS_PATTERNS, vue: JS_PATTERNS, svelte: JS_PATTERNS,
  java: C_LIKE, csharp: C_LIKE, c: C_LIKE, cpp: C_LIKE, objc: C_LIKE, dart: C_LIKE,
  groovy: [CF_CONTAINER, SCALA_DEF],
  kotlin: [CF_CONTAINER, KOTLIN_FUN],
  swift: [CF_CONTAINER, SWIFT_FUNC, SWIFT_INIT],
  scala: [CF_CONTAINER, SCALA_DEF],
  php: [CF_CONTAINER, PHP_FUNCTION],
  go: GO_PATTERNS, rust: RUST_PATTERNS, shell: SHELL_PATTERNS, proto: PROTO_PATTERNS,
  graphql: GRAPHQL_PATTERNS, hcl: HCL_PATTERNS,
  python: PYTHON_PATTERNS, ruby: RUBY_PATTERNS, lua: LUA_PATTERNS, elixir: ELIXIR_PATTERNS,
};

/** Languages where "<return type> name(args) {" style functions are detected heuristically. */
const GENERIC_C_FUNCTIONS = new Set(['java', 'csharp', 'c', 'cpp', 'objc', 'dart', 'groovy']);

const CF_CONTROL = new Set([
  'if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'else', 'do', 'sizeof',
  'typeof', 'alignof', 'decltype', 'case', 'when', 'using', 'lock', 'synchronized', 'with', 'try', 'assert',
  'await', 'yield', 'delete', 'defined', 'elif', 'until', 'unless', 'match', 'guard', 'defer', 'go',
  'select', 'fixed', 'checked', 'unchecked', 'nameof', 'super', 'this', 'base', 'print', 'println',
  'printf', 'static_assert', '__attribute__', 'noexcept', 'throws', 'operator', 'goto',
]);

function matchCFunction(line, depth) {
  const paren = line.indexOf('(');
  if (paren <= 0) return null;
  const head = line.slice(0, paren).trimEnd();
  if (!head) return null;
  const plain = head.replace(/<[^<>]*>/g, '').replace(/<[^<>]*>/g, '');
  if (/[=;{}"'`]/.test(plain) || /\breturn\b/.test(plain)) return null;
  const m = plain.match(/(~?[A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*)\s*$/);
  if (!m) return null;
  const qualified = m[1];
  const before = plain.slice(0, plain.length - m[0].length).trim();
  if (/(?:\.|->|::)$/.test(before)) return null;
  const simple = qualified.split('::').pop();
  const firstToken = before.split(/\s+/)[0] ?? '';
  if (CF_CONTROL.has(simple) || CF_CONTROL.has(firstToken)) return null;
  if (/\)\s*;\s*$/.test(line)) return null;
  const isMacro = /^[A-Z_][A-Z0-9_]*$/.test(simple);
  if (!before) {
    // Bare `name(` is only plausible for constructors inside a class or macro-style definitions.
    if (depth === 0 && !isMacro) return null;
    if (!/[{(,)]\s*$/.test(line.trimEnd())) return null;
  }
  let name = qualified;
  if (isMacro && !before) {
    const close = line.indexOf(')', paren);
    if (close > paren) name = line.slice(0, close + 1).trim();
  }
  return { type: depth > 0 || qualified.includes('::') ? 'method' : 'function', name, requireBody: true };
}

export function isCommentLine(line, family) {
  if (family === 'indent') return line.startsWith('#') || line.startsWith('--') || line.startsWith('=begin');
  if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) return true;
  if (family === 'c' && line.startsWith('#')) return true;
  return false;
}

function stripAnnotations(line, family) {
  let s = line;
  if (family === 'js') {
    s = s.replace(/^(?:@[\w.]+(?:\([^)]*\))?\s+)+/, '');
  } else if (family === 'c') {
    s = s
      .replace(/^(?:@(?!interface\b)[\w.]+(?:\([^)]*\))?\s*)+/, '')
      .replace(/^(?:\[[^\]]*\]\s*)+/, '')
      .replace(/^#!?\[[^\]]*\]\s*/, '')
      .replace(/^template\s*<[^>]*>\s*/, '');
  } else if (family === 'indent') {
    if (/^@[\w.]+(?:\(.*\))?\s*$/.test(s)) s = '';
  }
  return s.trim();
}

function cleanName(name) {
  return String(name).replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Match a declaration on a single (raw) source line.
 * @returns {{type: string, name: string, parent?: string, container: boolean, requireBody: boolean, mode: string} | null}
 */
export function matchDecl(rawLine, language, family, scope) {
  if (rawLine.length > 1000) return null;
  let line = rawLine.trim();
  if (!line || isCommentLine(line, family)) return null;
  line = stripAnnotations(line, family);
  if (!line) return null;
  const patterns = PATTERNS[language] ?? [];
  for (const p of patterns) {
    if (p.member && scope.parentType !== 'class') continue;
    const m = p.re.exec(line);
    if (!m) continue;
    const rawName = typeof p.name === 'function' ? p.name(m) : (p.name ?? m[p.nameGroup ?? 1]);
    if (!rawName) continue;
    const name = cleanName(rawName);
    if (p.reserved && p.reserved.has(name)) continue;
    return {
      type: typeof p.type === 'function' ? p.type(m) : p.type,
      name,
      parent: p.parent ? p.parent(m) : undefined,
      container: !!p.container,
      requireBody: !!p.requireBody,
      mode: p.mode ?? 'brace',
    };
  }
  if (GENERIC_C_FUNCTIONS.has(language)) {
    const f = matchCFunction(line, scope.depth);
    if (f) return { ...f, name: cleanName(f.name), container: false, mode: 'brace' };
  }
  return null;
}
