import { createHash } from 'node:crypto';

const KEY_RE = /(pass(word|wd)?|pwd|secret|token|api[_-]?key|authorization|private[_-]?key|credential|cvv|cvc|card[_-]?number|ssn|access[_-]?key)/i;

const VALUE_PATTERNS: RegExp[] = [
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
];

const MASK = '[redacted]';

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactString(s: string): string {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, MASK);
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const d = m.replace(/[ -]/g, '');
    return d.length >= 13 && d.length <= 19 && luhn(d) ? MASK : m;
  });
  return out;
}

export function redact(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return KEY_RE.test(key) ? MASK : redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

/** Stable JSON: keys sorted so equal arguments hash equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
