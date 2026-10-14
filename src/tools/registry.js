import { S, compileParams } from './schema.js';
import * as R from './render.js';
import { MANAGE_ACTIONS, MEMORY_CATEGORIES, SOURCE_TYPES } from '../engines/memory.js';
import { OUTCOMES } from '../engines/investigations.js';

// Section 5: the MCP tool catalog. Descriptions are short on purpose: every tool schema is paid
// for in context on every turn.

const DEFINITIONS = [
  {
    name: 'cortex_search_code',
    description:
      'Ranked local code search (BM25 over structural chunks, camelCase/snake_case aware). Returns top snippets with file:line ranges instead of whole files. Use for concepts and unfamiliar symbols; use rg for exact strings.',
    annotations: { title: 'Search code', readOnlyHint: true },
    params: {
      query: S.string('Natural-language description, identifier, or code fragment.', { required: true, min: 1, max: 500 }),
      symbol_only: S.boolean('Only declarations (classes, functions, methods, types, tests).'),
      path_filter: S.string('Restrict to a sub-path (e.g. "src/api") or glob (e.g. "**/*.test.ts").', { max: 300 }),
      max_results: S.integer('Number of snippets (default 5).', { min: 1, max: 20 }),
    },
    handler: async (ctx, a) => {
      const data = await ctx.engines.search.search(a);
      return { data, text: R.renderSearch(data) };
    },
  },
  {
    name: 'cortex_index_sync',
    description:
      'Incrementally re-index added/changed/deleted files (mtime + content hash). Normally automatic; call after branch switches or code generation, or with force_full_reindex to rebuild.',
    annotations: { title: 'Sync code index', readOnlyHint: false, idempotentHint: true },
    params: {
      force_full_reindex: S.boolean('Drop and rebuild the whole project index.'),
    },
    handler: async (ctx, a) => {
      const data = await ctx.engines.indexer.sync({ force: !!a.force_full_reindex, reason: 'tool' });
      return { data, text: R.renderIndexSync(data) };
    },
  },
  {
    name: 'cortex_memory_query',
    description:
      'Search durable project memory (architecture, conventions, decisions, fix patterns, task context) plus global preferences. Empty query lists the top memories. Contested/stale entries are flagged.',
    annotations: { title: 'Query memory', readOnlyHint: true },
    params: {
      query: S.string('What you need to know; "" lists top memories.', { required: true, max: 500 }),
      category: S.string('Filter by category.', { values: MEMORY_CATEGORIES }),
      min_confidence: S.number('Minimum confidence (default 0.7).', { min: 0, max: 1 }),
      limit: S.integer('Max results (default 8).', { min: 1, max: 30 }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.memory.query(a);
      return { data, text: R.renderMemoryQuery(data) };
    },
  },
  {
    name: 'cortex_memory_save',
    description:
      'Persist a durable, verified fact (architecture, convention, decision, fix pattern, or task context). Secrets are redacted. A contradiction with a high-confidence memory is flagged instead of overwritten; pass supersedes=<id> to replace deliberately. Agent observations are capped at 0.8 until the user confirms.',
    annotations: { title: 'Save memory', readOnlyHint: false },
    params: {
      title: S.string('Short heading.', { required: true, min: 1, max: 200 }),
      category: S.string('Taxonomy.', { required: true, values: MEMORY_CATEGORIES }),
      content: S.string('The knowledge itself; concise and specific.', { required: true, min: 1, max: 8000 }),
      confidence: S.number('0..1 (default 1.0 for user instructions, 0.8 for agent observations).', { min: 0, max: 1 }),
      source_type: S.string('Origin (default agent_observation). Use user_instruction when the user stated it.', { values: SOURCE_TYPES }),
      scope_paths: S.stringArray('Files/dirs/globs this applies to; confidence decays when they change.', { maxItems: 30, maxLength: 300 }),
      tags: S.stringArray('Optional tags.', { maxItems: 10, maxLength: 40 }),
      supersedes: S.string('Id (or prefix) of a memory this replaces.', { max: 64 }),
      reason: S.string('Why it changed (stored in the version log).', { max: 500 }),
      scope: S.string('project (default) or global (applies to all repositories).', { values: ['project', 'global'] }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.memory.save(a);
      return { data, text: R.renderMemorySave(data) };
    },
  },
  {
    name: 'cortex_memory_manage',
    description:
      'Inspect or repair memories: get (with versions), history (version log; no id = recent changes), verify (user-confirmed: restores confidence, clears stale/contested), rollback (to the state before version_id), delete.',
    annotations: { title: 'Manage memory', readOnlyHint: false },
    params: {
      action: S.string('Operation.', { required: true, values: MANAGE_ACTIONS }),
      id: S.string('Memory id or prefix (get/verify/delete/history).', { max: 64 }),
      version_id: S.integer('Version id from history (rollback).', { min: 1 }),
      confidence: S.number('New confidence for verify (default 1.0).', { min: 0, max: 1 }),
      reason: S.string('Audit note.', { max: 500 }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.memory.manage(a);
      return { data, text: R.renderMemoryManage(data) };
    },
  },
  {
    name: 'cortex_checkpoint_save',
    description:
      'Snapshot the current task (goal, files, open errors, decisions, next step) so work survives context compaction, restarts and new sessions. Save after green tests, before risky edits, and when blocked.',
    annotations: { title: 'Save checkpoint', readOnlyHint: false },
    params: {
      goal: S.string('Active objective.', { required: true, min: 1, max: 2000 }),
      files_touched: S.stringArray('Relative paths modified or under review.', { required: true, maxItems: 100, maxLength: 500 }),
      current_errors: S.string('Open failures/diagnostics (key lines only).', { max: 6000 }),
      next_step: S.string('The concrete next action.', { required: true, min: 1, max: 2000 }),
      decisions: S.stringArray('Decisions made in this session.', { maxItems: 30, maxLength: 500 }),
      notes: S.string('Anything else needed to resume.', { max: 4000 }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.checkpoints.save(a);
      return { data, text: R.renderCheckpointSave(data) };
    },
  },
  {
    name: 'cortex_checkpoint_resume',
    description:
      'Recover the latest (or a given) checkpoint plus live state: git status, files changed since, newer test failures, recent evicted outputs, dead ends and contested memories. Call at session start and after compaction.',
    annotations: { title: 'Resume checkpoint', readOnlyHint: true },
    params: {
      checkpoint_id: S.string('Specific checkpoint id or prefix (default: latest).', { max: 64 }),
      list: S.boolean('List recent checkpoints instead.'),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.checkpoints.resume(a);
      return { data, text: R.renderCheckpointResume(data) };
    },
  },
  {
    name: 'cortex_fetch_evicted',
    description:
      'Restore output that `cortex run` evicted from context. Prefer query (grep with context, /regex/ allowed) or a line range over the full payload.',
    annotations: { title: 'Fetch evicted output', readOnlyHint: true },
    params: {
      hash: S.string('Hash (or 6+ char prefix) from the stub.', { required: true, min: 6, max: 64 }),
      query: S.string('Case-insensitive substring or /regex/ to grep for.', { max: 300 }),
      start_line: S.integer('First line (1-based).', { min: 1 }),
      end_line: S.integer('Last line (inclusive).', { min: 1 }),
      context_lines: S.integer('Context lines around query matches (default 2).', { min: 0, max: 20 }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.evicted.fetch(a);
      return { data, text: R.renderFetch(data) };
    },
  },
  {
    name: 'cortex_investigation_check',
    description:
      'Before attempting a fix, check whether this hypothesis or error was already investigated (dead end, confirmed solution, in progress) and whether a verified fix exists for the error signature.',
    annotations: { title: 'Check investigation ledger', readOnlyHint: true },
    params: {
      hypothesis: S.string('Proposed cause or fix direction.', { required: true, min: 1, max: 2000 }),
      error_text: S.string('Key error lines (enables error-signature matching).', { max: 6000 }),
      limit: S.integer('Max matches (default 5).', { min: 1, max: 20 }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.investigations.check(a);
      return { data, text: R.renderInvestigationCheck(data) };
    },
  },
  {
    name: 'cortex_investigation_log',
    description:
      'Record the outcome of a hypothesis. Confirmed solutions with error_text become reusable fix patterns (signature → fix, diff and files).',
    annotations: { title: 'Log investigation', readOnlyHint: false },
    params: {
      hypothesis: S.string('The hypothesis that was tested.', { required: true, min: 1, max: 2000 }),
      outcome: S.string('Result.', { required: true, values: OUTCOMES }),
      notes: S.string('Evidence and why (short).', { max: 4000 }),
      root_question: S.string('The underlying problem being debugged.', { max: 1000 }),
      inspected_paths: S.stringArray('Files examined.', { maxItems: 50, maxLength: 500 }),
      error_text: S.string('Key error lines.', { max: 6000 }),
      fix_summary: S.string('For confirmed_solution: what fixed it.', { max: 2000 }),
      fix_files: S.stringArray('For confirmed_solution: files changed by the fix.', { maxItems: 30, maxLength: 500 }),
      id: S.string('Existing investigation id to update.', { max: 64 }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.investigations.log(a);
      return { data, text: R.renderInvestigationLog(data) };
    },
  },
  {
    name: 'cortex_route',
    description:
      'One-call orientation for a task: matching skills (open their SKILL.md only if needed), relevant memories, prior investigations, known fixes, code locations and the latest checkpoint.',
    annotations: { title: 'Route task', readOnlyHint: true },
    params: {
      task: S.string('The task or problem statement.', { required: true, min: 1, max: 2000 }),
      max_items: S.integer('Items per section (default 5).', { min: 1, max: 10 }),
    },
    handler: async (ctx, a) => {
      const data = await ctx.engines.router.route(a);
      return { data, text: R.renderRoute(data) };
    },
  },
  {
    name: 'cortex_stats',
    description: 'Local efficiency metrics: tokens saved by eviction and snippets, search hit rate and latency, memory/checkpoint usage.',
    annotations: { title: 'Efficiency stats', readOnlyHint: true },
    params: {
      days: S.integer('Window in days (default 7).', { min: 1, max: 365 }),
    },
    handler: async (ctx, a) => {
      const data = ctx.engines.telemetry.summary({ days: a.days ?? 7 });
      return { data, text: R.renderStats(data) };
    },
  },
];

/** Compile tool definitions: [{ name, description, annotations, inputSchema, zod, handler }]. */
export function buildTools() {
  return DEFINITIONS.map((def) => {
    const { inputSchema, zod } = compileParams(def.params);
    return { name: def.name, description: def.description, annotations: def.annotations, inputSchema, zod, handler: def.handler };
  });
}
