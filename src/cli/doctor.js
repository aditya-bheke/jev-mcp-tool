import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexHome, findProjectRoot, resolvePaths } from '../core/paths.js';
import { relTime } from '../core/util.js';
import { AGENTS_BEGIN } from './templates.js';

function version(command, args = ['--version']) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).split('\n')[0].trim();
}

export async function cmdDoctor() {
  const checks = [];
  const add = (status, label, detail) => checks.push({ status, label, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? 'ok' : 'fail', 'Node.js', `${process.versions.node} (${process.execPath})${major >= 20 ? '' : ': Node 20+ required'}`);

  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    const sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = "porter unicode61 remove_diacritics 2 tokenchars '_'")`);
    db.close();
    add('ok', 'SQLite + FTS5', `SQLite ${sqlite} via better-sqlite3`);
  } catch (err) {
    add('fail', 'SQLite + FTS5', `${err.message}. Run \`npm rebuild better-sqlite3\` with the same Node that Codex launches.`);
  }

  const root = findProjectRoot(process.cwd());
  add(root ? 'ok' : 'warn', 'Project root', root ?? 'not detected (global mode). Run inside a repository or set CORTEX_PROJECT_ROOT.');
  const { dataDir, dbPath } = resolvePaths(root);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    add('ok', 'Data directory', `${dataDir} (db: ${dbPath})`);
  } catch (err) {
    add('fail', 'Data directory', `${dataDir} is not writable: ${err.message}`);
  }

  try {
    const { createContext } = await import('../core/context.js');
    const ctx = createContext({ mode: 'cli', logLevel: 'error' });
    try {
      if (ctx.root) {
        const s = ctx.engines.indexer.stats();
        add(s.files ? 'ok' : 'warn', 'Code index', s.files ? `${s.files} files · ${s.chunks} chunks · last sync ${relTime(s.last_sync_at)}` : 'empty. Run `cortex index` (or `cortex init`).');
        let agents = '';
        try {
          agents = fs.readFileSync(path.join(ctx.root, 'AGENTS.md'), 'utf8');
        } catch {
          agents = '';
        }
        add(agents.includes(AGENTS_BEGIN) ? 'ok' : 'warn', 'AGENTS.md', agents.includes(AGENTS_BEGIN) ? 'Cortex block present' : 'no Cortex block. Run `cortex init`.');
        const skills = ctx.engines.router.loadSkills().filter((s) => s.scope === 'repo');
        add(skills.length ? 'ok' : 'warn', 'Repo skills', skills.length ? skills.map((s) => s.name).join(', ') : 'none in .codex/skills. Run `cortex init`.');
      }
      if (ctx.config.semantic.enabled) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2000);
          const res = await fetch(new URL('/api/tags', ctx.config.semantic.url), { signal: controller.signal });
          clearTimeout(timer);
          const json = await res.json();
          const names = (json.models ?? []).map((m) => m.name);
          const hasModel = names.some((n) => n === ctx.config.semantic.model || n.startsWith(`${ctx.config.semantic.model}:`));
          add(hasModel ? 'ok' : 'warn', 'Ollama (semantic rerank)', hasModel ? `${ctx.config.semantic.model} available` : `model missing. Run \`ollama pull ${ctx.config.semantic.model}\``);
        } catch (err) {
          add('warn', 'Ollama (semantic rerank)', `not reachable at ${ctx.config.semantic.url} (${err.message}); BM25-only search will be used`);
        }
      } else {
        add('ok', 'Semantic rerank', 'disabled (deterministic BM25 only)');
      }
    } finally {
      ctx.close();
    }
  } catch (err) {
    add('fail', 'Database', err.message);
  }

  const gitVersion = version('git');
  add(gitVersion ? 'ok' : 'warn', 'git', gitVersion ?? 'not found (file discovery falls back to ripgrep or a directory walk)');
  const rgVersion = version('rg');
  add(rgVersion ? 'ok' : 'warn', 'ripgrep', rgVersion ?? 'not found (exact-text fallback uses git grep)');

  const configFile = path.join(codexHome(), 'config.toml');
  let codexConfig = '';
  try {
    codexConfig = fs.readFileSync(configFile, 'utf8');
  } catch {
    codexConfig = '';
  }
  const registered = /^\s*\[mcp_servers\.cortex\]/m.test(codexConfig);
  add(registered ? 'ok' : 'warn', 'Codex MCP registration', registered ? configFile : `no [mcp_servers.cortex] in ${configFile}. Run \`cortex init --register\`.`);

  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cortex'], { encoding: 'utf8' });
  const onPath = which.status === 0 && which.stdout.trim();
  add(onPath ? 'ok' : 'warn', '`cortex` on PATH', onPath ? which.stdout.trim().split('\n')[0] : 'not found. Run `npm link` in the cortex-local folder (needed for `cortex run`).');

  const icon = { ok: '✓', warn: '!', fail: '✗' };
  process.stdout.write(`${checks.map((c) => `${icon[c.status]} ${c.label}: ${c.detail}`).join('\n')}\n`);
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
