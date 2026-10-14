# Cortex-Local

Local-first context optimization, persistent memory and code search for **OpenAI Codex** (CLI and desktop), delivered as one MCP server plus a small CLI. Everything runs on your machine: an embedded **Jev decision engine** (Qwen2.5-0.5B GGUF via `node-llama-cpp`), one SQLite file per repository, no hosted services.

```
                    ┌──────────────────────── Codex ─────────────────────────┐
                    │  AGENTS.md rules · .codex/skills/* · shell tool        │
                    └──────┬───────────────────────────────┬─────────────────┘
               MCP (stdio) │                               │ shell: `cortex run -- npm test`
                           ▼                               ▼
   ┌─────────────────── cortex serve ──────────────────┐   ┌──────── cortex run (CLI) ─────────┐
   │ Jev engine (Qwen2.5-0.5B, one prefill per call)   │◄──┤ size gate → Jev triage P(keep)     │
   │ search · memory · checkpoints · ledger · routing  │ local socket   keep │ condense │ receipt│
   │ eviction store · telemetry                        │   │ full output → SQLite / spool       │
   └──────────────────────┬────────────────────────────┘   └──────────────────┬─────────────────┘
                          ▼                                                    ▼
            <repo>/.codex/cortex.db  (SQLite WAL + FTS5)  ·  ~/.codex/global_cortex.db
```

## What it does

| Subsystem | What you get |
|---|---|
| **Jev engine** | Three decision primitives answered by a single forward pass (no text generation): **Noul** (calibrated P(true)), **Choice** (best of ≤ 8 options + distribution), **Score** (expected value on a 1..N scale). ~30–55 ms on Apple Silicon. Exposed directly as `cortex_evaluate_state`. |
| **A. Memory** | Architecture / convention / decision / fix / task memories with confidence, provenance, scope paths. Agent-derived facts are capped at 0.8 until you confirm. Confidence decays when files in a memory's scope change. Global memories (`scope: global`) follow you across repos. |
| **B. Context optimization** | `cortex run -- <cmd>`: outputs under 300 chars pass through; larger ones are triaged by the Jev engine for P(keep). High-signal output (P ≥ 0.70) stays verbatim (condensed to key lines if huge); low-signal output is stored verbatim and replaced by a `JEV CONTEXT RECEIPT`. Without the model, deterministic line scoring takes over. Nothing is lost: `cortex_fetch_evicted` restores, greps or pages the original. |
| **C. Code search** | SQLite FTS5 + BM25 over structural chunks (classes, functions, methods, tests, routes, markdown sections), camelCase/snake_case decomposition, identifier-aware reranking, optional Jev Score reranking, line-numbered snippets, incremental mtime+SHA-256 sync, ripgrep / git-grep fallback. |
| **D. Checkpoints** | Goal, files, errors, decisions, next step. Resume returns a recovery pack with live git state, files changed since, newer test failures (auto-snapshotted by `cortex run`), recent evictions and dead ends. |
| **E. Routing** | `cortex_route` scores repo/user skills by name, description and triggers (progressive disclosure), and adds memories, past investigations, known fixes and code pointers in one call. |
| **F. Investigation ledger** | Hypotheses with outcomes (`dead_end`, `confirmed_solution`, ...). Similar hypotheses are flagged before you repeat them. |
| **G. Error intelligence** | Deterministic error signatures (timestamps, addresses, line numbers and temp paths stripped). Confirmed fixes are stored with files and the git diff and shown automatically the next time the error appears. Identical failing output across runs is flagged ("your last change had no effect"). |
| **H. Privacy** | Secret scrubbing before every write to memories, checkpoints and the ledger (keys, tokens, JWTs, PEM blocks, `.env` lines, URL credentials). Stored command output is kept byte-for-byte except for high-precision credential formats. Sensitive files (`.env*`, keys, credentials, tfstate, ...) are never indexed. Contradicting a high-confidence memory marks it *contested* instead of overwriting it. |
| **I. Telemetry** | `cortex stats`: tokens removed by eviction (net of restores), Jev triage decisions / P(keep) / latency, tokens saved by snippets vs full-file reads, search hit rate and p95 latency, per-tool usage. `cortex bench` (search vs ripgrep) and `cortex model bench` (forward-pass latency and RSS). All local. |
| **J. Versioning** | Every memory create/update/contest/verify/decay/delete is logged with full before/after snapshots; any version can be rolled back, including deletions. |

### How the Jev engine works

1. The state is wrapped in a fixed ChatML prompt (`<|im_start|>system … [STATE] … [QUESTION] Type: Noul|Choice|Score … Criteria: … <|im_start|>assistant\nAnswer:`). User-supplied text is tokenized **without** special tokens, so a log line containing `<|im_start|>` cannot hijack the prompt.
2. One non-generative prefill (`sequence.controlledEvaluate`) requests logits only for the candidate answer tokens at the last position; the KV cache is cleared before and after every pass, and passes are serialized on one sequence.
3. Each candidate's logit merges its whitespace variants: z_eff(C) = ln(e^z(C) + e^z(" C")). The token cache detects tokenizers without a single-token spaced form (Qwen encodes " 7" as " " + "7") and then ends the prompt with `Answer: ` and uses the bare tokens.
4. A numerically stable softmax with calibration temperature T_cal gives the distribution: P(t_i) = e^((z_i − m)/T) / Σ e^((z_j − m)/T).
5. Score returns E[S] = Σ s·P(s). With Qwen's tokenizer, scales go up to 9 (no single "10" token).

**Output triage is a two-option Choice, not a true/false Noul.** Measured on Qwen2.5-0.5B with 16 real build/test/lint/install outputs, true/false answers tracked "does this output look fine?" regardless of the question (5/10 correct, inverted on failures). Choice `A) failure / B) success` with `failure` listed first separated them 15/16 at T_cal = 1 and **16/16 at T_cal = 0.6** (`jev.triage_temperature`): failures scored P(keep) 0.80–0.99, routine output 0.00–0.56. P(keep) = P(failure); it is still a binary softmax over two answer tokens.

The MCP server preloads the model and also serves it on a per-user local socket (mode 0600), so `cortex run` reuses the warm model instead of loading 530 MB per command. If no server is reachable, `cortex run` loads the model in-process (`jev.cli_inprocess`), and if that fails too it falls back to deterministic pruning.

### Honest limits

- **An MCP server cannot rewrite Codex's conversation history.** Optimization happens where it is actually possible: at the command boundary (`cortex run`), plus explicit restore tools. Compaction recovery works through `AGENTS.md` instructions + `cortex_checkpoint_resume`, not a hook into Codex internals.
- A 0.5B model is a fast triage classifier, not a reasoner. Its P(keep) is a heuristic signal; the keep threshold, size gate and verbatim restore exist so a wrong call never loses information.
- The chunker is regex/heuristic based (no tree-sitter), so exotic formatting can produce imperfect boundaries. Search still works because chunks fall back to windows.
- `cortex run` executes through Codex's own shell tool, so Codex's sandbox and approval rules still apply. The MCP server never runs arbitrary commands.

## Requirements

- Node.js 20+ (22 LTS recommended)
- git and ripgrep (optional but recommended)
- macOS, Linux or WSL. Design target: MacBook Pro M2 Pro, 16 GB (Metal is used automatically).

## Install

```bash
git clone <this repo> ~/tools/cortex-local
cd ~/tools/cortex-local
npm install          # better-sqlite3 + node-llama-cpp prebuilt binaries (Metal on Apple Silicon)
npm link             # puts `cortex` on your PATH (needed for `cortex run`)
cortex model pull    # downloads qwen2.5-0.5b-instruct-q8_0.gguf (~530 MB) into ./models
cortex model status  # loads it and runs a probe evaluation
```

Install with the **same Node version Codex will use** to launch the server: `better-sqlite3` and `node-llama-cpp` are native modules tied to the Node ABI. `cortex init` writes the absolute path of that Node binary into the Codex config for this reason. `node-llama-cpp` is an optional dependency: if it cannot be installed, everything except the Jev engine still works.

Memory budget on 16 GB: the model takes roughly 0.6 GB of unified memory in the MCP server process. `cortex model bench` reports RSS before and after 100 passes so you can confirm it stays flat.

## Set up a repository

```bash
cd ~/code/my-project
cortex init --register   # .codex/config.json, .codex/skills/*, AGENTS.md block, .gitignore, first index,
                         # and [mcp_servers.cortex] in ~/.codex/config.toml (backup kept)
cortex doctor            # verify everything, including a real Jev forward pass
```

Without `--register`, `init` prints the snippet to add to `~/.codex/config.toml` yourself:

```toml
[mcp_servers.cortex]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/cortex-local/bin/cortex.js", "serve"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

The server resolves the project from MCP roots (if Codex sends them), then `$CORTEX_PROJECT_ROOT`, then its working directory (nearest `.git` / `AGENTS.md` / `.codex`). If Codex starts MCP servers from somewhere else, pin it per project, e.g. `env = { CORTEX_PROJECT_ROOT = "/path/to/repo" }`.

Restart Codex in the repository. The `AGENTS.md` block tells it when to call each tool.

## MCP tools

| Tool | Purpose |
|---|---|
| `cortex_evaluate_state` | Direct Jev decision: `primitive` (`noul`/`choice`/`score`), `state`, `question`, `criteria` map |
| `cortex_fetch_evicted` | Restore evicted output by hash (accepts `evict_…` and 6+ char prefixes): full payload verbatim, or `query` (grep, `/regex/`) / line range |
| `cortex_checkpoint_save` | Snapshot goal / files / errors / decisions / next step |
| `cortex_checkpoint_resume` | Recovery pack (or `list: true`) |
| `cortex_memory_query` | Search memories (`query` may be `""` to list) |
| `cortex_memory_save` | Save a fact; contradictions are contested, `supersedes` overwrites deliberately |
| `cortex_memory_manage` | `get`, `history`, `verify`, `rollback`, `delete` |
| `cortex_search_code` | Ranked snippets with `file:start-end` (`query`, `symbol_only`, `path_filter`, `max_results`) |
| `cortex_index_sync` | Incremental re-index (`force_full_reindex` to rebuild) |
| `cortex_investigation_check` | Was this hypothesis or error already explored? Known fix? |
| `cortex_investigation_log` | Record outcome; confirmed solutions become fix patterns |
| `cortex_route` | Skills + memories + investigations + code pointers for a task |
| `cortex_stats` | Savings, Jev and latency dashboard |

`cortex_evaluate_state` criteria shapes:

```json
{ "primitive": "noul",   "criteria": { "true": "the hypothesis explains the trace", "false": "it does not" } }
{ "primitive": "choice", "criteria": { "retry": "transient network error", "fix-test": "test is wrong", "fix-code": "code regression" } }
{ "primitive": "score",  "criteria": { "1": "irrelevant", "2": "weak", "3": "related", "4": "relevant", "5": "exact" } }
```

## CLI

```bash
cortex run -- npm test                    # optimize output, keep exit code
cortex run -- "npm run build && npm test" # shell syntax: pass one quoted string
cortex run --raw -- npm test              # bypass optimization
some-cmd 2>&1 | cortex compress --label some-cmd --exit-code 0
cortex fetch 4f8a12c9b7d3e1a0 --query "OrderServiceTest"
cortex model pull | status | bench --runs 100
cortex search "process scheduled export jobs" --symbols -n 3
cortex index [--full]
cortex memory add --category convention --title "Assertions" --content "Use AssertJ, not Hamcrest"
cortex memory list | search <q> | verify <id> | history [id] | rollback <version> | export conventions.json | import conventions.json
cortex checkpoint [--list]
cortex route "fix flaky export test"
cortex stats --days 30
cortex bench "scheduled export" "auth token refresh"
cortex doctor
```

Receipt for a 2,000-line successful Maven build (low signal, evicted):

```
[JEV CONTEXT RECEIPT #evict_4f8a12c9b7d3e1a0]
Original tool output: 2,014 lines (148,302 bytes) evicted to conserve context.
Command: `mvn package` · exit 0 · 41.2s
Retention Probability P(keep): 6.3%
Core Signal: [INFO] BUILD SUCCESS
Full content preserved. To restore verbatim: call cortex_fetch_evicted(hash="4f8a12c9b7d3e1a0")
```

A failing JUnit run with a short stack trace has a high P(keep) and is returned verbatim. A failing run larger than `jev.keep_max_chars` is condensed to its key lines:

```
[cortex] `npm test` exit=1 FAILED · 12.4s · test output · P(keep) 93.1% · 512 lines (~18.2k tok) → stored #3f9a2c1b7d4e8a21
summary: Tests:       1 failed, 44 passed, 45 total
signal: ● ReportService › generates scheduled export @ src/report/ReportService.test.ts:88
L132 ● ReportService › generates scheduled export
L140   Expected: 3
L141   Received: 2
L156   at Object.<anonymous> (src/report/ReportService.test.ts:88:21)
known fix (seen 2×, fixed 3d ago): Reset fake timers in beforeEach [src/test/setup.ts]
restore: cortex_fetch_evicted hash=3f9a2c1b7d4e8a21 (query="…" or start_line/end_line)
```

## Verified behaviour

Measured end to end in a Linux x64 container (4 CPU cores, no GPU, Node 22) with the real model, a real MCP client session and a Django checkout (~7,000 files):

| Check | Result |
|---|---|
| Install, model pull, `cortex doctor` | prebuilt native modules load; GGUF download verified (506 MB); doctor runs a real forward pass |
| §8.2 A: Java assertion failure | P(keep) 0.95, returned verbatim, exit code 1 preserved |
| §8.2 B: 2,000-line Maven `BUILD SUCCESS` | P(keep) 0.027, replaced by a receipt |
| §8.3 restore | `cortex_fetch_evicted` returned the 241,996-byte payload byte-for-byte after a server restart |
| §8.4 recovery | checkpoint, dead ends and evicted-output pointers recovered by a fresh server process |
| `cortex run` → server model | evaluated over the local socket (no model load in the CLI process); in-process fallback and rule-based fallback both work |
| §8.1 memory | RSS flat over 100 passes (no growth). Absolute RSS ~870 MB on x86 CPU, where llama.cpp keeps a repacked copy of the weights; measure on Apple Silicon with `cortex model bench` |
| §8.1 latency | ~1–5 s per pass on this CPU-only container (prompt-length dependent). The 30–55 ms target assumes Metal and is not measurable here |
| Code search on Django | cold index 6,966 files in 13 s, incremental re-sync 1.0 s, queries 16–52 ms (84 ms worst case with very common terms), correct symbol in the top 2 for every test query |

## Configuration (`.codex/config.json`)

Defaults live in `src/core/config.js`. Commonly tuned keys:

```json
{
  "index": { "exclude": ["fixtures/**"], "max_file_bytes": 1000000, "auto_sync_interval_sec": 60 },
  "search": { "default_max_results": 5, "snippet_lines": 24, "jev_rerank": { "enabled": false, "top_k": 6 } },
  "pruning": { "inline_max_lines": 40, "stub_max_lines": 14 },
  "jev": {
    "enabled": true, "keep_threshold": 0.7, "min_chars": 300, "excerpt_chars": 1000, "keep_max_chars": 20000,
    "gpu": "auto", "context_size": 4096, "batch_size": 2048, "temperature": 1.0, "triage_temperature": 0.6,
    "preload": true, "host": true, "cli_inprocess": true
  },
  "memory": { "default_min_confidence": 0.7 },
  "output_format": "text"
}
```

- `jev.model_path` defaults to `<cortex-local>/models/qwen2.5-0.5b-instruct-q8_0.gguf`; `$CORTEX_JEV_MODEL` overrides it. `jev.gpu` accepts `auto`, `metal`, `cuda`, `vulkan` or `false` (CPU). A GPU initialisation failure retries on CPU automatically.
- `pruning.inline_max_lines` / `inline_max_chars` apply only when the Jev engine is unavailable.
- `search.jev_rerank` reranks the top BM25 hits with the Score primitive inside the MCP server (~50 ms per candidate); off by default.
- `index.exclude` extends the built-in excludes; set `index.replace_default_excludes: true` to replace them. `output_format: "json"` returns raw data instead of the compact text renderings.

Environment overrides: `CORTEX_PROJECT_ROOT`, `CORTEX_DATA_DIR`, `CORTEX_DB_PATH`, `CORTEX_GLOBAL_DB`, `CORTEX_JEV_MODEL`, `CORTEX_LOG_LEVEL`, `CODEX_HOME`.

## Spec-to-code map

The engine spec was written for a TypeScript `cortex-engine/` project. This repository implements it in plain ESM JavaScript (no build step) on top of the existing modules:

| Spec module | Implementation |
|---|---|
| `src/index.ts` | `src/server.js` (MCP stdio server, lifecycle, Jev preload and local host) |
| `src/config.ts` | `src/core/config.js` (`jev` section: paths, model parameters, thresholds) |
| `core/Database.ts` | `src/core/db.js` + `src/core/schema.js` (WAL, busy timeout, migrations; `evicted_payloads.p_keep`) |
| `core/JevEngine.ts` | `src/jev/engine.js` |
| `core/TokenCache.ts` | `src/jev/tokenCache.js` |
| `core/ContextOptimizer.ts` | `src/jev/optimizer.js` (triage prompt, signal, receipt) + `src/engines/output.js` (gating, storage) |
| `tools/*.ts` | `src/tools/registry.js` (+ `render.js`) |
| `types/index.ts` | `src/tools/schema.js` (zod contracts) |
| `data/cortex.db` | `<repo>/.codex/cortex.db` (one database per repository) |
| `models/*.gguf` | `<cortex-local>/models/` (shared by all repositories) |

## Data layout

```
<cortex-local>/models/qwen2.5-0.5b-instruct-q8_0.gguf   # Jev model (git-ignored)
<repo>/
├── AGENTS.md                 # managed Cortex block (your content is preserved)
└── .codex/
    ├── config.json           # engine settings (commit it if you like)
    ├── skills/               # smart-search, task-recovery, bug-investigation, context-pruning
    ├── cortex.db (+ -wal)    # local data (git-ignored)
    └── spool/                # payloads written while the DB was not writable (auto-imported)
~/.codex/global_cortex.db     # cross-project memories
```

If `cortex run` executes in a sandbox where `.codex/` is read-only, it still optimizes the output and writes the full payload to a spool directory (`.codex/spool`, `.cortex-spool/` or `$TMPDIR/cortex-local-spool`). The MCP server imports spooled payloads at startup and on fetch.

## Troubleshooting

- `cortex doctor` checks Node, SQLite FTS5, paths, index, AGENTS.md, skills, node-llama-cpp, the model file and a real forward pass, git, ripgrep, Codex registration and PATH.
- `NODE_MODULE_VERSION` mismatch: run `npm rebuild better-sqlite3 node-llama-cpp` with the Node binary that Codex launches.
- Receipts never appear: run `cortex model status`. A missing model or runtime silently falls back to deterministic pruning, which shows `[cortex] … stored #…` stubs instead.
- Search finds nothing after a branch switch: call `cortex_index_sync` (it also runs automatically when the index is older than `auto_sync_interval_sec`).
- Server logs go to stderr (shown in Codex's MCP logs). Set `"log_to_file": true` to also write `.codex/cortex.log`; `CORTEX_LOG_LEVEL=debug` includes llama.cpp messages.
