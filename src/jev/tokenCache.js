import { CortexError } from '../core/util.js';

export const BOOLEAN_CANDIDATES = [
  { key: 'true', forms: ['true', 'True'] },
  { key: 'false', forms: ['false', 'False'] },
];
export const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * Vocabulary mapper for answer labels.
 *
 * Tokenizers encode " true" (leading space) and "true" as different tokens, and some do not have a
 * single-token leading-space form at all (Qwen splits " 7" into " " + "7"). For a candidate set we
 * therefore pick one of two prompt endings:
 *   - "Answer:"  when every label has a single-token leading-space form; both the spaced and the
 *                bare token ids are kept and later merged with log-sum-exp.
 *   - "Answer: " (the space is its own token) when only bare single-token forms exist.
 */
export class TokenCache {
  constructor(model) {
    this.model = model;
    this.singles = new Map();
    this.resolved = new Map();
  }

  /** Token id when `text` encodes to exactly one token, otherwise null. */
  single(text) {
    if (!this.singles.has(text)) {
      const tokens = this.model.tokenize(text, false);
      this.singles.set(text, tokens.length === 1 ? tokens[0] : null);
    }
    return this.singles.get(text);
  }

  /** Pre-resolve the standard label vocabularies (booleans, A-H, 1-10) at load time. */
  warm() {
    const forms = [
      ...BOOLEAN_CANDIDATES.flatMap((c) => c.forms),
      ...CHOICE_LETTERS,
      ...Array.from({ length: 10 }, (_, i) => String(i + 1)),
    ];
    for (const form of forms) {
      this.single(form);
      this.single(` ${form}`);
    }
  }

  /**
   * @param {{key: string, forms: string[]}[]} candidates
   * @returns {{suffix: string, ids: number[][]}} prompt ending and token ids aligned with candidates
   */
  resolve(candidates) {
    const cacheKey = candidates.map((c) => c.forms.join('|')).join('||');
    const cached = this.resolved.get(cacheKey);
    if (cached) return cached;
    const collect = (prefix) => candidates.map((c) => [...new Set(c.forms.map((f) => this.single(`${prefix}${f}`)).filter((id) => id != null))]);
    const spaced = collect(' ');
    const bare = collect('');
    let result;
    if (spaced.every((ids) => ids.length)) {
      result = { suffix: 'Answer:', ids: spaced.map((ids, i) => [...new Set([...ids, ...bare[i]])]) };
    } else if (bare.every((ids) => ids.length)) {
      result = { suffix: 'Answer: ', ids: bare };
    } else {
      const unusable = candidates.filter((_, i) => !bare[i].length).map((c) => c.key);
      throw new CortexError('JEV_TOKENIZER', `The model tokenizer has no single-token form for answer label(s): ${unusable.join(', ')}. Use fewer score levels (1-9) or choice options.`);
    }
    this.resolved.set(cacheKey, result);
    return result;
  }
}
