import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chunkSource } from './chunker.js';
import { discoverFiles, isBinaryBuffer, looksMinified } from './files.js';
import { gitState } from '../core/git.js';
import { log } from '../core/logger.js';
import { getMeta, setMeta } from '../core/meta.js';
import { scrubSecrets } from '../core/secrets.js';
import { decomposeIdentifiers, pathTerms, splitIdentifier } from '../core/tokenize.js';
import { CortexError, sha256, yieldToEventLoop } from '../core/util.js';

const INSERT_CHUNK = `INSERT INTO code_chunks
  (project_id, file_path, file_hash, language, symbol_type, symbol_name, parent_symbol, start_line, end_line, chunk_hash, decomposed_tokens, content)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_FILE = `INSERT INTO indexed_files (project_id, file_path, mtime_ms, size, file_hash, language, chunk_count, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_id, file_path) DO UPDATE SET
    mtime_ms = excluded.mtime_ms, size = excluded.size, file_hash = excluded.file_hash,
    language = excluded.language, chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at`;

/**
 * Subsystem C: incremental indexer. mtime+size short-circuit, then SHA-256 content check; only
 * changed files are re-chunked, each batch in a single transaction. Batches yield to the event
 * loop so the MCP server keeps answering requests while a large repository is being indexed.
 */
export class Indexer {
  constructor(ctx) {
    this.ctx = ctx;
    this.running = null;
    this.progress = null;
  }

  get lastSyncAt() {
    return Number(getMeta(this.ctx, 'last_sync_at') ?? 0);
  }

  stats() {
    const { db, projectId } = this.ctx;
    const files = db.get('SELECT COUNT(*) AS n FROM indexed_files WHERE project_id = ?', projectId).n;
    const chunks = db.get('SELECT COUNT(*) AS n FROM code_chunks WHERE project_id = ?', projectId).n;
    return { files, chunks, last_sync_at: this.lastSyncAt, warming: this.running ? { ...this.progress } : null };
  }

  /** Run (or join) an index sync. Concurrent callers share the in-flight run. */
  sync(options = {}) {
    if (!this.ctx.root) {
      return Promise.reject(new CortexError('NO_PROJECT', 'No project root detected. Run Codex inside a repository or set CORTEX_PROJECT_ROOT.'));
    }
    if (this.running) {
      if (options.force && !this.running.force) return this.running.promise.then(() => this.sync(options));
      return this.running.promise;
    }
    const promise = this.runSync(options).finally(() => {
      this.running = null;
      this.progress = null;
    });
    this.running = { promise, force: !!options.force };
    return promise;
  }

  /** Make sure the index is reasonably fresh before a search. Never blocks on an in-flight warm-up. */
  async ensureFresh() {
    if (!this.ctx.root) return { available: false };
    if (this.running) return { available: true, warming: { ...this.progress } };
    const last = this.lastSyncAt;
    const interval = this.ctx.config.index.auto_sync_interval_sec * 1000;
    if (!last || (interval > 0 && Date.now() - last > interval)) {
      await this.sync({ reason: last ? 'stale' : 'first-use' });
      return { available: true, synced: true };
    }
    return { available: true };
  }

  async runSync({ force = false, reason = 'manual' } = {}) {
    const { db, root, projectId, config } = this.ctx;
    const t0 = performance.now();
    const discovery = discoverFiles(root, config);
    const files = discovery.files;
    const existing = new Map(
      db.all('SELECT file_path, mtime_ms, size, file_hash FROM indexed_files WHERE project_id = ?', projectId).map((r) => [r.file_path, r]),
    );
    const stats = {
      reason,
      source: discovery.source,
      forced: !!force,
      discovered: files.length,
      scanned: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      pruned: 0,
      skipped: 0,
      excluded: discovery.excluded,
      sensitive_excluded: discovery.sensitive,
      chunks_written: 0,
      memories_flagged: 0,
      duration_ms: 0,
    };
    const changedForMemory = [];
    const present = new Set();

    if (force) {
      db.transaction(() => {
        db.run('DELETE FROM code_chunks WHERE project_id = ?', projectId);
        db.run('DELETE FROM indexed_files WHERE project_id = ?', projectId);
      });
      existing.clear();
    }

    const batchSize = config.index.batch_size;
    this.progress = { done: 0, total: files.length };
    for (let offset = 0; offset < files.length; offset += batchSize) {
      const batch = files.slice(offset, offset + batchSize);
      db.transaction(() => {
        for (const rel of batch) this.indexOne(rel, existing.get(rel), { stats, present, changedForMemory, force });
      });
      this.progress = { done: Math.min(files.length, offset + batch.length), total: files.length };
      await yieldToEventLoop();
    }

    const removed = [...existing.keys()].filter((p) => !present.has(p));
    if (removed.length) {
      db.transaction(() => {
        for (const rel of removed) this.removeFile(rel);
      });
      stats.pruned = removed.length;
      changedForMemory.push(...removed);
    }

    if (stats.added + stats.updated + stats.pruned > 500) {
      try {
        db.run("INSERT INTO code_search_index (code_search_index) VALUES ('optimize')");
      } catch (err) {
        log.debug(`fts optimize skipped: ${err.message}`);
      }
    }

    if (changedForMemory.length) {
      try {
        stats.memories_flagged = this.ctx.engines.memory.flagStale(changedForMemory);
      } catch (err) {
        log.warn(`memory staleness check failed: ${err.message}`);
      }
    }

    const git = gitState(root);
    setMeta(this.ctx, 'last_sync_at', Date.now());
    setMeta(this.ctx, 'git_head', git.head);
    setMeta(this.ctx, 'git_branch', git.branch);
    stats.duration_ms = Math.round(performance.now() - t0);
    this.ctx.engines.telemetry.record('index_sync', { latency_ms: stats.duration_ms, meta: stats });
    return stats;
  }

  indexOne(rel, prev, { stats, present, changedForMemory, force }) {
    const { db, root, projectId, config } = this.ctx;
    stats.scanned++;
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return; // deleted (still listed by git) → pruned below
    }
    if (!st.isFile()) return;
    if (st.size > config.index.max_file_bytes) {
      stats.skipped++;
      return;
    }
    const mtime = Math.floor(st.mtimeMs);
    if (!force && prev && prev.mtime_ms === mtime && prev.size === st.size) {
      present.add(rel);
      stats.unchanged++;
      return;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return;
    }
    if (isBinaryBuffer(buf)) {
      stats.skipped++;
      return;
    }
    const fileHash = sha256(buf);
    if (!force && prev && prev.file_hash === fileHash) {
      db.run('UPDATE indexed_files SET mtime_ms = ?, size = ? WHERE project_id = ? AND file_path = ?', mtime, st.size, projectId, rel);
      present.add(rel);
      stats.unchanged++;
      return;
    }
    const text = buf.toString('utf8');
    if (looksMinified(text)) {
      stats.skipped++;
      return;
    }
    const { language, chunks } = chunkSource(text, rel, {
      maxChunkLines: config.index.max_chunk_lines,
      smallContainerLines: config.index.small_container_lines,
      windowLines: config.index.window_lines,
    });
    db.run('DELETE FROM code_chunks WHERE project_id = ? AND file_path = ?', projectId, rel);
    const relTerms = pathTerms(rel);
    for (const chunk of chunks) {
      const content = scrubSecrets(chunk.content, { strict: true }).text;
      const tokens = new Set([...splitIdentifier(chunk.symbol_name ?? ''), ...relTerms, ...decomposeIdentifiers(content, { limit: 300 })]);
      if (chunk.parent_symbol) {
        for (const word of chunk.parent_symbol.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
          tokens.add(word.toLowerCase());
          for (const part of splitIdentifier(word)) tokens.add(part);
        }
      }
      db.run(
        INSERT_CHUNK,
        projectId,
        rel,
        fileHash,
        language,
        chunk.symbol_type,
        chunk.symbol_name,
        chunk.parent_symbol,
        chunk.start_line,
        chunk.end_line,
        sha256(content).slice(0, 24),
        [...tokens].join(' '),
        content,
      );
      stats.chunks_written++;
    }
    db.run(UPSERT_FILE, projectId, rel, mtime, st.size, fileHash, language, chunks.length, Date.now());
    present.add(rel);
    if (prev) {
      stats.updated++;
      changedForMemory.push(rel);
    } else {
      stats.added++;
    }
  }

  removeFile(rel) {
    const { db, projectId } = this.ctx;
    db.run('DELETE FROM code_chunks WHERE project_id = ? AND file_path = ?', projectId, rel);
    db.run('DELETE FROM indexed_files WHERE project_id = ? AND file_path = ?', projectId, rel);
  }
}
