import {
  BARE_FAIL_HEADER, CONTEXT, FRAME, LIB_FRAME, LOCATION, NOISE, WARNING, formatLocation, isErrorLine, isSummaryLine,
} from './patterns.js';
import { estimateTokens, formatCount, formatDuration, oneLine, relTime, shortHash, truncate } from '../core/util.js';

/** Rough category of a command's output, from the command line first and content second. */
export function classifyCommand(command, lines = []) {
  const c = String(command ?? '').toLowerCase();
  if (/\b(?:test|tests|jest|vitest|mocha|ava|pytest|unittest|nose2?|rspec|minitest|phpunit|ctest|karma|cypress|playwright|spec)\b|go test|cargo test|mvn\b.*\btest|gradlew?\b.*\btest|dotnet test|mix test|swift test|npm t\b/.test(c)) return 'test output';
  if (/\b(?:lint|eslint|tslint|ruff|flake8|pylint|mypy|pyright|clippy|golangci-lint|rubocop|stylelint|prettier|black|isort|shellcheck|ktlint|detekt|checkstyle|biome)\b/.test(c)) return 'lint output';
  if (/\b(?:build|compile|tsc|make|cmake|ninja|webpack|vite|rollup|esbuild|parcel|javac|gcc|g\+\+|clang|rustc|mvn|gradle|gradlew|xcodebuild|bazel)\b|cargo (?:build|check)|go build|dotnet build|swift build/.test(c)) return 'build output';
  if (/\b(?:install|ci|pip|pip3|poetry|bundle|brew|apt|apt-get|yarn|pnpm)\b|npm i\b/.test(c)) return 'install log';
  if (/\bgit\b/.test(c)) return 'git output';
  if (/\b(?:ls|find|tree|fd)\b/.test(c)) return 'file listing';
  if (/\b(?:grep|rg|ag|ack)\b/.test(c)) return 'search output';
  if (lines.some((l) => /\b(?:Traceback|Exception in thread|panicked at)\b/.test(l))) return 'stack trace';
  return 'command output';
}

/**
 * Utility scoring (Subsystem B): every line gets a score.
 *   errors 10 · summaries 8 · project stack frames / locations 6 · error context ~6 · warnings 3
 *   library frames 0.3 · progress/noise 0.1 · duplicates 0 (counted instead).
 */
export function analyzeOutput(lines, { command = null, root = null } = {}) {
  const n = lines.length;
  const scores = new Float32Array(n);
  const kinds = new Array(n).fill(null);
  const seen = new Map();
  const dupCount = new Map();
  const errorIdx = [];
  const summaryIdx = [];
  let errorCount = 0;
  let warningCount = 0;
  let traceFrames = 0;

  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      traceFrames = 0;
      continue;
    }
    const norm = t.replace(/\d+(?:\.\d+)?\s*m?s\b/g, '#').slice(0, 300);
    const first = seen.get(norm);
    if (first !== undefined) {
      dupCount.set(first, (dupCount.get(first) ?? 1) + 1);
      continue;
    }
    seen.set(norm, i);

    let score = 1;
    let kind = null;
    if (FRAME.test(line)) {
      traceFrames++;
      kind = 'frame';
      score = LIB_FRAME.test(t) ? 0.3 : traceFrames <= 3 ? 6 : 2;
    } else {
      traceFrames = 0;
      if (isSummaryLine(t)) {
        kind = 'summary';
        score = 8;
        summaryIdx.push(i);
      } else if (isErrorLine(t)) {
        kind = 'error';
        score = 10;
        errorCount++;
        errorIdx.push(i);
      } else if (LOCATION.test(line) && !LIB_FRAME.test(line)) {
        kind = 'location';
        score = 6;
      } else if (WARNING.test(t)) {
        kind = 'warning';
        score = 3;
        warningCount++;
      } else if (NOISE.test(t)) {
        kind = 'noise';
        score = 0.1;
      }
    }
    scores[i] = score;
    kinds[i] = kind;
  }

  // Lines right after an error (expected/received, code excerpts, carets) inherit importance.
  for (const i of errorIdx) {
    for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) {
      if (kinds[j] === 'error') break;
      const t = lines[j].trim();
      if (!t) break;
      if (CONTEXT.test(t) || /^\s{2,}\S/.test(lines[j])) scores[j] = Math.max(scores[j], 6.5 - (j - i) * 0.5);
    }
  }

  const firstErrIdx = errorIdx.find((i) => !BARE_FAIL_HEADER.test(lines[i].trim())) ?? errorIdx[0];
  const firstError = firstErrIdx != null ? lines[firstErrIdx].trim() : null;
  let location = null;
  if (firstErrIdx != null) {
    for (let j = firstErrIdx; j < Math.min(n, firstErrIdx + 40); j++) {
      const m = LOCATION.exec(lines[j]);
      if (m && !LIB_FRAME.test(lines[j])) {
        location = formatLocation(m);
        break;
      }
    }
  }
  if (location && root) location = location.split(`${root}/`).join('');
  const summary = summaryIdx.length ? lines[summaryIdx[summaryIdx.length - 1]].trim() : null;
  const signalText = firstError
    ? `${oneLine(firstError, 160)}${location && !firstError.includes(location.split(':')[0]) ? ` @ ${location}` : ''}`
    : null;

  return {
    lines,
    scores,
    kinds,
    dupCount,
    errorIdx,
    summaryIdx,
    errorCount,
    warningCount,
    classification: classifyCommand(command, lines.slice(0, 200)),
    summary,
    signalText,
  };
}

function selectLines(analysis, budget, skip) {
  const { scores, kinds, lines } = analysis;
  const candidates = [];
  for (let i = 0; i < lines.length; i++) if (scores[i] >= 2 && !skip.has(i)) candidates.push(i);
  candidates.sort((a, b) => scores[b] - scores[a] || a - b);
  const picked = new Set();
  for (const i of candidates) {
    if (picked.size >= budget) break;
    if (picked.has(i)) continue;
    picked.add(i);
    if (kinds[i] === 'error') {
      for (let j = i + 1; j <= i + 3 && j < lines.length && picked.size < budget; j++) {
        if (kinds[j] === 'error') break;
        if (scores[j] >= 5 && !skip.has(j)) picked.add(j);
      }
    }
  }
  return [...picked].sort((a, b) => a - b);
}

function renderLine(analysis, i, lineMax) {
  const raw = analysis.lines[i];
  const indent = /^\s{2,}/.test(raw) ? '  ' : '';
  const count = analysis.dupCount.get(i);
  return `L${i + 1} ${indent}${truncate(raw.trim(), lineMax)}${count > 1 ? ` (×${count})` : ''}`;
}

export function knownFixLine(known) {
  const files = (known.fix_files ?? []).slice(0, 3).join(', ');
  const when = known.resolved_at ? `, fixed ${relTime(known.resolved_at)}` : '';
  return `known fix (seen ${known.occurrences}×${when}): ${oneLine(known.fix_summary, 160)}${files ? ` [${files}]` : ''}`;
}

export function repeatLine(repeat) {
  const ref = repeat.evicted_hash ? ` (#${shortHash(repeat.evicted_hash)})` : '';
  return `⚠ identical failure to the run ${relTime(repeat.created_at)}${ref}: the last change did not affect this output`;
}

/** Build the compact context stub that replaces an evicted payload (default ≤ 14 lines). */
export function buildStub({
  analysis, hash, command, exitCode, durationMs, known, repeat, maxLines, lineMax, lineCount, charCount, truncatedBytes = 0, pKeep = null,
}) {
  const failed = exitCode != null ? exitCode !== 0 : analysis.errorCount > 0;
  const status = exitCode == null ? (failed ? 'errors detected' : 'no errors detected') : failed ? 'FAILED' : 'ok';
  const head = [
    `[cortex] ${command ? `\`${oneLine(command, 80)}\` ` : ''}exit=${exitCode ?? '?'} ${status}`,
    durationMs != null ? formatDuration(durationMs) : null,
    analysis.classification,
    pKeep != null ? `P(keep) ${(pKeep * 100).toFixed(1)}%` : null,
    `${formatCount(lineCount)} lines (~${formatCount(estimateTokens(charCount))} tok) → stored #${hash.slice(0, 16)}`,
    truncatedBytes ? `capture truncated (${formatCount(truncatedBytes)} bytes dropped)` : null,
  ].filter(Boolean).join(' · ');

  const out = [head];
  const skip = new Set();
  if (analysis.summary) {
    out.push(`summary: ${oneLine(analysis.summary, lineMax)}`);
    skip.add(analysis.summaryIdx[analysis.summaryIdx.length - 1]);
  }
  if (failed && analysis.signalText) out.push(`signal: ${analysis.signalText}`);

  const extras = [];
  if (known) extras.push(knownFixLine(known));
  if (repeat) extras.push(repeatLine(repeat));

  const footerReserve = 1;
  const room = Math.max(2, maxLines - out.length - extras.length - footerReserve);
  const budget = failed ? room : Math.min(room, 4);
  const body = selectLines(analysis, budget, skip);
  for (const i of body) out.push(renderLine(analysis, i, lineMax));
  out.push(...extras);

  const shownErrors = body.filter((i) => analysis.kinds[i] === 'error').length;
  const more = analysis.errorCount - shownErrors;
  const footer = `restore: cortex_fetch_evicted hash=${hash.slice(0, 16)} (query="…" or start_line/end_line)${more > 0 ? ` · +${more} more error lines` : ''}`;
  out.push(footer);
  return out.join('\n');
}
