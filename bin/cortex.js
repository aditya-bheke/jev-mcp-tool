#!/usr/bin/env node
import { main } from '../src/cli/main.js';

main(process.argv.slice(2))
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`cortex: ${err?.message ?? err}\n`);
    if (process.env.CORTEX_DEBUG) process.stderr.write(`${err?.stack ?? ''}\n`);
    process.exitCode = 1;
  });
