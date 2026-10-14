import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureDir } from '../core/paths.js';

function isGguf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    return magic.toString('ascii') === 'GGUF';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Download model weights to `dest` (explicit, one-time user action; runtime never touches the network).
 * Writes to `<dest>.part`, verifies length and the GGUF magic, then renames atomically.
 */
export async function downloadModel({ url, dest, force = false, onProgress = null }) {
  if (!force && fs.existsSync(dest)) return { dest, bytes: fs.statSync(dest).size, skipped: true };
  ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || null;
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
    if (total && received !== total) throw new Error(`incomplete download: ${received} of ${total} bytes`);
    if (!isGguf(part)) throw new Error('downloaded file is not a GGUF model');
    fs.renameSync(part, dest);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
  return { dest, bytes: received, skipped: false };
}
