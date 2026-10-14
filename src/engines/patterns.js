// Line classifiers shared by the output pruner (Subsystem B) and error intelligence (Subsystem G).

const ERROR_CI = /\b(?:error|errors|exception|traceback|panic(?:ked)?|fatal|failed|failure|failures|failing|segmentation fault|core dumped|unhandled|undefined reference|cannot find symbol|is not defined|is not a function|is not assignable|cannot (?:find|read|resolve|open|import|load|access)|could not (?:find|resolve|load|compile|connect)|no such file|permission denied|assertion failed|timed out|what went wrong|uncaught)\b/i;
const ERROR_CS = /\bFAIL\b|\bERR!|\[ERROR\]|\berror\[E\d+\]|\berror TS\d+|[✗✕✖×❌●]|^E\s+\S|\b[A-Z][a-zA-Z]+(?:Error|Exception)\b/;

export const NEGATED_ERROR = /\b(?:0|no|zero)\s+(?:errors?|failures?|failed|failing|problems?|issues?)\b|\b(?:errors?|failures?|failed):?\s+0\b|\bwithout errors?\b|\berror[-_ ]?(?:handler|handling|boundary|boundaries|page|reporting|logger|codes?)\b|\b(?:on|if|when|catch)\s?error\b|--no-error/i;

const SUMMARY = /^(?:tests?:|test suites?:|test files?\b|snapshots:|ran \d+ tests?|ok(?:\s+\S+\s+[\d.]+m?s|$)|failed \(|test result:|build (?:success(?:ful)?|failed|failure)|tests run:|totals?:|summary\b|done in\b|finished in\b|compiled successfully|compiled with \d+|found \d+ errors?|=+ .*\b(?:passed|failed|errors?|skipped|no tests ran)\b.*=+$|\d+ (?:passing|failing|pending)\b|time:\s|\d+ problems? \(|✨)/i;
const SUMMARY_ANY = /\b\d+ problems? \(\d+ errors?|\btest result:|\bTests run: \d+|\bBUILD (?:SUCCESS|SUCCESSFUL|FAILED|FAILURE)\b|\b\d+ (?:passed|failed)(?:, \d+ \w+)*,? in [\d.]+s\b|\bExecuted \d+ of \d+/i;

export const FRAME = /^\s*(?:at\s+\S|File "[^"]+", line \d+|\d+:\s+0x[0-9a-f]+|#\d+\s+0x[0-9a-f]+|\.\.\. \d+ more$|[\w./-]+\.go:\d+(?:\s+\+0x[0-9a-f]+)?$|goroutine \d+ \[)/;

export const LIB_FRAME = /node_modules|node:internal|internal\/|\(native\)|<anonymous>|java\.base\/|jdk\.internal|sun\.reflect|java\.lang\.reflect|org\.junit|junit\.framework|org\.gradle|org\.apache\.maven|kotlin\.coroutines|site-packages|dist-packages|\/lib\/python\d|\/rustc\/|\/\.cargo\/registry|\/usr\/(?:local\/)?lib|\/go\/src\/runtime|\/Library\/Frameworks|webpack:\/\/\/|processTicksAndRejections|\bat new Promise\b/;

// path:line(:col) | path(line,col) | "path", line N
export const LOCATION = /(?:^|[\s('"`[<])((?:[A-Za-z]:)?\/?(?:[\w.@+-]+\/)*[\w.@+-]*[\w@+-]\.[A-Za-z][A-Za-z0-9]{0,7})(?:["']?(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\)|,\s*line\s+(\d+)))/;

export const WARNING = /\b(?:warn(?:ing)?s?|deprecat(?:ed|ion))\b/i;

export const NOISE = /^(?:downloading|downloaded|resolving|fetching|installing|compiling|building|checking|unpacking|preparing|collecting|requirement already satisfied|using cached|progress|updating|fresh|running \d+ tests?|executing|starting|loading|linking|waiting|reading|writing|generating|copying|added \d+ packages?|removed \d+ packages?|packing|processing|> task|\[\d+\/\d+\]|\d{1,3}%|pass\b|ok\s+\d|test .* \.\.\. ok$|✓|✔|√|\.{3,}$)|[█▉▊▋▌▍▎▏░▒▓]{4,}|\[[=#>-]{8,}/i;

export const CONTEXT = /^(?:expected|received|actual|difference|- expected|\+ received|>|E\s|\^|~+\^?|\||-->|=\s|note:|help:|caused by|\d+\s*\||\+\s|-\s)/i;

/** "FAIL src/foo.test.ts" style headers: real failures, but poor signatures. */
export const BARE_FAIL_HEADER = /^(?:FAIL|FAILED|ERROR|✕|×)\s+[\w./@-]+(?:\s+\([\d.]+\s*m?s\))?$/;

export function isSummaryLine(trimmed) {
  return SUMMARY.test(trimmed) || SUMMARY_ANY.test(trimmed);
}

export function isErrorLine(trimmed) {
  return (ERROR_CI.test(trimmed) || ERROR_CS.test(trimmed)) && !NEGATED_ERROR.test(trimmed);
}

export function formatLocation(match) {
  const line = match[2] ?? match[4] ?? match[6];
  return line ? `${match[1]}:${line}` : match[1];
}
