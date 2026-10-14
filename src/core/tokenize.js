// Identifier decomposition and query tokenization shared by the code index, memory and ledger.

export const STOPWORDS = new Set(
  ('a an and are as at be been but by can could did do does doing for from had has have how i if in into is it '
    + 'its just me my no not of on or our should so some such than that the their them then there these they '
    + 'this those to too us was we were what when where which while who why will with would you your').split(' '),
);

// Words that describe the *search* rather than the code ("find the function that handles ...").
const QUERY_FILLER = new Set(
  ('find search show locate list give tell explain look lookup see whats code implementation implemented '
    + 'logic file files function functions method methods class classes thing things place places part parts '
    + 'defined define definition happen happens happening work works working usage usages used').split(' '),
);

// Keywords that add noise to the decomposed-token column.
const CODE_KEYWORDS = new Set(
  ('abstract async await boolean break case catch char class const continue def default del delete do double '
    + 'elif else enum export extends false final finally float for from func function go if impl implements '
    + 'import in instanceof int interface is lambda let long match mod module mut new nil none null object '
    + 'package pass private protected pub public raise return self static str string struct super switch this '
    + 'throw throws trait true try type typeof undefined use var void while with yield').split(' '),
);

const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*|\d+/g;

/** `ScheduledReportHandler` / `process_user_event` / `HTTPServer2` → lowercase parts (len >= 2). */
export function splitIdentifier(identifier) {
  if (!identifier) return [];
  return String(identifier)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 2);
}

/** Unique parts of every compound identifier in `text` (simple words are already in the content). */
export function decomposeIdentifiers(text, { limit = 400 } = {}) {
  const out = new Set();
  const words = String(text ?? '').match(WORD_RE) || [];
  for (const word of words) {
    if (word.length < 4) continue;
    const parts = splitIdentifier(word);
    if (parts.length < 2) continue;
    for (const part of parts) {
      if (CODE_KEYWORDS.has(part)) continue;
      out.add(part);
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

/** Path segments without extensions, decomposed: `src/jobs/ExportScheduler.java` → src jobs export scheduler. */
export function pathTerms(filePath) {
  return String(filePath ?? '')
    .split(/[\\/]/)
    .flatMap((segment) => splitIdentifier(segment.replace(/\.[^.]+$/, '')));
}

/** Tiny suffix stripper used for similarity (applied identically to both sides). */
export function lightStem(word) {
  let w = String(word).toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(?:ss|x|z|ch|sh)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('er')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Stemmed, stopword-free term set for similarity comparisons. */
export function textTerms(text) {
  const out = new Set();
  const words = String(text ?? '').match(WORD_RE) || [];
  for (const word of words) {
    const parts = splitIdentifier(word);
    const list = parts.length ? parts : [word.toLowerCase()];
    for (const part of list) {
      if (part.length < 2 || STOPWORDS.has(part)) continue;
      out.add(lightStem(part));
    }
  }
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / small.size;
}

/**
 * Tokenize a natural-language or identifier query.
 * terms: decomposed lowercase parts minus stop/filler words; compounds: whole compound identifiers.
 */
export function tokenizeQuery(query) {
  const words = String(query ?? '').match(WORD_RE) || [];
  const terms = new Set();
  const compounds = new Set();
  const all = new Set();
  for (const word of words) {
    const parts = splitIdentifier(word);
    if (parts.length > 1) compounds.add(word.toLowerCase().replace(/\$/g, ''));
    for (const part of parts) {
      all.add(part);
      if (STOPWORDS.has(part) || QUERY_FILLER.has(part)) continue;
      terms.add(part);
    }
  }
  if (!terms.size) for (const part of all) if (!STOPWORDS.has(part)) terms.add(part);
  if (!terms.size) for (const part of all) terms.add(part);
  return { terms: [...terms].slice(0, 16), compounds: [...compounds].slice(0, 6) };
}

/** Build a safe FTS5 MATCH expression: every token quoted and OR-ed (bm25 rewards coverage). */
export function ftsQuery(tokens, { prefix = false } = {}) {
  const clean = [...new Set(tokens.map((t) => String(t).replace(/[^A-Za-z0-9_]/g, '')).filter((t) => t.length > 0))];
  if (!clean.length) return null;
  return clean.map((t) => `"${t}"${prefix && t.length >= 3 ? '*' : ''}`).join(' OR ');
}
