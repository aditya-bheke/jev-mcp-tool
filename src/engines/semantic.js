import { log } from '../core/logger.js';
import { round } from '../core/util.js';

function encode(vector) {
  const buf = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4);
  return buf;
}

function decode(buf) {
  const out = new Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Optional local neural reranker (Section 10.1): re-orders the top BM25 candidates with an
 * Ollama embedding model on localhost. Embeddings are cached per chunk hash. Any failure
 * (Ollama not running, model missing, timeout) silently falls back to pure BM25 for 60s.
 */
export class SemanticReranker {
  constructor(ctx) {
    this.ctx = ctx;
    this.disabledUntil = 0;
  }

  async embed(texts) {
    const { url, model, timeout_ms: timeoutMs } = this.ctx.config.semantic;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(new URL('/api/embed', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts, truncate: true }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) throw new Error('unexpected embedding response');
      return json.embeddings;
    } finally {
      clearTimeout(timer);
    }
  }

  async rerank(query, rows) {
    const cfg = this.ctx.config.semantic;
    if (!cfg.enabled || Date.now() < this.disabledUntil || !rows.length) return null;
    try {
      const { db } = this.ctx;
      const vectors = new Map();
      for (const r of rows) {
        if (vectors.has(r.chunk_hash)) continue;
        const cached = db.get('SELECT vector FROM chunk_embeddings WHERE chunk_hash = ? AND model = ?', r.chunk_hash, cfg.model);
        if (cached) vectors.set(r.chunk_hash, decode(cached.vector));
      }
      const missing = [...new Map(rows.filter((r) => !vectors.has(r.chunk_hash)).map((r) => [r.chunk_hash, r])).values()];
      const inputs = [
        `search_query: ${query}`,
        ...missing.map((r) => `search_document: ${r.file_path} ${r.symbol_name ?? ''}\n${r.content.slice(0, 2000)}`),
      ];
      const embeddings = await this.embed(inputs);
      const queryVector = embeddings[0];
      missing.forEach((r, i) => {
        const vector = embeddings[i + 1];
        vectors.set(r.chunk_hash, vector);
        try {
          db.run(
            'INSERT OR REPLACE INTO chunk_embeddings (chunk_hash, model, dims, vector, created_at) VALUES (?, ?, ?, ?, ?)',
            r.chunk_hash,
            cfg.model,
            vector.length,
            encode(vector),
            Date.now(),
          );
        } catch (err) {
          log.debug(`embedding cache write failed: ${err.message}`);
        }
      });
      const maxLexical = Math.max(...rows.map((r) => r.score), 1e-9);
      const w = cfg.weight;
      return rows
        .map((r) => {
          const sim = cosine(queryVector, vectors.get(r.chunk_hash));
          return { ...r, semantic: round(sim, 3), score: round((1 - w) * (r.score / maxLexical) + w * sim, 4) };
        })
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      this.disabledUntil = Date.now() + 60_000;
      log.warn(`semantic rerank unavailable, using BM25 only: ${err.message}`);
      return null;
    }
  }
}
