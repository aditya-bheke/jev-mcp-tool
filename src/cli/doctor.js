import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexHome, ensureDir, findProjectRoot, resolvePaths } from '../core/paths.js';
import { relTime } from '../core/util.js';
import { AGENTS_BEGIN } from './templates.js';

function version(command, args = ['--version']) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).split('\n')[0].trim();
}

async function checkJev(cfg, add) {
  if (!cfg.enabled) {
    add('ok', 'Jev engine', 'disabled (deterministic pruning only)');
    return;
  }
  let runtime = true;
  try {
    await import('node-llama-cpp');
    add('ok', 'node-llama-cpp', 'installed');
  } catch (err) {
    runtime = false;
    add('warn', 'node-llama-cpp', `not installed (${err.message}); run \`npm install\`. Pruning falls back to deterministic rules.`);
  }
  const hasModel = fs.existsSync(cfg.model_path);
  add(hasModel ? 'ok' : 'warn', 'Jev model', hasModel ? cfg.model_path : `missing at ${cfg.model_path}; run \`cortex model pull\``);
  if (!runtime || !hasModel) return;
  const { JevEngine } = await import('../jev/engine.js');
  const engine = new JevEngine(cfg);
  try {
    await engine.load();
    const res = await engine.evaluate({ primitive: 'noul', state: 'BUILD FAILED: 3 tests failed', question: 'Did the build fail?', criteria: { true: 'it failed', false: 'it passed' } });
    const s = engine.status();
    add('ok', 'Jev forward pass', `${s.gpu} · load ${s.load_ms}ms · eval ${res.latency_ms}ms · P(true) ${(res.probability * 100).toFixed(1)}%`);
  } catch (err) {
    add('fail', 'Jev forward pass', err.message);
  } finally {
    await engine.dispose();
  }
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
    ensureDir(dataDir);
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
      await checkJev(ctx.config.jev, add);
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
