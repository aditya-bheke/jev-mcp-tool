// Files scaffolded by `cortex init`. {{CORTEX}} is replaced with the command that invokes the CLI.

export const AGENTS_BEGIN = '<!-- cortex-local:begin (managed by `cortex init`; edit outside this block) -->';
export const AGENTS_END = '<!-- cortex-local:end -->';

export function agentsBlock({ cortexCmd, commands }) {
  const cmd = (value) => (value ? `\`${value}\`` : '_(fill in)_');
  return `## Cortex-Local (local memory, code index, context pruning)

The \`cortex\` MCP server runs entirely on this machine. Use it to save context and avoid repeated work:

1. **Session start or after compaction:** call \`cortex_checkpoint_resume\` before multi-step work and continue from its next step.
2. **New task:** \`cortex_route\` with the task to get matching skills, memories, past investigations and code locations.
3. **Finding code:** \`cortex_search_code\` for concepts and unfamiliar symbols (top-5 snippets with line ranges). Use \`rg\` only for exact strings. Read line spans (\`sed -n 'A,Bp' FILE\`), not whole files.
4. **Verbose commands** (tests, builds, installs, linters): run them as \`${cortexCmd} run -- <command>\`. A local model keeps high-signal output (failures) and replaces routine output with a \`JEV CONTEXT RECEIPT\`; restore anything with \`cortex_fetch_evicted\` (prefer \`query\` or a line range).
5. **Debugging:** before trying a fix, call \`cortex_investigation_check\` with your hypothesis and the key error lines. After it is confirmed or disproven, call \`cortex_investigation_log\`.
6. **Checkpoints:** \`cortex_checkpoint_save\` after tests go green, before risky edits, and when blocked.
7. **Memory:** save durable architecture, convention and decision facts with \`cortex_memory_save\` (\`source_type=user_instruction\` when the user said it). Check \`cortex_memory_query\` before assuming. Never store secrets.

### Project commands
- Build: ${cmd(commands.build)}
- Test: ${cmd(commands.test)}
- Lint/format: ${cmd(commands.lint)}`;
}

export const SKILLS = {
  'smart-search': `---
name: smart-search
description: Find code efficiently - choose between Cortex indexed search and exact ripgrep, then read only the relevant line spans.
metadata:
  triggers: "find, where is, where do, locate, which file, how does, search code, look for, implementation of, usages, defined"
  inputs: "a concept, symbol name, or natural-language description of code"
---

# Smart search

1. **Exact text** (a literal string, config key, error message, file name): use \`rg -n "<text>"\` or \`rg --files | rg <name>\`.
2. **Concepts, unfamiliar symbols, "where do we ..."**: call \`cortex_search_code\` with a short query (3-6 words or an identifier), \`max_results\` 5.
   - Narrow with \`path_filter\` (\`src/api\`, \`**/*.test.ts\`) and \`symbol_only: true\` for declarations.
3. Read only the span you need: \`sed -n '<start>,<end>p' <file>\` around the returned range. Never print whole large files.
4. If results look stale (files just moved or regenerated), call \`cortex_index_sync\` once and retry.
5. Zero results already fall back to ripgrep; then try a synonym or a single identifier.
`,
  'task-recovery': `---
name: task-recovery
description: Resume interrupted or compacted work from Cortex checkpoints and keep checkpoints current during multi-step tasks.
metadata:
  triggers: "continue, resume, where was i, pick up, after compaction, new session, restart, what's next, checkpoint, keep going"
  inputs: "optional checkpoint id"
---

# Task recovery

1. At session start, after a context compaction, or when asked to continue: call \`cortex_checkpoint_resume\`.
2. Check the pack: \`[missing]\` files need attention; \`[modified]\` files changed since the checkpoint, so re-read only the relevant spans. A "newer failure" means tests failed after the checkpoint.
3. Confirm the next step still fits the git state, then execute it. Do not ask the user to restate the task.
4. Save a new checkpoint with \`cortex_checkpoint_save\` when tests go green, before a risky refactor, when blocked, and before ending a turn on multi-step work. Keep \`goal\` stable; make \`next_step\` a concrete action.
5. Put session decisions in \`decisions\`; save long-lived ones with \`cortex_memory_save\` (category \`decision\`).
`,
  'bug-investigation': `---
name: bug-investigation
description: Debug failures without repeating dead ends - check the investigation ledger and known error fixes before a fix, and log outcomes after.
metadata:
  triggers: "bug, error, failing, fails, exception, crash, stack trace, regression, debug, broken, doesn't work, flaky, traceback"
  inputs: "error text and a hypothesis"
---

# Bug investigation

1. Reproduce with \`{{CORTEX}} run -- <test or build command>\`. The stub shows the core signal, any known fix for this error signature, and whether the output is identical to a previous run.
2. Before changing code, call \`cortex_investigation_check\` with your hypothesis and the key error lines as \`error_text\`.
   - \`dead_end\`: do not retry it as-is; read the notes and choose a different hypothesis.
   - \`confirmed_solution\` / \`known_fix\`: apply and verify the recorded fix first.
3. Investigate with \`cortex_search_code\` and targeted line reads; get more of an evicted log with \`cortex_fetch_evicted\` and a \`query\`.
4. After each hypothesis is confirmed or disproven, call \`cortex_investigation_log\` (\`confirmed_solution\`, \`dead_end\` or \`partially_valid\`). For solutions include \`error_text\`, \`fix_summary\` and \`fix_files\` so the fix becomes reusable.
5. If a stub says "identical failure to the run ... ago", your last change had no effect. Rethink before editing more.
`,
  'context-pruning': `---
name: context-pruning
description: Keep the context window lean - wrap verbose commands with cortex run, restore evicted output on demand, and avoid dumping large files.
metadata:
  triggers: "run tests, build, install, lint, compile, logs, long output, verbose, npm, pnpm, yarn, pytest, gradle, maven, cargo, make, go test"
  inputs: "a shell command"
---

# Context pruning

- Wrap any command whose output may exceed about 40 lines: \`{{CORTEX}} run -- npm test\`, \`{{CORTEX}} run -- ./gradlew build\`, \`{{CORTEX}} run -- "npm run build && npm test"\`.
- Outputs under 300 characters pass through. Larger ones are triaged by the local Jev model: high-signal output (failures, diagnostics) stays verbatim; routine output becomes a \`JEV CONTEXT RECEIPT\` (line/byte counts, P(keep), core signal, hash). Very large high-signal output is condensed to a stub of key lines with original line numbers.
- Need more detail: \`cortex_fetch_evicted\` with the receipt hash and a \`query\` (grep with context, \`/regex/\` allowed) or \`start_line\`/\`end_line\`. Without them it returns the full payload verbatim; do that only when necessary.
- Exit codes are preserved, so \`&&\` chains behave normally.
- If you cannot wrap a command, pipe it: \`some-cmd 2>&1 | {{CORTEX}} compress --label "some-cmd"\`.
`,
};

export const GITIGNORE_LINES = [
  '# cortex-local (local-only data)',
  '.codex/cortex.db',
  '.codex/cortex.db-*',
  '.codex/cortex.log',
  '.codex/spool/',
  '.cortex-spool/',
];

export function codexTomlSnippet({ node, script }) {
  return [
    '[mcp_servers.cortex]',
    `command = ${JSON.stringify(node)}`,
    `args = [${JSON.stringify(script)}, "serve"]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
  ].join('\n');
}
