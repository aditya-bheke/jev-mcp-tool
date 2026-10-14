import { VERSION } from '../version.js';

export const HELP = `cortex-local ${VERSION}: local memory, code index and context pruning for Codex

Usage: cortex <command> [options]

Server
  serve [--root <dir>]                 Start the MCP server on stdio (what Codex launches)

Setup
  init [--register] [--force] [--no-index] [--no-agents] [--no-skills]
                                       Scaffold .codex/ (config + skills), the AGENTS.md block,
                                       .gitignore entries and the initial index
  doctor                               Check Node, SQLite FTS5, paths, Codex config, ripgrep, Jev model
  config                               Print the effective configuration

Jev decision model (local Qwen2.5-0.5B GGUF)
  model pull [--force] [--url <u>]     Download the model weights (~530 MB, one time)
  model status                         Load the model and run a probe evaluation
  model bench [--runs <n>]             Warm forward-pass latency and RSS over n passes

Context pruning
  run [--label <s>] [--max-lines <n>] [--timeout <sec>] [--raw] -- <command...>
                                       Run a command; the Jev model keeps high-signal output and
                                       replaces noise with a context receipt. Exit code is preserved.
  compress [--label <s>] [--exit-code <n>]
                                       Prune text from stdin (some-cmd 2>&1 | cortex compress)
  fetch <hash> [--query <q>] [--start <n>] [--end <n>]
                                       Restore evicted output

Code index
  index [--full]                       Incremental (or full) re-index
  search <query> [--path <p>] [--symbols] [-n <k>]
  bench <query...> [--runs <n>]        Indexed search latency vs a ripgrep scan

Memory & tasks
  memory list [--category <c>]
  memory search <query>
  memory add --title <t> --category <c> --content <text> [--global] [--source <s>] [--confidence <n>]
  memory verify|delete <id> · memory history [id] · memory rollback <version>
  memory export [file] · memory import <file> [--global]
  checkpoint [--list] [--id <id>]      Show the recovery pack for the latest checkpoint
  route <task>                         Skills, memories, investigations and code for a task
  stats [--days <n>]                   Token savings, latency and usage dashboard

Most commands accept --json.
`;

export async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'serve': {
      const { cmdServe } = await import('./commands.js');
      return cmdServe(rest);
    }
    case 'run': {
      const { cmdRun } = await import('./run.js');
      return cmdRun(rest);
    }
    case 'compress': {
      const { cmdCompress } = await import('./run.js');
      return cmdCompress(rest);
    }
    case 'init': {
      const { cmdInit } = await import('./init.js');
      return cmdInit(rest);
    }
    case 'doctor': {
      const { cmdDoctor } = await import('./doctor.js');
      return cmdDoctor(rest);
    }
    case 'model': {
      const { cmdModel } = await import('./model.js');
      return cmdModel(rest);
    }
    default: {
      const { COMMANDS } = await import('./commands.js');
      const fn = COMMANDS[command];
      if (!fn) {
        process.stderr.write(`cortex: unknown command "${command}"\n\n${HELP}`);
        return 2;
      }
      return fn(rest);
    }
  }
}
