import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorSignature } from './errorIntel.js';
import { log } from '../core/logger.js';
import { codexHome } from '../core/paths.js';
import { textTerms } from '../core/tokenize.js';
import { clamp, round, safeJsonParse } from '../core/util.js';

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Minimal YAML frontmatter reader: scalars, one level of nested maps, folded/literal blocks. */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const lines = text.slice(3, end).split(/\r?\n/);
  const out = {};
  let currentMap = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s+/.test(raw);
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (/^[>|][-+]?$/.test(value.trim())) {
      const block = [];
      const baseIndent = raw.length - raw.trimStart().length;
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].length - lines[i + 1].trimStart().length > baseIndent)) {
        i++;
        block.push(lines[i].trim());
      }
      value = block.join(' ').trim();
    } else {
      value = unquote(value);
    }
    if (indented && currentMap) {
      currentMap[key] = value;
      continue;
    }
    if (value === '') {
      currentMap = {};
      out[key] = currentMap;
    } else {
      out[key] = value;
      currentMap = null;
    }
  }
  return out;
}

/**
 * Subsystem E: routes a task to the right skills (progressive disclosure: only names and
 * descriptions are scored; the agent opens SKILL.md itself), plus memories, prior
 * investigations, code locations and the latest checkpoint in one call.
 */
export class Router {
  constructor(ctx) {
    this.ctx = ctx;
  }

  skillDirs() {
    const dirs = [];
    if (this.ctx.root) {
      dirs.push({ dir: path.join(this.ctx.root, '.codex', 'skills'), scope: 'repo' });
      dirs.push({ dir: path.join(this.ctx.root, '.agents', 'skills'), scope: 'repo' });
    }
    dirs.push({ dir: path.join(codexHome(), 'skills'), scope: 'user' });
    dirs.push({ dir: path.join(os.homedir(), '.agents', 'skills'), scope: 'user' });
    return dirs;
  }

  displayPath(file) {
    if (this.ctx.root && file.startsWith(`${this.ctx.root}${path.sep}`)) return path.relative(this.ctx.root, file).split(path.sep).join('/');
    const home = os.homedir();
    return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
  }

  loadSkills() {
    const skills = [];
    const seen = new Set();
    for (const { dir, scope } of this.skillDirs()) {
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(dir, entry, 'SKILL.md');
        let text;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const fm = parseFrontmatter(text);
        const name = String(fm.name || entry).trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {};
        const triggers = String(meta.triggers ?? fm.triggers ?? '')
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        skills.push({ name, description: String(fm.description ?? '').trim(), triggers, path: this.displayPath(file), scope });
      }
    }
    return skills;
  }

  scoreSkills(task, skills) {
    const lower = task.toLowerCase();
    const taskTerms = textTerms(task);
    return skills
      .map((skill) => {
        const skillTerms = textTerms(`${skill.name.replace(/[-_]/g, ' ')} ${skill.description} ${skill.triggers.join(' ')}`);
        let overlap = 0;
        for (const t of taskTerms) if (skillTerms.has(t)) overlap++;
        let score = overlap / Math.sqrt(Math.max(1, skillTerms.size));
        for (const trigger of skill.triggers) if (trigger.length >= 3 && lower.includes(trigger)) score += 1;
        return { ...skill, score: round(score, 3) };
      })
      .filter((s) => s.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  async route({ task, max_items = 5 }) {
    const { ctx } = this;
    const k = clamp(Number(max_items) || 5, 1, 10);
    const skills = this.scoreSkills(task, this.loadSkills());
    let memories = [];
    try {
      memories = ctx.engines.memory.query({ query: task, limit: k }).memories;
    } catch (err) {
      log.debug(`route memory lookup failed: ${err.message}`);
    }
    let investigations = [];
    try {
      investigations = ctx.engines.investigations.related(task, 3);
    } catch (err) {
      log.debug(`route investigation lookup failed: ${err.message}`);
    }
    let code = [];
    let codeNote = null;
    if (ctx.root) {
      try {
        const res = await ctx.engines.search.search({ query: task, max_results: k, snippets: false });
        code = res.results;
        if (res.index.warming) codeNote = `index warming (${res.index.warming.done}/${res.index.warming.total})`;
      } catch (err) {
        codeNote = err.message;
      }
    } else {
      codeNote = 'no project root (code search unavailable)';
    }
    let knownFix = null;
    if (/error|exception|fail|traceback|panic/i.test(task)) {
      const sig = errorSignature(task, ctx.root);
      if (sig) knownFix = ctx.engines.errors.lookup(sig.signature);
    }
    const latest = ctx.db.get('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', ctx.projectId);
    const checkpoint = latest && Date.now() - latest.created_at < 3 * 86_400_000
      ? {
        id: latest.id,
        kind: latest.kind,
        goal: latest.goal,
        next_step: safeJsonParse(latest.state_payload, {}).next_step ?? null,
        created_at: latest.created_at,
      }
      : null;
    return { task, skills, memories, investigations, code, code_note: codeNote, known_fix: knownFix, checkpoint };
  }
}
