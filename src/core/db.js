import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';

/** better-sqlite3 only binds numbers, strings, bigints, buffers and null. */
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Thin wrapper over a better-sqlite3 connection: WAL mode, busy timeout, schema migration and
 * a prepared-statement cache. better-sqlite3 is synchronous, so every write issued by this
 * process is naturally serialized; WAL + busy_timeout covers concurrent processes (CLI + server).
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.db = new Database(file);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('temp_store = MEMORY');
    this.statements = new Map();
    this.migrate();
  }

  migrate() {
    const target = MIGRATIONS.length;
    if (this.db.pragma('user_version', { simple: true }) >= target) return;
    // IMMEDIATE transaction + re-check: a concurrent process (CLI vs server) cannot apply twice.
    const apply = this.db.transaction(() => {
      const version = this.db.pragma('user_version', { simple: true });
      for (let v = version; v < target; v++) this.db.exec(MIGRATIONS[v]);
      this.db.pragma(`user_version = ${target}`);
    });
    apply.immediate();
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params.map(bindable));
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params.map(bindable));
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params.map(bindable));
  }

  /** Run fn inside a transaction (nested calls become savepoints). fn must be synchronous. */
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  exec(sql) {
    this.db.exec(sql);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
