import { log } from '../core/logger.js';
import { percentile, round, safeJsonParse } from '../core/util.js';

/** Subsystem I: local-only telemetry and token accounting. Writes never throw. */
export class Telemetry {
  constructor(ctx) {
    this.ctx = ctx;
  }

  record(eventType, { tool = null, latency_ms = null, input_chars = null, output_chars = null, tokens_saved = null, hit = null, meta = null } = {}) {
    try {
      this.ctx.db.run(
        `INSERT INTO telemetry_events (project_id, event_type, tool, latency_ms, input_chars, output_chars, tokens_saved, hit, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.ctx.projectId,
        eventType,
        tool,
        latency_ms == null ? null : round(latency_ms, 2),
        input_chars,
        output_chars,
        tokens_saved == null ? null : Math.round(tokens_saved),
        hit == null ? null : hit ? 1 : 0,
        meta ? JSON.stringify(meta) : null,
        Date.now(),
      );
    } catch (err) {
      log.debug(`telemetry write failed: ${err.message}`);
    }
  }

  prune(days) {
    try {
      this.ctx.db.run('DELETE FROM telemetry_events WHERE project_id = ? AND created_at < ?', this.ctx.projectId, Date.now() - days * 86_400_000);
    } catch (err) {
      log.debug(`telemetry prune failed: ${err.message}`);
    }
  }

  summary({ days = 7 } = {}) {
    const { db, projectId } = this.ctx;
    const since = Date.now() - days * 86_400_000;
    const rows = db.all(
      'SELECT event_type, tool, latency_ms, input_chars, output_chars, tokens_saved, hit, meta FROM telemetry_events WHERE project_id = ? AND created_at >= ?',
      projectId,
      since,
    );
    const by = (type) => rows.filter((r) => r.event_type === type);
    const sum = (list, key) => list.reduce((acc, r) => acc + (r[key] ?? 0), 0);
    const rate = (list) => (list.length ? round(list.filter((r) => r.hit === 1).length / list.length, 3) : null);
    const latency = (list) => {
      const values = list.map((r) => r.latency_ms).filter((v) => v != null);
      return {
        avg_ms: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 1) : null,
        p95_ms: values.length ? round(percentile(values, 95), 1) : null,
      };
    };

    const toolGroups = new Map();
    for (const r of by('tool_call')) {
      if (!toolGroups.has(r.tool)) toolGroups.set(r.tool, []);
      toolGroups.get(r.tool).push(r);
    }
    const tools = [...toolGroups.entries()]
      .map(([tool, list]) => ({ tool, calls: list.length, ...latency(list), output_tokens: Math.round(sum(list, 'output_chars') / 4) }))
      .sort((a, b) => b.calls - a.calls);

    const searches = by('search');
    const strategies = {};
    for (const r of searches) {
      const strategy = safeJsonParse(r.meta, {}).strategy ?? 'unknown';
      strategies[strategy] = (strategies[strategy] ?? 0) + 1;
    }
    const evictions = by('eviction');
    const fetches = by('evicted_fetch');
    const evictionSaved = sum(evictions, 'tokens_saved');
    const restored = Math.round(sum(fetches, 'output_chars') / 4);
    const triages = by('jev_triage');
    const triageMeta = triages.map((r) => safeJsonParse(r.meta, {}));
    const pKeeps = triageMeta.map((m) => m.p_keep).filter((v) => Number.isFinite(v));
    const modes = {};
    for (const m of triageMeta) if (m.mode) modes[m.mode] = (modes[m.mode] ?? 0) + 1;
    const memoryQueries = by('memory_query');
    const checks = by('investigation_check');
    const memoryCounts = db.get(
      'SELECT COUNT(*) AS total, COALESCE(SUM(is_contested), 0) AS contested, COALESCE(SUM(needs_verification), 0) AS stale FROM memories WHERE project_id = ?',
      projectId,
    );
    const checkpointCount = db.get('SELECT COUNT(*) AS n FROM checkpoints WHERE project_id = ? AND created_at >= ?', projectId, since).n;

    return {
      project: this.ctx.projectName,
      window_days: days,
      eviction: {
        count: evictions.length,
        input_tokens: Math.round(sum(evictions, 'input_chars') / 4),
        stub_tokens: Math.round(sum(evictions, 'output_chars') / 4),
        tokens_saved: evictionSaved,
        fetches: fetches.length,
        tokens_restored: restored,
        net_tokens_saved: evictionSaved - restored,
      },
      search: {
        queries: searches.length,
        hit_rate: rate(searches),
        ...latency(searches),
        tokens_saved_vs_full_reads: sum(searches, 'tokens_saved'),
        strategies,
      },
      memory: {
        queries: memoryQueries.length,
        hit_rate: rate(memoryQueries),
        saves: by('memory_save').length,
        total: memoryCounts.total,
        contested: memoryCounts.contested,
        stale: memoryCounts.stale,
      },
      investigations: { checks: checks.length, prior_work_found: checks.filter((r) => r.hit === 1).length },
      checkpoints: { saved: checkpointCount, resumes: by('checkpoint_resume').length },
      jev: {
        triages: triages.length,
        avg_p_keep: pKeeps.length ? round(pKeeps.reduce((a, b) => a + b, 0) / pKeeps.length, 4) : null,
        ...latency(triages),
        modes,
      },
      tools,
      tool_errors: by('tool_error').length,
      index: this.ctx.root ? this.ctx.engines.indexer.stats() : null,
      bench: by('bench').slice(-5).map((r) => safeJsonParse(r.meta, {})),
    };
  }
}
