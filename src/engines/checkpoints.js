import fs from 'node:fs';
import path from 'node:path';
import { gitState, gitStatus } from '../core/git.js';
import { normalizeRelPaths } from '../core/paths.js';
import { scrubSecrets } from '../core/secrets.js';
import { CortexError, safe, safeJsonParse, truncate, uuid } from '../core/util.js';

const AUTO_DEDUPE_MS = 2 * 60 * 1000;

function fileStatus(root, rel, since) {
  if (!root) return { path: rel, exists: null, modified_since_checkpoint: null };
  try {
    const st = fs.statSync(path.join(root, rel));
    return { path: rel, exists: true, modified_since_checkpoint: st.mtimeMs > since };
  } catch {
    return { path: rel, exists: false, modified_since_checkpoint: false };
  }
}

function summarize(row) {
  const state = safeJsonParse(row.state_payload, {});
  return {
    id: row.id,
    kind: row.kind,
    goal: row.goal,
    next_step: state.next_step ?? null,
    trigger: state.trigger ?? null,
    created_at: row.created_at,
  };
}

/** Subsystem D: task checkpoints and the post-compaction recovery pack. */
export class CheckpointEngine {
  constructor(ctx) {
    this.ctx = ctx;
  }

  save({ goal, files_touched = [], current_errors = null, next_step = null, decisions = [], notes = null, session_id = null, kind = 'manual', trigger = 'manual', command = null } = {}) {
    const { db, projectId, root } = this.ctx;
    let redactions = 0;
    const clean = (value) => {
      if (value == null || value === '') return null;
      const r = scrubSecrets(String(value));
      redactions += r.count;
      return r.text;
    };
    const files = normalizeRelPaths(files_touched, root);
    const git = root ? gitState(root) : { branch: null, head: null };
    const state = {
      current_errors: clean(current_errors),
      next_step: clean(next_step),
      decisions: (decisions ?? []).map(clean).filter(Boolean),
      notes: clean(notes),
      trigger,
      command: command ?? null,
      git,
    };
    const id = uuid();
    const now = Date.now();
    db.run(
      'INSERT INTO checkpoints (id, project_id, session_id, kind, goal, files_touched, state_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      projectId,
      session_id ?? this.ctx.sessionId,
      kind,
      clean(goal) ?? '(no goal stated)',
      JSON.stringify(files),
      JSON.stringify(state),
      now,
    );
    this.prune();
    this.ctx.engines.telemetry.record('checkpoint_save', { meta: { kind, trigger } });
    return { id, kind, created_at: now, files: files.length, redactions, git };
  }

  /** Snapshot written automatically when a test command fails (via `cortex run`). */
  autoSnapshot({ command, errorText }) {
    const { db, projectId } = this.ctx;
    const errors = scrubSecrets(truncate(errorText ?? '', 1500)).text;
    const lastAuto = db.get("SELECT state_payload, created_at FROM checkpoints WHERE project_id = ? AND kind = 'auto' ORDER BY created_at DESC LIMIT 1", projectId);
    if (lastAuto && Date.now() - lastAuto.created_at < AUTO_DEDUPE_MS && safeJsonParse(lastAuto.state_payload, {}).current_errors === errors) return null;
    const base = db.get("SELECT * FROM checkpoints WHERE project_id = ? AND kind = 'manual' ORDER BY created_at DESC LIMIT 1", projectId);
    const baseState = base ? safeJsonParse(base.state_payload, {}) : {};
    return this.save({
      goal: base?.goal ?? `Fix failing command: ${command}`,
      files_touched: base ? safeJsonParse(base.files_touched, []) : [],
      current_errors: errors,
      next_step: baseState.next_step ?? `Investigate the failure of \`${command}\``,
      decisions: baseState.decisions ?? [],
      kind: 'auto',
      trigger: 'test_failure',
      command,
    });
  }

  prune() {
    const { db, projectId, config } = this.ctx;
    db.run(
      'DELETE FROM checkpoints WHERE project_id = ? AND id NOT IN (SELECT id FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT ?)',
      projectId,
      projectId,
      config.retention.checkpoints_keep,
    );
  }

  findById(idOrPrefix) {
    const prefix = String(idOrPrefix ?? '').trim().replace(/[^0-9a-fA-F-]/g, '');
    if (prefix.length < 4) throw new CortexError('BAD_ID', 'checkpoint_id must be an id or a prefix of at least 4 characters.');
    const rows = this.ctx.db.all('SELECT * FROM checkpoints WHERE project_id = ? AND id LIKE ? LIMIT 2', this.ctx.projectId, `${prefix}%`);
    if (rows.length > 1) throw new CortexError('AMBIGUOUS_ID', `Checkpoint prefix "${prefix}" is ambiguous.`);
    if (!rows.length) throw new CortexError('NOT_FOUND', `No checkpoint matches "${prefix}".`);
    return rows[0];
  }

  /**
   * Recovery pack: the checkpoint plus live state that may have changed since it was written
   * (git, files, newer failures, recent evictions, dead ends, contested memories).
   */
  resume({ checkpoint_id = null, list = false } = {}) {
    const { db, projectId, root, engines } = this.ctx;
    if (list) {
      const rows = db.all('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT 15', projectId);
      return { mode: 'list', checkpoints: rows.map(summarize) };
    }
    const cp = checkpoint_id
      ? this.findById(checkpoint_id)
      : db.get("SELECT * FROM checkpoints WHERE project_id = ? AND kind = 'manual' ORDER BY created_at DESC LIMIT 1", projectId)
        ?? db.get('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', projectId)
        ?? null;
    const since = cp ? cp.created_at : Date.now() - 24 * 3600 * 1000;
    const state = cp ? safeJsonParse(cp.state_payload, {}) : {};
    const newerAuto = cp
      ? db.get("SELECT * FROM checkpoints WHERE project_id = ? AND kind = 'auto' AND created_at > ? ORDER BY created_at DESC LIMIT 1", projectId, cp.created_at)
      : null;
    const newerState = newerAuto ? safeJsonParse(newerAuto.state_payload, {}) : null;
    const counts = db.get(
      'SELECT COALESCE(SUM(is_contested), 0) AS contested, COALESCE(SUM(needs_verification), 0) AS stale FROM memories WHERE project_id = ?',
      projectId,
    );
    const pack = {
      mode: 'resume',
      found: !!cp,
      checkpoint: cp
        ? {
          id: cp.id,
          kind: cp.kind,
          session_id: cp.session_id,
          goal: cp.goal,
          next_step: state.next_step ?? null,
          current_errors: state.current_errors ?? null,
          decisions: state.decisions ?? [],
          notes: state.notes ?? null,
          git_then: state.git ?? null,
          created_at: cp.created_at,
        }
        : null,
      newer_failure: newerAuto
        ? { id: newerAuto.id, command: newerState.command ?? null, errors: newerState.current_errors ?? null, created_at: newerAuto.created_at }
        : null,
      files: cp ? safeJsonParse(cp.files_touched, []).map((f) => fileStatus(root, f, cp.created_at)) : [],
      git: root ? { ...gitState(root), status: gitStatus(root, 15) } : null,
      recent_evictions: safe(() => engines.evicted.recent({ since: since - 10 * 60 * 1000, limit: 3 }), []),
      open_investigations: safe(() => engines.investigations.recent({ since: since - 24 * 3600 * 1000, outcomes: ['dead_end', 'in_progress'], limit: 5 }), []),
      task_memories: safe(() => engines.memory.query({ query: '', category: 'task', limit: 3, include_global: false, min_confidence: 0 }).memories, []),
      contested_memories: counts.contested,
      stale_memories: counts.stale,
    };
    engines.telemetry.record('checkpoint_resume', { hit: !!cp });
    return pack;
  }
}
