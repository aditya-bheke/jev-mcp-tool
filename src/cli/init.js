import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { USER_CONFIG_TEMPLATE } from '../core/config.js';
import { gitTopLevel } from '../core/git.js';
import { codexHome, ensureDir } from '../core/paths.js';
import { AGENTS_BEGIN, AGENTS_END, GITIGNORE_LINES, SKILLS, agentsBlock, codexTomlSnippet } from './templates.js';

const BIN_PATH = fileURLToPath(new URL('../../bin/cortex.js', import.meta.url));

function onPath(command) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null;
}

function exists(root, name) {
  return fs.existsSync(path.join(root, name));
}

/** Best-effort detection of the project's build / test / lint commands for AGENTS.md. */
export function detectCommands(root) {
  const commands = {};
  if (exists(root, 'package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const scripts = pkg.scripts ?? {};
      let pm = 'npm';
      if (exists(root, 'pnpm-lock.yaml')) pm = 'pnpm';
      else if (exists(root, 'yarn.lock')) pm = 'yarn';
      else if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) pm = 'bun';
      const run = (name) => (pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name}`);
      if (scripts.build) commands.build = run('build');
      if (scripts.test) commands.test = run('test');
      if (scripts.lint) commands.lint = run('lint');
      else if (scripts.typecheck) commands.lint = run('typecheck');
    } catch {
      /* unreadable package.json */
    }
  }
  if (exists(root, 'Cargo.toml')) {
    commands.build ??= 'cargo build';
    commands.test ??= 'cargo test';
    commands.lint ??= 'cargo clippy';
  }
  if (exists(root, 'go.mod')) {
    commands.build ??= 'go build ./...';
    commands.test ??= 'go test ./...';
    commands.lint ??= 'go vet ./...';
  }
  if (exists(root, 'gradlew')) {
    commands.build ??= './gradlew build -x test';
    commands.test ??= './gradlew test';
  } else if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) {
    commands.build ??= 'gradle build -x test';
    commands.test ??= 'gradle test';
  }
  if (exists(root, 'pom.xml')) {
    commands.build ??= 'mvn -q compile';
    commands.test ??= 'mvn -q test';
  }
  if (exists(root, 'pyproject.toml') || exists(root, 'setup.py') || exists(root, 'requirements.txt')) {
    commands.test ??= 'pytest -q';
    commands.lint ??= 'ruff check .';
  }
  if (exists(root, 'Makefile')) {
    commands.build ??= 'make';
  }
  return commands;
}

function upsertManagedBlock(file, block) {
  const managed = `${AGENTS_BEGIN}\n${block.trim()}\n${AGENTS_END}`;
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    content = '';
  }
  const start = content.indexOf(AGENTS_BEGIN);
  const end = content.indexOf(AGENTS_END);
  let next;
  let status;
  if (start !== -1 && end > start) {
    next = `${content.slice(0, start)}${managed}${content.slice(end + AGENTS_END.length)}`;
    status = 'updated';
  } else if (content.trim()) {
    next = `${content.trimEnd()}\n\n${managed}\n`;
    status = 'appended to';
  } else {
    next = `# AGENTS.md\n\n${managed}\n`;
    status = 'created';
  }
  if (next === content) return 'unchanged';
  fs.writeFileSync(file, next);
  return status;
}

function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    content = '';
  }
  const existing = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !l.startsWith('#') && !existing.has(l));
  if (!missing.length) return 'unchanged';
  const header = existing.has(GITIGNORE_LINES[0]) ? [] : [GITIGNORE_LINES[0]];
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}${content ? '\n' : ''}${[...header, ...missing].join('\n')}\n`);
  return `added ${missing.length} line(s)`;
}

function registerWithCodex(snippet) {
  const home = codexHome();
  const file = path.join(home, 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  if (/^\s*\[mcp_servers\.cortex\]/m.test(text)) return `Codex config already has [mcp_servers.cortex] (${file}); left unchanged`;
  ensureDir(home);
  if (text) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  const prefix = text ? `${text.endsWith('\n') ? '' : '\n'}\n` : '';
  fs.writeFileSync(file, `${text}${prefix}${snippet}\n`);
  return `registered [mcp_servers.cortex] in ${file}${text ? ' (backup saved next to it)' : ''}`;
}

export async function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      force: { type: 'boolean' },
      register: { type: 'boolean' },
      'no-index': { type: 'boolean' },
      'no-agents': { type: 'boolean' },
      'no-skills': { type: 'boolean' },
    },
  });
  const cwd = process.cwd();
  const root = process.env.CORTEX_PROJECT_ROOT ? path.resolve(process.env.CORTEX_PROJECT_ROOT) : gitTopLevel(cwd) ?? cwd;
  const rel = (p) => path.relative(root, p) || p;
  const report = [];
  const cortexCmd = onPath('cortex') ? 'cortex' : `node ${JSON.stringify(BIN_PATH)}`;

  const dataDir = path.join(root, '.codex');
  ensureDir(dataDir);

  const configFile = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configFile) || values.force) {
    fs.writeFileSync(configFile, `${JSON.stringify(USER_CONFIG_TEMPLATE, null, 2)}\n`);
    report.push(`wrote ${rel(configFile)}`);
  } else {
    report.push(`kept ${rel(configFile)}`);
  }

  if (!values['no-skills']) {
    for (const [name, body] of Object.entries(SKILLS)) {
      const file = path.join(dataDir, 'skills', name, 'SKILL.md');
      if (fs.existsSync(file) && !values.force) {
        report.push(`kept ${rel(file)}`);
        continue;
      }
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, body.split('{{CORTEX}}').join(cortexCmd));
      report.push(`wrote ${rel(file)}`);
    }
  }

  if (!values['no-agents']) {
    const status = upsertManagedBlock(path.join(root, 'AGENTS.md'), agentsBlock({ cortexCmd, commands: detectCommands(root) }));
    report.push(`${status} AGENTS.md (managed block)`);
  }

  report.push(`.gitignore: ${ensureGitignore(root)}`);

  const snippet = codexTomlSnippet({ node: process.execPath, script: BIN_PATH });
  let registered = false;
  if (values.register) {
    report.push(registerWithCodex(snippet));
    registered = true;
  }

  if (!values['no-index']) {
    try {
      const { createContext } = await import('../core/context.js');
      const ctx = createContext({ root, mode: 'cli', logLevel: 'warn' });
      try {
        const stats = await ctx.engines.indexer.sync({ reason: 'init' });
        report.push(`indexed ${stats.discovered} files (${stats.chunks_written} chunks) in ${stats.duration_ms}ms via ${stats.source}`);
      } finally {
        ctx.close();
      }
    } catch (err) {
      report.push(`index skipped: ${err.message} (run \`cortex doctor\`)`);
    }
  }

  const lines = [`cortex-local initialised in ${root}`, ...report.map((r) => `  - ${r}`), ''];
  if (!registered) {
    lines.push('Register the MCP server with Codex (or rerun with --register), in ~/.codex/config.toml:', '', snippet, '');
  }
  if (cortexCmd !== 'cortex') {
    lines.push('Tip: run `npm link` in the cortex-local folder so Codex can call `cortex run -- <cmd>` by name, then rerun `cortex init --force`.', '');
  }
  try {
    const { loadConfig } = await import('../core/config.js');
    if (!fs.existsSync(loadConfig(dataDir).jev.model_path)) {
      lines.push('Jev model not downloaded yet: run `cortex model pull` (~530 MB) to enable model-based output triage.', '');
    }
  } catch {
    /* config errors are reported by `cortex doctor` */
  }
  lines.push('Next: restart Codex in this repository and ask it to call cortex_checkpoint_resume.');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
