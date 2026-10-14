import { formatCount, oneLine, relTime, shortId, truncate } from '../core/util.js';

// Compact, LLM-friendly text renderings of every tool result (set output_format=json for raw data).

function symbolLabel(r) {
  if (!r.symbol_name) return r.symbol_type && r.symbol_type !== 'block' ? ` · ${r.symbol_type}` : '';
  const sep = r.symbol_type === 'test' ? ' > ' : '.';
  return ` · ${r.symbol_type} ${r.parent_symbol ? `${r.parent_symbol}${sep}` : ''}${r.symbol_name}`;
}

export function renderSearch(d) {
  const warming = d.index.warming ? ` · index warming ${d.index.warming.done}/${d.index.warming.total} files` : '';
  if (!d.results.length) {
    return `No matches for "${oneLine(d.query, 80)}" (${d.strategy}, ${d.latency_ms}ms${warming}). Try an identifier, fewer words, or rg for exact text.`;
  }
  const lines = [`${d.results.length} result(s) for "${oneLine(d.query, 80)}" · ${d.strategy} · ${d.latency_ms}ms${warming}`];
  for (const r of d.results) {
    lines.push(`[${r.rank}] ${r.file_path}:${r.start_line}-${r.end_line}${symbolLabel(r)}${r.score != null ? ` · score ${r.score}` : ''}`);
    if (r.snippet) lines.push(r.snippet);
  }
  lines.push(`(index: ${formatCount(d.index.files)} files, ${formatCount(d.index.chunks)} chunks, synced ${relTime(d.index.last_sync_at)}; read more with sed -n 'START,ENDp' FILE)`);
  return lines.join('\n');
}

export function renderIndexSync(s) {
  const parts = [
    `${formatCount(s.discovered)} files via ${s.source}`,
    `+${s.added} added`,
    `~${s.updated} updated`,
    `-${s.pruned} removed`,
    `${s.unchanged} unchanged`,
    `${s.skipped} skipped`,
    `${formatCount(s.chunks_written)} chunks written`,
    `${s.duration_ms}ms`,
  ];
  const lines = [`Index sync (${s.reason}${s.forced ? ', full rebuild' : ''}): ${parts.join(' · ')}`];
  if (s.sensitive_excluded) lines.push(`${s.sensitive_excluded} sensitive file(s) excluded (.env, keys, credentials).`);
  if (s.memories_flagged) lines.push(`${s.memories_flagged} memor${s.memories_flagged === 1 ? 'y' : 'ies'} flagged for re-verification (files in their scope changed).`);
  return lines.join('\n');
}

function memoryLine(m) {
  const flags = [m.contested ? '⚠ CONTESTED' : null, m.stale ? 'stale (scope files changed; re-verify)' : null, m.scope === 'global' ? 'global' : null]
    .filter(Boolean)
    .join(' · ');
  return `- [${shortId(m.id)}] ${m.category} · ${m.title} · conf ${m.confidence} · ${m.source_type} · verified ${relTime(m.last_verified_at)}${flags ? ` · ${flags}` : ''}`;
}

export function renderMemoryQuery(d) {
  const scope = `${d.query ? ` for "${oneLine(d.query, 80)}"` : ''}${d.category ? ` in ${d.category}` : ''}`;
  if (!d.memories.length) {
    return `No memories${scope} (min_confidence ${d.min_confidence}).${d.hidden_low_confidence ? ` ${d.hidden_low_confidence} lower-confidence match(es) hidden.` : ''}`;
  }
  const lines = [`${d.memories.length} memor${d.memories.length === 1 ? 'y' : 'ies'}${scope}:`];
  for (const m of d.memories) {
    lines.push(memoryLine(m));
    lines.push(`  ${truncate(m.content.replace(/\n+/g, ' / '), 600)}`);
    if (m.contested && m.contest_note) lines.push(`  contested by: ${truncate(m.contest_note, 300)}`);
  }
  if (d.hidden_low_confidence) lines.push(`(${d.hidden_low_confidence} lower-confidence match(es) hidden; lower min_confidence to include them)`);
  return lines.join('\n');
}

export function renderMemorySave(d) {
  const m = d.memory;
  const lines = [`memory ${d.status}: [${shortId(m.id)}] ${m.category} · ${m.title} · conf ${m.confidence} (${m.scope})`];
  for (const w of d.warnings ?? []) lines.push(`! ${w}`);
  if (d.related?.length) lines.push(`related: ${d.related.map((r) => `[${shortId(r.id)}] ${r.title}`).join('; ')}`);
  return lines.join('\n');
}

export function renderMemoryManage(d) {
  switch (d.action) {
    case 'get': {
      const m = d.memory;
      const lines = [memoryLine(m), m.content];
      if (m.scope_paths.length) lines.push(`scope: ${m.scope_paths.join(', ')}`);
      if (m.invalidation_rule) lines.push(`invalid when: ${m.invalidation_rule}`);
      if (m.contest_note) lines.push(`contested by: ${m.contest_note}`);
      if (d.versions.length) lines.push(`versions: ${d.versions.map((v) => `#${v.id} ${v.operation} (${relTime(v.created_at)})`).join(', ')}`);
      return lines.join('\n');
    }
    case 'history': {
      if (!d.versions.length) return `No history${d.id ? ` for ${d.id}` : ''}.`;
      return [
        `Memory history${d.id ? ` for ${d.id}` : ''} (rollback restores the state *before* a version):`,
        ...d.versions.map((v) => `#${v.id} ${v.operation} [${shortId(v.memory_id)}] ${relTime(v.created_at)}${v.altered_reason ? ` · ${oneLine(v.altered_reason, 120)}` : ''}${v.content_after ? ` → ${oneLine(v.content_after, 100)}` : ''}`),
      ].join('\n');
    }
    case 'verify':
      return `verified: ${memoryLine(d.memory)}`;
    case 'delete':
      return `deleted [${shortId(d.deleted.id)}] ${d.deleted.title} (restore with action=history → rollback)`;
    case 'rollback':
      return d.memory ? `rolled back to before version #${d.version_id}: ${memoryLine(d.memory)}` : `rolled back version #${d.version_id}: memory ${shortId(d.memory_id)} removed`;
    default:
      return JSON.stringify(d);
  }
}

export function renderCheckpointSave(d) {
  const git = d.git?.branch ? ` · ${d.git.branch}@${d.git.head ?? '?'}` : '';
  return `checkpoint saved: ${shortId(d.id)} (${d.kind}, ${d.files} file(s)${git})${d.redactions ? ` · ${d.redactions} secret(s) redacted` : ''}`;
}

export function renderCheckpointResume(d) {
  if (d.mode === 'list') {
    if (!d.checkpoints.length) return 'No checkpoints yet.';
    return d.checkpoints.map((c) => `${shortId(c.id)} ${c.kind} ${relTime(c.created_at)} · ${oneLine(c.goal, 100)}${c.next_step ? ` → ${oneLine(c.next_step, 80)}` : ''}`).join('\n');
  }
  const lines = [];
  if (d.checkpoint) {
    const c = d.checkpoint;
    lines.push(`Checkpoint ${shortId(c.id)} (${c.kind}, ${relTime(c.created_at)})`);
    lines.push(`goal: ${c.goal}`);
    if (c.next_step) lines.push(`next step: ${c.next_step}`);
    if (c.current_errors) lines.push(`open errors: ${truncate(c.current_errors, 600)}`);
    if (c.decisions.length) lines.push(`decisions: ${c.decisions.map((x) => `• ${oneLine(x, 160)}`).join(' ')}`);
    if (c.notes) lines.push(`notes: ${truncate(c.notes, 400)}`);
  } else {
    lines.push('No checkpoint found for this project. Live state:');
  }
  if (d.newer_failure) {
    lines.push(`newer failure (${relTime(d.newer_failure.created_at)}${d.newer_failure.command ? `, \`${d.newer_failure.command}\`` : ''}): ${truncate(d.newer_failure.errors ?? '', 400)}`);
  }
  if (d.files.length) {
    lines.push(`files: ${d.files.map((f) => `${f.path}${f.exists === false ? ' [missing]' : f.modified_since_checkpoint ? ' [modified]' : ''}`).join(', ')}`);
  }
  if (d.git) {
    const then = d.checkpoint?.git_then;
    const moved = then?.head && d.git.head && then.head !== d.git.head ? ` (was ${then.branch ?? '?'}@${then.head})` : '';
    const dirty = d.git.status?.total
      ? ` · ${d.git.status.total} changed: ${d.git.status.entries.slice(0, 8).map((e) => `${e.status} ${e.path}`).join(', ')}${d.git.status.total > 8 ? ', …' : ''}`
      : ' · clean';
    lines.push(`git: ${d.git.branch ?? '?'}@${d.git.head ?? '?'}${moved}${dirty}`);
  }
  for (const e of d.recent_evictions) {
    const keep = e.p_keep != null ? ` P(keep) ${(e.p_keep * 100).toFixed(0)}%` : '';
    lines.push(`evicted #${e.hash.slice(0, 16)} \`${oneLine(e.command ?? '?', 60)}\` exit=${e.exit_code ?? '?'}${keep} ${relTime(e.last_seen_at)}${e.signal ? ` — ${oneLine(e.signal, 140)}` : ''}`);
  }
  for (const inv of d.open_investigations) {
    lines.push(`${inv.outcome === 'dead_end' ? 'avoid (dead end)' : 'open investigation'} [${shortId(inv.id)}]: ${oneLine(inv.hypothesis, 140)}`);
  }
  for (const m of d.task_memories) lines.push(`task memory [${shortId(m.id)}]: ${m.title} — ${oneLine(m.content, 160)}`);
  if (d.contested_memories) lines.push(`⚠ ${d.contested_memories} contested memor${d.contested_memories === 1 ? 'y' : 'ies'}: ask the user, then resolve via cortex_memory_manage.`);
  if (d.stale_memories) lines.push(`${d.stale_memories} memor${d.stale_memories === 1 ? 'y needs' : 'ies need'} re-verification (scope files changed).`);
  if (!d.checkpoint) lines.push('Tip: save one with cortex_checkpoint_save once the goal is clear.');
  return lines.join('\n');
}

export function fetchHeader(d) {
  const keep = d.p_keep != null ? ` · P(keep) ${(d.p_keep * 100).toFixed(1)}%` : '';
  return `#${d.hash.slice(0, 16)} \`${oneLine(d.command ?? '?', 80)}\` exit=${d.exit_code ?? '?'}${keep} · ${d.note}`;
}

export function renderFetch(d) {
  return `${fetchHeader(d)}\n${d.content}`;
}

export function renderEvaluation(d) {
  const meta = `(${d.latency_ms}ms forward pass, ${d.prompt_tokens} prompt tokens)`;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const dist = Object.entries(d.distribution).map(([k, v]) => `${k}=${pct(v)}`).join(' · ');
  if (d.primitive === 'noul') return `noul: P(true) = ${pct(d.probability)} → ${d.answer} ${meta}\n${dist}`;
  if (d.primitive === 'choice') return `choice: ${d.winner} (confidence ${pct(d.confidence)}) ${meta}\n${dist}`;
  return `score: ${d.score} on 1-${d.scale} ${meta}\n${dist}`;
}

export function renderInvestigationCheck(d) {
  const guidance = {
    dead_end: '⚠ DEAD END: this direction was already tried and failed. Read the notes and choose a different hypothesis (or state what is different this time).',
    confirmed_solution: '✓ CONFIRMED SOLUTION exists: apply/verify it before investigating further.',
    partially_valid: 'Partially valid before: build on the recorded notes.',
    in_progress: 'An investigation on this is already open: continue it (cortex_investigation_log with its id).',
    known_fix: '✓ This error signature has a recorded fix (below).',
    not_found: 'No prior attempt found. Record the outcome with cortex_investigation_log when done.',
  };
  const lines = [`status: ${d.status}${d.error_signature ? ` · error signature ${d.error_signature}` : ''}`, guidance[d.status] ?? ''];
  if (d.known_fix) {
    const f = d.known_fix;
    lines.push(`known fix (seen ${f.occurrences}×${f.resolved_at ? `, fixed ${relTime(f.resolved_at)}` : ''}): ${f.fix_summary}${f.fix_files.length ? ` [${f.fix_files.join(', ')}]` : ''}`);
    if (f.fix_diff) lines.push(truncate(f.fix_diff, 1200));
  }
  for (const m of d.matches) {
    lines.push(`- [${shortId(m.id)}] ${m.outcome} · sim ${m.similarity}${m.same_error ? ' · same error' : ''} · ${m.attempts} attempt(s) · ${relTime(m.updated_at)}: ${oneLine(m.hypothesis, 160)}`);
    if (m.notes) lines.push(`  notes: ${truncate(m.notes.replace(/\n+/g, ' / '), 400)}`);
    if (m.inspected_paths.length) lines.push(`  inspected: ${m.inspected_paths.slice(0, 8).join(', ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

export function renderInvestigationLog(d) {
  const lines = [`investigation ${d.status}: [${shortId(d.id)}] ${d.outcome}${d.error_signature ? ` · error signature ${d.error_signature}` : ''}`];
  if (d.fix) lines.push(`fix pattern recorded for ${d.fix.signature}${d.fix.files.length ? ` (${d.fix.files.join(', ')})` : ''}${d.fix.captured_diff ? ' with diff' : ''}`);
  if (d.memory) lines.push(`fix memory ${d.memory.status}: [${shortId(d.memory.id)}]`);
  if (d.redactions) lines.push(`${d.redactions} secret(s) redacted`);
  return lines.join('\n');
}

export function renderRoute(d) {
  const lines = [`Routing: "${oneLine(d.task, 100)}"`];
  if (d.checkpoint) {
    lines.push(`last checkpoint (${relTime(d.checkpoint.created_at)}): ${oneLine(d.checkpoint.goal, 120)}${d.checkpoint.next_step ? ` → next: ${oneLine(d.checkpoint.next_step, 100)}` : ''}`);
  }
  lines.push(d.skills.length ? `skills: ${d.skills.map((s) => `${s.name} (${s.path})`).join('; ')}` : 'skills: none matched');
  if (d.memories.length) {
    lines.push('memories:');
    for (const m of d.memories) lines.push(`  [${shortId(m.id)}] ${m.category} · ${m.title}${m.contested ? ' ⚠ contested' : ''}${m.stale ? ' (stale)' : ''}: ${oneLine(m.content, 160)}`);
  }
  if (d.investigations.length) {
    lines.push('prior investigations:');
    for (const i of d.investigations) lines.push(`  [${shortId(i.id)}] ${i.outcome}: ${oneLine(i.hypothesis, 140)}`);
  }
  if (d.known_fix) lines.push(`known fix: ${oneLine(d.known_fix.fix_summary, 160)}${d.known_fix.fix_files.length ? ` [${d.known_fix.fix_files.join(', ')}]` : ''}`);
  if (d.code.length) {
    lines.push('code:');
    for (const r of d.code) lines.push(`  ${r.file_path}:${r.start_line}-${r.end_line}${symbolLabel(r)}`);
  }
  if (d.code_note) lines.push(`(code: ${d.code_note})`);
  lines.push('next: open the matching SKILL.md only if needed · cortex_search_code for details · wrap verbose commands with `cortex run --`');
  return lines.join('\n');
}

function pct(v) {
  return v == null ? 'n/a' : `${Math.round(v * 100)}%`;
}

function ms(v) {
  return v == null ? 'n/a' : `${v}ms`;
}

export function renderStats(d) {
  const e = d.eviction;
  const s = d.search;
  const lines = [
    `Cortex-Local · ${d.project} · last ${d.window_days} day(s)`,
    '─'.repeat(60),
    'Context savings',
    `  output eviction   ${e.count} stub(s) · ~${formatCount(e.input_tokens)} tok of output → ~${formatCount(e.stub_tokens)} tok of stubs · ${e.fetches} restore(s) (~${formatCount(e.tokens_restored)} tok) · net ~${formatCount(e.net_tokens_saved)} tok saved`,
    `  search snippets   ${s.queries} quer${s.queries === 1 ? 'y' : 'ies'} · hit rate ${pct(s.hit_rate)} · ~${formatCount(s.tokens_saved_vs_full_reads)} tok vs reading the full files`,
    'Latency',
    `  code search       avg ${ms(s.avg_ms)} · p95 ${ms(s.p95_ms)} · strategies ${Object.entries(s.strategies).map(([k, v]) => `${k}=${v}`).join(', ') || 'n/a'}`,
  ];
  if (d.bench.length) {
    for (const b of d.bench) lines.push(`  bench "${oneLine(b.query ?? '', 40)}": index ${ms(b.index_ms)} vs ripgrep ${ms(b.rg_ms)}`);
  } else {
    lines.push('  (run `cortex bench "<query>"` to compare against a ripgrep scan)');
  }
  if (d.tools.length) {
    lines.push('Tool calls');
    for (const t of d.tools.slice(0, 12)) lines.push(`  ${t.tool.padEnd(28)} ${String(t.calls).padStart(5)} calls · avg ${ms(t.avg_ms)} · p95 ${ms(t.p95_ms)} · ~${formatCount(t.output_tokens)} tok out`);
    if (d.tool_errors) lines.push(`  errors: ${d.tool_errors}`);
  }
  if (d.jev) {
    const jv = d.jev;
    const modes = Object.entries(jv.modes).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a';
    lines.push('Jev engine');
    lines.push(`  triage            ${jv.triages} decision(s) · avg P(keep) ${jv.avg_p_keep == null ? 'n/a' : `${(jv.avg_p_keep * 100).toFixed(1)}%`} · avg ${ms(jv.avg_ms)} · p95 ${ms(jv.p95_ms)} · ${modes}`);
  }
  lines.push('Memory & recovery');
  lines.push(`  memories ${d.memory.total} (contested ${d.memory.contested}, stale ${d.memory.stale}) · ${d.memory.queries} queries (hit ${pct(d.memory.hit_rate)}) · ${d.memory.saves} saves`);
  lines.push(`  checkpoints ${d.checkpoints.saved} saved · ${d.checkpoints.resumes} resumes · investigation checks ${d.investigations.checks} (prior work found ${d.investigations.prior_work_found})`);
  if (d.index) lines.push(`Index: ${formatCount(d.index.files)} files · ${formatCount(d.index.chunks)} chunks · last sync ${relTime(d.index.last_sync_at)}`);
  return lines.join('\n');
}
