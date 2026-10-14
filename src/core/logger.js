import fs from 'node:fs';

// All logging goes to stderr: in `serve` mode stdout is reserved for MCP JSON-RPC.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const envLevel = process.env.CORTEX_LOG_LEVEL;

const state = {
  level: envLevel && LEVELS[envLevel] !== undefined ? envLevel : 'info',
  file: null,
};

export function configureLogger({ level, file } = {}) {
  if (level && LEVELS[level] !== undefined && !(envLevel && LEVELS[envLevel] !== undefined)) state.level = level;
  if (file !== undefined) state.file = file;
}

function describe(detail) {
  if (detail === undefined) return '';
  if (detail instanceof Error) return ` ${detail.stack || detail.message}`;
  if (typeof detail === 'string') return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

function emit(level, message, detail) {
  if (LEVELS[level] < LEVELS[state.level]) return;
  const line = `[cortex] ${new Date().toISOString()} ${level.toUpperCase()} ${message}${describe(detail)}\n`;
  try {
    process.stderr.write(line);
  } catch {
    /* stderr closed */
  }
  if (state.file) {
    try {
      fs.appendFileSync(state.file, line);
    } catch {
      /* log file not writable */
    }
  }
}

export const log = {
  debug: (message, detail) => emit('debug', message, detail),
  info: (message, detail) => emit('info', message, detail),
  warn: (message, detail) => emit('warn', message, detail),
  error: (message, detail) => emit('error', message, detail),
};
