# Cortex-Local

Local-first context optimization, persistent memory and code search for **OpenAI Codex** (CLI and desktop), delivered as one MCP server plus a small CLI. Everything runs on your machine: one SQLite file per repository, no network calls, no hosted services.

```
                    ┌──────────────────────── Codex ────────────────────────┐
                    │  AGENTS.md rules · .codex/skills/* · shell tool       │
                    └──────┬──────────────────────────────┬─────────────────┘
               MCP (stdio) │                              │ shell: `cortex run -- npm test`
                           ▼                              ▼
        ┌──────────────── cortex serve ──────────┐   ┌──── cortex run (CLI) ─────┐
        │ search · memory · checkpoints · ledger │   │ capture → score → stub    │
        │ routing · eviction store · telemetry   │   │ full output → DB / spool  │
        └───────────────────┬────────────────────┘   └────────────┬──────────────┘
                            ▼                                     ▼
                 <repo>/.codex/cortex.db  (SQLite WAL + FTS5)  ·  ~/.codex/global_cortex.db
```

## What it does

| Subsystem | What you get |
|---|---|
| **A. Memory** | Architecture / convention / decision / fix / task memories with confidence, provenance, scope paths. Agent-derived facts are capped at 0.8 until you confirm. Confidence decays when files in a memory's scope change. Global memories (`scope: global`) follow you across repos. |
| **B. Context pruning (Jev-style)** | `cortex run -- <cmd>` captures output, scores every line (errors, summaries, project stack frames, locations > warnings > noise), stores the full output verbatim (secret-scrubbed) and prints a stub of ≤14 lines with original line numbers and a restore hash. Nothing is lost: `cortex_fetch_evicted` greps or pages the original. |
| **C. Code search** | SQLite FTS5 + BM25 over structural chunks (classes, functions, methods, tests, routes, markdown sections), camelCase/snake_case decomposition, identifier-aware reranking, line-numbered snippets, incremental mtime+SHA-256 sync, ripgrep / git-grep fallback. |
| **D. Checkpoints** | Goal, files, errors, decisions, next step. Resume returns a recovery pack with live git state, files changed since, newer test failures (auto-snapshotted by `cortex run`), recent evictions and dead ends. |
| **E. Routing** | `cortex_route` scores repo/user skills by name, description and triggers (progressive disclosure), and adds memories, past investigations, known fixes and code pointers in one call. |
| **F. Investigation ledger** | Hypotheses with outcomes (`dead_end`, `confirmed_solution`, ...). Similar hypotheses are flagged before you repeat them. |
| **G. Error intelligence** | Deterministic error signatures (timestamps, addresses, line numbers and temp paths stripped). Confirmed fixes are stored with files and the git diff and shown automatically the next time the error appears. Identical failing output across runs is flagged ("your last change had no effect"). |
| **H. Privacy** | Secret scrubbing before every write (keys, tokens, JWTs, PEM blocks, `.env` lines, URL credentials). Sensitive files (`.env*`, keys, credentials, tfstate, ...) are never indexed. Contradicting a high-confidence memory marks it *contested* instead of overwriting it. |
| **I. Telemetry** | `cortex stats`: tokens removed by eviction (net of restores), tokens saved by snippets vs full-file reads, search hit rate and p95 latency, per-tool usage. `cortex bench` compares indexed search with a ripgrep scan. All local. |
| **J. Versioning** | Every memory create/update/contest/verify/decay/delete is logged with full before/after snapshots; any version can be rolled back, including deletions. |

### Honest limits

- **An MCP server cannot rewrite Codex's conversation history.** Pruning happens where it is actually possible: at the command boundary (`cortex run`), plus explicit restore tools. Compaction recovery works through `AGENTS.md` instructions + `cortex_checkpoint_resume`, not a hook into Codex internals.
- The chunker is regex/heuristic based (no tree-sitter), so exotic formatting can produce imperfect boundaries. Search still works because chunks fall back to windows.
- `cortex run` executes through Codex's own shell tool, so Codex's sandbox and approval rules still apply. The MCP server never runs arbitrary commands.

## Requirements

- Node.js 20+ (22 LTS recommended)
- git and ripgrep (optional but recommended)
- macOS, Linux or WSL. Design target: MacBook Pro M2 Pro, 16 GB.

## Install

```bash
git clone <this repo> ~/tools/cortex-local
cd ~/tools/cortex-local
npm install          # builds better-sqlite3 (prebuilt binaries for Apple Silicon)
npm link             # puts `cortex` on your PATH (needed for `cortex run`)
```

Install with the **same Node version Codex will use** to launch the server. `better-sqlite3` is a native module tied to the Node ABI. `cortex init` writes the absolute path of that Node binary into the Codex config for this reason.

## Set up a repository

```bash
cd ~/code/my-project
cortex init --register   # .codex/config.json, .codex/skills/*, AGENTS.md block, .gitignore, first index,
                         # and [mcp_servers.cortex] in ~/.codex/config.toml (backup kept)
cortex doctor            # verify everything
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
| `cortex_search_code` | Ranked snippets with `file:start-end` (`query`, `symbol_only`, `path_filter`, `max_results`) |
| `cortex_index_sync` | Incremental re-index (`force_full_reindex` to rebuild) |
| `cortex_memory_query` | Search memories (`query` may be `""` to list) |
| `cortex_memory_save` | Save a fact; contradictions are contested, `supersedes` overwrites deliberately |
| `cortex_memory_manage` | `get`, `history`, `verify`, `rollback`, `delete` |
| `cortex_checkpoint_save` | Snapshot goal / files / errors / decisions / next step |
| `cortex_checkpoint_resume` | Recovery pack (or `list: true`) |
| `cortex_fetch_evicted` | Restore evicted output by hash: `query` (grep, `/regex/`), line range, or full |
| `cortex_investigation_check` | Was this hypothesis or error already explored? Known fix? |
| `cortex_investigation_log` | Record outcome; confirmed solutions become fix patterns |
| `cortex_route` | Skills + memories + investigations + code pointers for a task |
| `cortex_stats` | Savings and latency dashboard |

## CLI

```bash
cortex run -- npm test                    # prune output, keep exit code
cortex run -- "npm run build && npm test" # shell syntax: pass one quoted string
cortex run --raw -- npm test              # bypass pruning
some-cmd 2>&1 | cortex compress --label some-cmd
cortex fetch 3f9a2c1b7d4e --query "ReportService"
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

Example stub from a failing 512-line test run:

```
[cortex] `npm test` exit=1 FAILED · 12.4s · test output · 512 lines (~18.2k tok) → evicted #3f9a2c1b7d4e
summary: Tests:       1 failed, 44 passed, 45 total
signal: ● ReportService › generates scheduled export @ src/report/ReportService.test.ts:88
L132 ● ReportService › generates scheduled export
L140   Expected: 3
L141   Received: 2
L156   at Object.<anonymous> (src/report/ReportService.test.ts:88:21)
known fix (seen 2×, fixed 3d ago): Reset fake timers in beforeEach [src/test/setup.ts]
restore: cortex_fetch_evicted hash=3f9a2c1b7d4e (query="…" or start_line/end_line)
```

## Configuration (`.codex/config.json`)

Defaults live in `src/core/config.js`. Commonly tuned keys:

```json
{
  "index": { "exclude": ["fixtures/**"], "max_file_bytes": 1000000, "auto_sync_interval_sec": 60 },
  "search": { "default_max_results": 5, "snippet_lines": 24 },
  "pruning": { "inline_max_lines": 40, "stub_max_lines": 14 },
  "memory": { "default_min_confidence": 0.7 },
  "semantic": { "enabled": false, "model": "nomic-embed-text" },
  "output_format": "text"
}
```

`index.exclude` extends the built-in excludes (dependencies, build output, lockfiles, binaries); set `index.replace_default_excludes: true` to replace them. `output_format: "json"` returns raw data instead of the compact text renderings.

Environment overrides: `CORTEX_PROJECT_ROOT`, `CORTEX_DATA_DIR`, `CORTEX_DB_PATH`, `CORTEX_GLOBAL_DB`, `CORTEX_LOG_LEVEL`, `CODEX_HOME`.

## Running a local model on a 16 GB M2 Pro (optional)

Everything above is deterministic and needs no model. Codex already supplies the reasoning; a local model only helps with **ranking ambiguous natural-language searches**. On 16 GB, while Codex, an IDE and a browser are running:

- **Recommended:** `ollama pull nomic-embed-text` (~270 MB, a few ms per embedding on M2), then set `"semantic": { "enabled": true }`. The top 20 BM25 candidates are reranked with cached embeddings; if Ollama is down the server falls back to BM25 silently.
- Larger alternatives (`mxbai-embed-large`, ~670 MB) work but add latency for little gain on code.
- Avoid running 7B+ chat models next to Codex on 16 GB. They compete for unified memory and add nothing this engine needs.

The semantic URL must be a loopback address. Anything else is rejected, per the local-only policy.

## Data layout

```
<repo>/
├── AGENTS.md                 # managed Cortex block (your content is preserved)
└── .codex/
    ├── config.json           # engine settings (commit it if you like)
    ├── skills/               # smart-search, task-recovery, bug-investigation, context-pruning
    ├── cortex.db (+ -wal)    # local data (git-ignored)
    └── spool/                # payloads written while the DB was not writable (auto-imported)
~/.codex/global_cortex.db     # cross-project memories
```

If `cortex run` executes in a sandbox where `.codex/` is read-only, it still prunes the output and writes the full payload to a spool directory (`.codex/spool`, `.cortex-spool/` or `$TMPDIR/cortex-local-spool`). The MCP server imports spooled payloads at startup and on fetch.

## Troubleshooting

- `cortex doctor` checks Node, SQLite FTS5, paths, index, AGENTS.md, skills, git, ripgrep, Codex registration, PATH and Ollama.
- `NODE_MODULE_VERSION` mismatch: run `npm rebuild better-sqlite3` with the Node binary that Codex launches.
- Search finds nothing after a branch switch: call `cortex_index_sync` (it also runs automatically when the index is older than `auto_sync_interval_sec`).
- Server logs go to stderr (shown in Codex's MCP logs). Set `"log_to_file": true` to also write `.codex/cortex.log`.
