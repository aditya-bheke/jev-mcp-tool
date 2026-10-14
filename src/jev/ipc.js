import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { log } from '../core/logger.js';

// Local-only IPC so `cortex run` (a separate, short-lived process) can use the model the MCP server
// already holds in memory instead of loading 500+ MB per command. Unix socket (mode 0600) in the
// per-user temp dir, or a named pipe on Windows. One JSON line in, one JSON line out.

const MAX_REQUEST_BYTES = 1_000_000;

export function socketPath() {
  const user = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  if (process.platform === 'win32') return `\\\\.\\pipe\\cortex-jev-${user}`;
  return path.join(os.tmpdir(), `cortex-jev-${user}.sock`);
}

function probe(file, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.createConnection(file);
    const done = (alive) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

function listen(server, file) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(file);
  });
}

/** Serve engine.evaluate() on the local socket. Returns { close() } or null when another host owns it. */
export async function startEvaluationHost(engine) {
  const file = socketPath();
  const server = net.createServer((sock) => {
    let buffer = '';
    let handled = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        sock.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      let reply;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message?.method !== 'evaluate') throw new Error(`unknown method ${message?.method}`);
        reply = { ok: true, result: await engine.evaluate(message.params ?? {}) };
      } catch (err) {
        reply = { ok: false, error: err?.message ?? String(err), code: err?.code ?? null };
      }
      if (!sock.destroyed) sock.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.on('error', (err) => log.debug(`Jev host error: ${err.message}`));

  try {
    await listen(server, file);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') {
      log.debug(`Jev host not started: ${err.message}`);
      return null;
    }
    if (await probe(file)) {
      log.debug('Jev host already served by another cortex process');
      return null;
    }
    try {
      fs.unlinkSync(file); // stale socket from a crashed process
      await listen(server, file);
    } catch (retryErr) {
      log.debug(`Jev host not started: ${retryErr.message}`);
      return null;
    }
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  server.unref();
  log.info(`Jev evaluation host listening on ${file}`);
  return {
    close() {
      server.close();
      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/** Ask a running host to evaluate. Rejects quickly when no host is listening. */
export function requestEvaluation(params, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath());
    let buffer = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Jev host timed out')), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ method: 'evaluate', params })}\n`));
    sock.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (reply.ok) finish(null, reply.result);
        else finish(Object.assign(new Error(reply.error ?? 'Jev host error'), { code: reply.code }));
      } catch (err) {
        finish(err);
      }
    });
    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish(new Error('Jev host closed the connection')));
  });
}
