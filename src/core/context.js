import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './db.js';
import { loadConfig } from './config.js';
import { configureLogger, log } from './logger.js';
import { ensureDir, findProjectRoot, globalDbPath, projectIdFor, realpath, resolvePaths } from './paths.js';
import { uuid } from './util.js';
import { createEngines } from '../engines/index.js';

const INSERT_PROJECT = 'INSERT OR IGNORE INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)';

/**
 * Build the runtime context shared by every engine: project root, config, the project DB and a
 * lazily opened global DB (cross-project preferences). Without a detectable project root the
 * context runs in "global mode": memory/checkpoints work, code search is unavailable.
 */
export function createContext({ cwd = process.cwd(), root: explicitRoot = null, mode = 'server', logLevel = null } = {}) {
  const root = explicitRoot ? realpath(path.resolve(explicitRoot)) : findProjectRoot(cwd);
  const { dataDir, dbPath } = resolvePaths(root);
  ensureDir(dataDir);
  ensureDir(path.dirname(dbPath));

  const config = loadConfig(root ? dataDir : null);
  configureLogger({
    level: logLevel ?? (mode === 'server' ? config.log_level : 'warn'),
    file: mode === 'server' && root && config.log_to_file ? path.join(dataDir, 'cortex.log') : null,
  });

  const db = new Store(dbPath);
  const projectId = projectIdFor(root);
  const projectName = root ? path.basename(root) : 'global';
  db.run(INSERT_PROJECT, projectId, projectName, root ?? os.homedir(), Date.now());

  let globalStore; // undefined: not opened yet; null: unavailable
  const ctx = {
    root,
    projectId,
    projectName,
    dataDir,
    dbPath,
    config,
    db,
    mode,
    sessionId: uuid(),
    startedAt: Date.now(),
    engines: null,
    jev: null, // JevEngine, attached by the MCP server (absent in short-lived CLI contexts)

    /** Global (cross-project) memory store: { db, projectId } or null when unavailable. */
    getGlobal() {
      if (!root) return { db, projectId };
      if (globalStore === undefined) {
        try {
          const file = globalDbPath();
          if (path.resolve(file) === path.resolve(dbPath)) {
            globalStore = db;
          } else {
            ensureDir(path.dirname(file));
            globalStore = new Store(file);
          }
          globalStore.run(INSERT_PROJECT, 'global', 'global', os.homedir(), Date.now());
        } catch (err) {
          log.warn(`global memory store unavailable: ${err.message}`);
          globalStore = null;
        }
      }
      return globalStore ? { db: globalStore, projectId: 'global' } : null;
    },

    close() {
      if (globalStore && globalStore !== db) globalStore.close();
      db.close();
    },
  };
  ctx.engines = createEngines(ctx);
  return ctx;
}
