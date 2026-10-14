import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createContext } from './core/context.js';
import { JevEngine } from './jev/engine.js';
import { startEvaluationHost } from './jev/ipc.js';
import { log } from './core/logger.js';
import { findProjectRoot } from './core/paths.js';
import { CortexError, withTimeout } from './core/util.js';
import { formatZodError } from './tools/schema.js';
import { buildTools } from './tools/registry.js';
import { VERSION } from './version.js';

export const SERVER_INSTRUCTIONS = [
  'Cortex-Local: local memory, code index and context pruning for this repository (100% on-device).',
  '- Session start / after compaction: cortex_checkpoint_resume. New task: cortex_route.',
  '- Find code by concept or symbol: cortex_search_code (line-ranged snippets). Use rg only for exact strings.',
  '- Wrap verbose shell commands as `cortex run -- <cmd>`: the local Jev model keeps high-signal output and replaces noise with a context receipt; restore with cortex_fetch_evicted.',
  '- Before a speculative fix: cortex_investigation_check; afterwards: cortex_investigation_log.',
  '- Durable facts: cortex_memory_save / cortex_memory_query. Progress: cortex_checkpoint_save.',
].join('\n');

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function safeLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

async function runStartupTasks(ctx) {
  const { engines, config } = ctx;
  try {
    engines.evicted.importSpool();
  } catch (err) {
    log.warn(`spool import failed: ${err.message}`);
  }
  try {
    engines.evicted.prune();
    engines.telemetry.prune(config.retention.telemetry_days);
  } catch (err) {
    log.warn(`retention pruning failed: ${err.message}`);
  }
  if (ctx.root && config.index.index_on_startup) {
    const stats = await engines.indexer.sync({ reason: 'startup' });
    log.info(`index ready via ${stats.source}: ${stats.discovered} files, +${stats.added} ~${stats.updated} -${stats.pruned} in ${stats.duration_ms}ms`);
  }
}

/**
 * Start the MCP server on stdio. The project context is created lazily once the client is
 * initialised, so MCP roots (if the client provides them) can decide the project root.
 */
export async function startServer({ cwd = process.cwd(), root = null } = {}) {
  const tools = buildTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server({ name: 'cortex-local', version: VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });

  let ctx = null;
  let ctxPromise = null;
  let jevHost = null;

  /** Jev engine lives for the whole server process: preload in the background, host the CLI socket. */
  function startJev(context) {
    const cfg = context.config.jev;
    context.jev = new JevEngine(cfg);
    if (!cfg.enabled) return;
    if (cfg.preload) {
      context.jev.load().catch((err) => log.warn(`Jev engine unavailable (${err.message}); deterministic pruning stays active`));
    }
    if (cfg.host) {
      startEvaluationHost(context.jev)
        .then((host) => {
          jevHost = host;
        })
        .catch((err) => log.debug(`Jev host failed: ${err.message}`));
    }
  }

  async function rootFromClient() {
    try {
      const caps = server.getClientCapabilities();
      if (!caps?.roots) return null;
      const res = await withTimeout(server.listRoots(), 2000, 'roots/list');
      for (const r of res?.roots ?? []) {
        if (typeof r.uri === 'string' && r.uri.startsWith('file://')) return fileURLToPath(r.uri);
      }
    } catch (err) {
      log.debug(`client roots unavailable: ${err.message}`);
    }
    return null;
  }

  function getContext() {
    if (ctx) return Promise.resolve(ctx);
    if (!ctxPromise) {
      ctxPromise = (async () => {
        let explicit = root;
        if (!explicit && !process.env.CORTEX_PROJECT_ROOT) {
          const clientRoot = await rootFromClient();
          if (clientRoot) explicit = findProjectRoot(clientRoot) ?? clientRoot;
        }
        const created = explicit ? createContext({ root: explicit, mode: 'server' }) : createContext({ cwd, mode: 'server' });
        ctx = created;
        startJev(created);
        log.info(`cortex-local ${VERSION} · project ${created.root ?? '(none: global mode)'} · db ${created.dbPath}`);
        setImmediate(() => {
          runStartupTasks(created).catch((err) => log.warn(`startup tasks failed: ${err.message}`));
        });
        return created;
      })();
      ctxPromise.catch((err) => {
        log.error(`failed to initialise: ${err.message}`);
        ctxPromise = null;
      });
    }
    return ctxPromise;
  }

  server.oninitialized = () => {
    getContext().catch(() => {});
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const tool = byName.get(name);
    if (!tool) return errorResult(`Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}`);
    const parsed = tool.zod.safeParse(args);
    if (!parsed.success) return errorResult(`Invalid arguments for ${name}: ${formatZodError(parsed.error)}`);

    let context;
    try {
      context = await getContext();
    } catch (err) {
      return errorResult(`Cortex failed to start: ${err.message}`);
    }
    const t0 = performance.now();
    try {
      const out = await tool.handler(context, parsed.data);
      const parts = context.config.output_format === 'json' ? [JSON.stringify(out.data)] : out.parts ?? [out.text];
      context.engines.telemetry.record('tool_call', {
        tool: name,
        latency_ms: performance.now() - t0,
        input_chars: safeLength(args),
        output_chars: parts.reduce((n, part) => n + part.length, 0),
      });
      return { content: parts.map((part) => ({ type: 'text', text: part })) };
    } catch (err) {
      const known = err instanceof CortexError;
      if (!known) log.error(`tool ${name} failed`, err);
      context.engines.telemetry.record('tool_error', { tool: name, latency_ms: performance.now() - t0, meta: { code: err?.code ?? 'INTERNAL' } });
      return errorResult(known ? `${err.code}: ${err.message}` : `Internal error in ${name}: ${err?.message ?? String(err)}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`cortex-local ${VERSION} MCP server listening on stdio (${tools.length} tools)`);

  let closing = false;
  const shutdown = (reason) => {
    if (closing) return;
    closing = true;
    log.info(`shutting down (${reason})`);
    try {
      jevHost?.close();
    } catch {
      /* ignore */
    }
    try {
      ctx?.close();
    } catch {
      /* ignore */
    }
    process.exit(0); // native llama.cpp resources are released by the OS
  };
  server.onclose = () => shutdown('transport closed');
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}
