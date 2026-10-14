#!/usr/bin/env node
import { main } from '../src/cli/main.js';

const command = process.argv[2];

main(process.argv.slice(2))
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
    // One-shot commands must not hang on lingering native handles (llama.cpp): exit after a grace period.
    if (command !== 'serve') setTimeout(() => process.exit(), 3000).unref();
  })
  .catch((err) => {
    process.stderr.write(`cortex: ${err?.message ?? err}\n`);
    if (process.env.CORTEX_DEBUG) process.stderr.write(`${err?.stack ?? ''}\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(), 3000).unref();
  });
