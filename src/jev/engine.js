import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { BOOLEAN_CANDIDATES, CHOICE_LETTERS, TokenCache } from './tokenCache.js';
import { log } from '../core/logger.js';
import { CortexError, round, withTimeout } from '../core/util.js';

export const PRIMITIVES = ['noul', 'choice', 'score'];

const SYSTEM_PROMPT = 'You are a deterministic classification engine. Evaluate the state against the criteria. Answer with single token only.';
const TYPE_NAMES = { noul: 'Noul', choice: 'Choice', score: 'Score' };
const MAX_STATE_CHARS = 32_000;
const MAX_QUESTION_CHARS = 2_000;
const MAX_CRITERIA_CHARS = 6_000;
const RETRY_LOAD_AFTER_MS = 30_000;

/** ln(Σ e^v), stable for large magnitudes; -Infinity when every value is -Infinity. */
export function logSumExp(values) {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

/** P_i = e^((z_i - m)/T) / Σ_j e^((z_j - m)/T) with m = max z (no overflow). */
export function stableSoftmax(logits, temperature = 1) {
  const finite = logits.filter(Number.isFinite);
  if (!finite.length) return logits.map(() => 1 / logits.length);
  const m = Math.max(...finite);
  const exps = logits.map((z) => (Number.isFinite(z) ? Math.exp((z - m) / temperature) : 0));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function excerpt(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  return `${s.slice(0, head)}\n...[truncated]...\n${s.slice(s.length - (maxChars - head))}`;
}

function criteriaEntries(criteria) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new CortexError('JEV_BAD_CRITERIA', 'criteria must be an object mapping labels to descriptions.');
  }
  const entries = Object.entries(criteria)
    .map(([k, v]) => [String(k).trim(), String(v ?? '').replace(/\s+/g, ' ').trim()])
    .filter(([k]) => k);
  if (!entries.length) throw new CortexError('JEV_BAD_CRITERIA', 'criteria must not be empty.');
  return entries;
}

/** Build candidates, rubric and result mapping for a primitive. */
function prepare(primitive, criteria) {
  const entries = criteriaEntries(criteria);
  switch (primitive) {
    case 'noul':
      return {
        candidates: BOOLEAN_CANDIDATES,
        rubric: `${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}\nAnswer true or false.`,
        finish: (p) => ({
          primitive,
          probability: round(p[0], 4),
          answer: p[0] >= 0.5,
          distribution: { true: round(p[0], 4), false: round(p[1], 4) },
        }),
      };
    case 'choice': {
      if (entries.length < 2 || entries.length > CHOICE_LETTERS.length) {
        throw new CortexError('JEV_BAD_CRITERIA', `choice needs 2-${CHOICE_LETTERS.length} options (got ${entries.length}).`);
      }
      const letters = CHOICE_LETTERS.slice(0, entries.length);
      return {
        candidates: letters.map((l) => ({ key: l, forms: [l] })),
        rubric: `${entries.map(([k, v], i) => `${letters[i]}) ${k}${v ? `: ${v}` : ''}`).join('\n')}\nAnswer with one letter (${letters[0]}-${letters[letters.length - 1]}).`,
        finish: (p) => {
          const best = p.indexOf(Math.max(...p));
          return {
            primitive,
            winner: entries[best][0],
            confidence: round(p[best], 4),
            distribution: Object.fromEntries(entries.map(([k], i) => [k, round(p[i], 4)])),
          };
        },
      };
    }
    case 'score': {
      const levels = entries.map(([k, v]) => [Number(k), v]);
      if (levels.some(([n]) => !Number.isInteger(n))) throw new CortexError('JEV_BAD_CRITERIA', 'score criteria keys must be the integers 1..N.');
      levels.sort((a, b) => a[0] - b[0]);
      const n = levels.length;
      if (n < 2 || n > 10 || levels.some(([lvl], i) => lvl !== i + 1)) {
        throw new CortexError('JEV_BAD_CRITERIA', 'score criteria keys must be consecutive integers from 1 to N (2 <= N <= 10).');
      }
      return {
        candidates: levels.map(([lvl]) => ({ key: String(lvl), forms: [String(lvl)] })),
        rubric: `${levels.map(([lvl, v]) => `${lvl}: ${v}`).join('\n')}\nAnswer with one number from 1 to ${n}.`,
        finish: (p) => ({
          primitive,
          score: round(p.reduce((acc, prob, i) => acc + (i + 1) * prob, 0), 4),
          scale: n,
          distribution: Object.fromEntries(levels.map(([lvl], i) => [String(lvl), round(p[i], 4)])),
        }),
      };
    }
    default:
      throw new CortexError('JEV_BAD_PRIMITIVE', `primitive must be one of: ${PRIMITIVES.join(', ')}`);
  }
}

/**
 * Jev decision engine: one non-generative prefill pass over a ChatML prompt, logits read for the
 * candidate answer tokens only, then a calibrated softmax. Evaluations are serialized on a single
 * context sequence whose KV cache is cleared before and after every pass.
 */
export class JevEngine {
  constructor(config) {
    this.config = config;
    this.state = config.enabled ? 'idle' : 'disabled';
    this.error = null;
    this.failedAt = 0;
    this.loading = null;
    this.generation = 0;
    this.llama = null;
    this.model = null;
    this.context = null;
    this.sequence = null;
    this.tokens = null;
    this.gpu = null;
    this.loadMs = null;
    this.evaluations = 0;
    this.queue = Promise.resolve();
  }

  status() {
    return {
      state: this.state,
      model_path: this.config.model_path,
      gpu: this.gpu,
      load_ms: this.loadMs,
      evaluations: this.evaluations,
      error: this.error ? this.error.message : null,
    };
  }

  load() {
    if (this.state === 'disabled') return Promise.reject(new CortexError('JEV_DISABLED', 'The Jev engine is disabled (jev.enabled = false).'));
    if (this.state === 'ready') return Promise.resolve(this);
    if (this.loading) return this.loading;
    if (this.state === 'error' && Date.now() - this.failedAt < RETRY_LOAD_AFTER_MS) return Promise.reject(this.error);
    this.state = 'loading';
    const generation = this.generation;
    this.loading = withTimeout(this.loadModel(generation), this.config.load_timeout_ms, 'Jev model load')
      .then(() => {
        this.state = 'ready';
        this.error = null;
        return this;
      })
      .catch((err) => {
        this.generation++; // a late-finishing load disposes itself
        this.state = 'error';
        this.error = err;
        this.failedAt = Date.now();
        throw err;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async loadModel(generation) {
    const t0 = performance.now();
    const modelPath = this.config.model_path;
    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new CortexError('JEV_MODEL_MISSING', `Model file not found: ${modelPath}. Run \`cortex model pull\`.`);
    }
    let nlc;
    try {
      nlc = await import('node-llama-cpp');
    } catch (err) {
      throw new CortexError('JEV_RUNTIME_MISSING', `node-llama-cpp is not installed (${err.message}). Run \`npm install\` in the cortex-local folder.`);
    }
    // llama.cpp logs go through our stderr logger: stdout belongs to the MCP transport.
    const logger = (level, message) => {
      const text = String(message ?? '').trim();
      if (!text) return;
      if (level === 'fatal' || level === 'error') log.warn(`llama.cpp: ${text}`);
      else log.debug(`llama.cpp: ${text}`);
    };
    const open = async (gpu) => {
      const llama = await nlc.getLlama({ gpu, build: 'never', progressLogs: false, logLevel: nlc.LlamaLogLevel.warn, logger });
      try {
        const model = await llama.loadModel({ modelPath });
        try {
          const context = await model.createContext({
            contextSize: this.config.context_size,
            batchSize: this.config.batch_size,
            sequences: 1,
          });
          return { llama, model, context };
        } catch (err) {
          await model.dispose().catch(() => {});
          throw err;
        }
      } catch (err) {
        await llama.dispose().catch(() => {});
        throw err;
      }
    };
    let loaded;
    try {
      loaded = await open(this.config.gpu);
    } catch (err) {
      if (this.config.gpu === false) throw err;
      log.warn(`Jev: GPU initialisation failed (${err.message}); retrying on CPU`);
      loaded = await open(false);
    }
    if (generation !== this.generation) {
      await disposeAll([loaded.context, loaded.model, loaded.llama]);
      throw new CortexError('JEV_LOAD_ABANDONED', 'Model load finished after it was cancelled.');
    }
    this.llama = loaded.llama;
    this.model = loaded.model;
    this.context = loaded.context;
    this.sequence = loaded.context.getSequence();
    this.tokens = new TokenCache(loaded.model);
    this.tokens.warm();
    this.gpu = loaded.llama.gpu || 'cpu';
    this.loadMs = Math.round(performance.now() - t0);
    log.info(`Jev engine ready: ${path.basename(modelPath)} on ${this.gpu} in ${this.loadMs}ms`);
  }

  /**
   * Run a primitive. Serialized: the single sequence cannot evaluate concurrently.
   * @param {{primitive: 'noul'|'choice'|'score', state: string, question: string, criteria: Record<string,string>, temperature?: number}} params
   */
  evaluate(params) {
    const run = () => this.runEvaluation(params);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    const budget = this.config.timeout_ms + (this.state === 'ready' ? 0 : this.config.load_timeout_ms);
    return withTimeout(result, budget, 'Jev evaluation');
  }

  async runEvaluation({ primitive, state, question, criteria, temperature }) {
    const spec = prepare(primitive, criteria);
    const q = String(question ?? '').trim();
    if (!q) throw new CortexError('JEV_BAD_QUESTION', 'question is required.');
    if (q.length > MAX_QUESTION_CHARS) throw new CortexError('JEV_BAD_QUESTION', `question exceeds ${MAX_QUESTION_CHARS} characters.`);
    if (spec.rubric.length > MAX_CRITERIA_CHARS) throw new CortexError('JEV_BAD_CRITERIA', `criteria exceed ${MAX_CRITERIA_CHARS} characters.`);
    await this.load();
    const answer = this.tokens.resolve(spec.candidates);
    const prompt = this.encode(TYPE_NAMES[primitive], String(state ?? ''), q, spec.rubric, answer.suffix);
    const candidateIds = [...new Set(answer.ids.flat())];
    const t0 = performance.now();
    const logits = await this.forward(prompt, candidateIds);
    const latency = round(performance.now() - t0, 1);
    // z_eff(C) = ln(e^z(C) + e^z(" C")): immune to tokenizer whitespace shifts.
    const effective = answer.ids.map((ids) => logSumExp(ids.map((id) => logits.get(id) ?? -Infinity)));
    const calibration = Number.isFinite(temperature) && temperature > 0 ? temperature : this.config.temperature;
    const probabilities = stableSoftmax(effective, calibration);
    this.evaluations++;
    return { ...spec.finish(probabilities), latency_ms: latency, prompt_tokens: prompt.length };
  }

  /** ChatML prompt → tokens. User-supplied text is tokenized without special tokens (no injection). */
  encode(typeName, state, question, rubric, suffix) {
    const tok = (text, special) => this.model.tokenize(text, special);
    const head = tok(`<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n[STATE]\n`, true);
    const mid = tok(`\n[QUESTION]\nType: ${typeName}\n`, true);
    const query = tok(`${question}\nCriteria:\n${rubric}`, false);
    const tail = tok('\n<|im_end|>\n<|im_start|>assistant\n', true);
    const answer = tok(suffix, false);
    const t = this.model.tokens;
    const bos = t.shouldPrependBosToken && t.bos != null ? [t.bos] : [];
    const fixed = bos.length + head.length + mid.length + query.length + tail.length + answer.length;
    const budget = this.sequence.contextSize - fixed - 8;
    if (budget < 32) throw new CortexError('JEV_PROMPT_TOO_LONG', 'question and criteria leave no room for the state; shorten them.');
    let stateTokens = tok(excerpt(state, MAX_STATE_CHARS), false);
    if (stateTokens.length > budget) {
      const marker = tok('\n...[truncated]...\n', false);
      const keep = Math.max(0, budget - marker.length);
      const headCount = Math.ceil(keep * 0.6);
      stateTokens = [...stateTokens.slice(0, headCount), ...marker, ...stateTokens.slice(stateTokens.length - (keep - headCount))];
    }
    return [...bos, ...head, ...stateTokens, ...mid, ...query, ...tail, ...answer];
  }

  /** Single prefill pass; returns Map<token, logit> for the candidate tokens at the last position. */
  async forward(tokens, candidateIds) {
    const sequence = this.sequence;
    await sequence.clearHistory();
    try {
      const last = tokens.length - 1;
      const input = tokens.slice(0, last);
      input.push([tokens[last], { generateNext: { logits: { filter: { tokens: candidateIds } } } }]);
      const output = await sequence.controlledEvaluate(input);
      const logits = output[last]?.next?.logits;
      if (!logits || !logits.size) throw new CortexError('JEV_NO_LOGITS', 'The model returned no logits for the answer tokens.');
      return new Map(logits);
    } finally {
      await sequence.clearHistory().catch(() => {});
    }
  }

  async dispose() {
    this.generation++;
    await withTimeout(this.queue, 5000, 'Jev queue drain').catch(() => {});
    const resources = [this.context, this.model, this.llama];
    this.sequence = null;
    this.context = null;
    this.model = null;
    this.llama = null;
    this.tokens = null;
    if (this.state === 'ready') this.state = 'idle';
    await disposeAll(resources);
  }
}

async function disposeAll(resources) {
  for (const r of resources) {
    if (r) await r.dispose().catch(() => {});
  }
}
