// Subsystem H: pre-write secret scrubbing.
// STRICT patterns are high-precision token formats and are safe to apply to source code.
// CONTEXTUAL patterns look at "key = value" shapes; they run on memories, checkpoints, ledgers
// and command output, but never on indexed source (they would corrupt code snippets).

export const REDACTED = '[REDACTED_SECRET]';

const STRICT = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g],
  ['aws_access_key_id', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{24,}/g],
  ['openai_key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe_key', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

const ENV_REFERENCE = /^(?:\$\{?[A-Za-z_]|process\.env|os\.environ|os\.getenv|getenv|env\(|ENV\[|<[^>]*>$|\{\{|%\(|\*{3,}|x{4,}|\[REDACTED)/i;
const PLACEHOLDER = /^(?:true|false|null|none|nil|undefined|changeme|change_me|password|secret|example|placeholder|dummy|test|your[_-].*|xxx+|\.\.\.)$/i;

function looksSecretValue(v) {
  if (!v || v.length < 8) return false;
  if (ENV_REFERENCE.test(v) || PLACEHOLDER.test(v)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false; // property path like config.apiToken
  const hasDigit = /\d/.test(v);
  const hasAlpha = /[A-Za-z]/.test(v);
  const hasSymbol = /[^A-Za-z0-9_]/.test(v);
  const mixedCase = /[a-z]/.test(v) && /[A-Z]/.test(v);
  return (hasDigit && hasAlpha) || (hasSymbol && v.length >= 12) || (v.length >= 24 && mixedCase);
}

const KEY_WORDS = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)`;

const CONTEXTUAL = [
  ['bearer_token', /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, (m, p1) => `${p1}${REDACTED}`],
  ['basic_auth', /\b(Basic\s+)([A-Za-z0-9+/]{16,}={0,2})/g, (m, p1) => `${p1}${REDACTED}`],
  ['url_credentials', /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]{3,})(@)/gi, (m, p1, p2, p3) => `${p1}${REDACTED}${p3}`],
  [
    'env_secret',
    /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|PRIVATE)[A-Z0-9_]*\s*=\s*)(\S.*)$/gm,
    (m, p1, p2) => {
      const value = p2.trim().replace(/^['"]|['"]$/g, '');
      if (!value || ENV_REFERENCE.test(value) || PLACEHOLDER.test(value)) return null;
      return `${p1}${REDACTED}`;
    },
  ],
  [
    'quoted_secret',
    new RegExp(String.raw`(\b[A-Za-z0-9_.-]*?${KEY_WORDS}["']?\s*(?:=|:|=>)\s*)(["'])([^"'\n]{6,})\2`, 'gi'),
    (m, p1, quote, value) => (ENV_REFERENCE.test(value) || PLACEHOLDER.test(value) ? null : `${p1}${quote}${REDACTED}${quote}`),
  ],
  [
    'unquoted_secret',
    new RegExp(String.raw`(\b[A-Za-z0-9_.-]*?${KEY_WORDS}\s*(?:=|:)\s*)([^\s"'\x60,;(){}\[\]<>]{8,})`, 'gi'),
    (m, p1, value) => (looksSecretValue(value) ? `${p1}${REDACTED}` : null),
  ],
];

/**
 * Replace secrets with [REDACTED_SECRET].
 * @param {string} text
 * @param {{strict?: boolean}} [opts] strict=true applies only the high-precision patterns.
 * @returns {{text: string, count: number, kinds: string[]}}
 */
export function scrubSecrets(text, { strict = false } = {}) {
  if (text == null) return { text: '', count: 0, kinds: [] };
  let out = String(text);
  let count = 0;
  const kinds = new Set();
  for (const [name, re] of STRICT) {
    out = out.replace(re, () => {
      count++;
      kinds.add(name);
      return REDACTED;
    });
  }
  if (!strict) {
    for (const [name, re, replacer] of CONTEXTUAL) {
      out = out.replace(re, (...args) => {
        const match = args[0];
        const groups = args.slice(1, -2); // no named groups: (match, ...groups, offset, input)
        const replaced = replacer(match, ...groups);
        if (replaced == null) return match;
        count++;
        kinds.add(name);
        return replaced;
      });
    }
  }
  return { text: out, count, kinds: [...kinds] };
}
