import { z } from 'zod';

// A tiny parameter DSL that produces both the JSON Schema advertised to Codex (kept deliberately
// simple: object/string/integer/number/boolean/array-of-string, no $refs or unions) and the zod
// validator used on every incoming call. Tolerates stringly-typed numbers/booleans/arrays.

const toNumber = (v) => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
const toBoolean = (v) => (v === 'true' ? true : v === 'false' ? false : v);
const toArray = (v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return [v];
    }
  }
  return s ? [s] : [];
};

const toStringMap = (v) => {
  let value = v;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return v;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, val]) => [k, typeof val === 'string' ? val : String(val ?? '')]));
};

export const S = {
  string: (description, { required = false, min = null, max = null, values = null } = {}) => ({ kind: 'string', description, required, min, max, values }),
  integer: (description, { required = false, min = null, max = null } = {}) => ({ kind: 'integer', description, required, min, max }),
  number: (description, { required = false, min = null, max = null } = {}) => ({ kind: 'number', description, required, min, max }),
  boolean: (description, { required = false } = {}) => ({ kind: 'boolean', description, required }),
  stringArray: (description, { required = false, maxItems = 100, maxLength = 1000 } = {}) => ({ kind: 'stringArray', description, required, maxItems, maxLength }),
  stringMap: (description, { required = false, maxEntries = 20, maxLength = 1000 } = {}) => ({ kind: 'stringMap', description, required, maxEntries, maxLength }),
};

function compileOne(p) {
  switch (p.kind) {
    case 'string': {
      const json = { type: 'string', description: p.description };
      let zs;
      if (p.values) {
        json.enum = p.values;
        zs = z.enum(p.values);
      } else {
        zs = z.string();
        if (p.min != null) zs = zs.min(p.min);
        if (p.max != null) {
          zs = zs.max(p.max);
          json.maxLength = p.max;
        }
      }
      return { json, zod: zs };
    }
    case 'integer':
    case 'number': {
      const json = { type: p.kind, description: p.description };
      let inner = z.number();
      if (p.kind === 'integer') inner = inner.int();
      if (p.min != null) {
        inner = inner.min(p.min);
        json.minimum = p.min;
      }
      if (p.max != null) {
        inner = inner.max(p.max);
        json.maximum = p.max;
      }
      return { json, zod: z.preprocess(toNumber, inner) };
    }
    case 'boolean':
      return { json: { type: 'boolean', description: p.description }, zod: z.preprocess(toBoolean, z.boolean()) };
    case 'stringArray':
      return {
        json: { type: 'array', items: { type: 'string' }, description: p.description, maxItems: p.maxItems },
        zod: z.preprocess(toArray, z.array(z.string().max(p.maxLength)).max(p.maxItems)),
      };
    case 'stringMap':
      return {
        json: { type: 'object', description: p.description, additionalProperties: { type: 'string' } },
        zod: z.preprocess(
          toStringMap,
          z.record(z.string(), z.string().max(p.maxLength)).refine((o) => {
            const n = Object.keys(o).length;
            return n >= 1 && n <= p.maxEntries;
          }, `must have 1-${p.maxEntries} entries`),
        ),
      };
    default:
      throw new Error(`unknown parameter kind ${p.kind}`);
  }
}

export function compileParams(params) {
  const properties = {};
  const required = [];
  const shape = {};
  for (const [key, p] of Object.entries(params)) {
    const { json, zod } = compileOne(p);
    properties[key] = json;
    if (p.required) required.push(key);
    // Optional fields also accept an explicit null (some clients send null for "not provided").
    shape[key] = p.required ? zod : z.preprocess((v) => (v === null ? undefined : v), zod.optional());
  }
  const inputSchema = { type: 'object', properties };
  if (required.length) inputSchema.required = required;
  return { inputSchema, zod: z.object(shape) };
}

export function formatZodError(error) {
  return (error?.issues ?? []).map((i) => `${(i.path ?? []).join('.') || '(arguments)'}: ${i.message}`).join('; ') || String(error);
}
