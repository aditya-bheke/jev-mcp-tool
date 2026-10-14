/** Small per-project key/value store (last sync time, git head, ...). */
export function getMeta(ctx, key) {
  const row = ctx.db.get('SELECT value FROM meta WHERE project_id = ? AND key = ?', ctx.projectId, key);
  return row ? row.value : null;
}

export function setMeta(ctx, key, value) {
  ctx.db.run(
    `INSERT INTO meta (project_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ctx.projectId,
    key,
    value == null ? null : String(value),
    Date.now(),
  );
}
