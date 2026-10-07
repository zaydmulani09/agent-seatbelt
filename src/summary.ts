import { words, type ToolClass } from './classify.js';
import { getPath } from './policy.js';

export type Outcome = 'done' | 'error' | 'blocked' | 'approved' | 'denied' | 'timeout' | 'paused';

const pick = (args: unknown, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = getPath(args, k);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join(', ');
    if (typeof v === 'number') return String(v);
  }
  return undefined;
};

const cut = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
const q = (s: string) => `"${cut(s)}"`;

export function toolPhrase(tool: string): string {
  return words(tool.replace(/^.*__/, '')).join(' ') || tool;
}

export interface Phrase {
  past: string;
  inf: string;
}

export function describe(tool: string, cls: ToolClass, args: unknown, currency = '$'): Phrase {
  const a = args ?? {};
  const target = pick(a, ['path', 'file', 'filename', 'filepath', 'url', 'uri', 'name', 'city', 'id', 'key', 'repo', 'title', 'target']);
  const phrase = toolPhrase(tool);
  switch (cls) {
    case 'send': {
      const to = pick(a, ['to', 'recipient', 'recipients', 'email', 'channel', 'address', 'user']);
      const subject = pick(a, ['subject', 'title']);
      const kind = /mail/i.test(tool) ? 'an email' : /post|tweet|publish/i.test(tool) ? 'a post' : 'a message';
      const tail = `${to ? ` to ${cut(to, 40)}` : ''}${subject ? ` (${q(subject)})` : ''}`;
      return { past: `Sent ${kind}${tail}`, inf: `send ${kind}${tail}` };
    }
    case 'money': {
      const amt = pick(a, ['amount', 'price', 'total', 'cost', 'value']);
      const n = amt ? parseFloat(amt.replace(/[^0-9.\-]/g, '')) : NaN;
      const shown = Number.isFinite(n) ? `${currency}${n.toFixed(2)}` : 'money';
      const what = pick(a, ['item', 'product', 'merchant', 'description', 'memo', 'recipient', 'to']) ?? target;
      const tail = what ? ` on ${q(what)}` : '';
      return { past: `Spent ${shown}${tail}`, inf: `spend ${shown}${tail}` };
    }
    case 'delete': {
      const what = target ?? 'something';
      return { past: `Deleted ${cut(what, 50)}`, inf: `delete ${cut(what, 50)}` };
    }
    case 'exec': {
      const c = pick(a, ['command', 'cmd', 'script', 'code']);
      const tail = c ? `: ${q(c)}` : '';
      return { past: `Ran a command${tail}`, inf: `run a command${tail}` };
    }
    case 'write': {
      const tail = target ? ` ${cut(target, 50)}` : '';
      return tail ? { past: `Changed${tail}`, inf: `change${tail}` } : { past: `Used the ${phrase} tool`, inf: `use the ${phrase} tool` };
    }
    case 'read': {
      const query = pick(a, ['query', 'q', 'search', 'text']);
      const used = { past: `Used the ${phrase} tool`, inf: `use the ${phrase} tool` };
      const tail = query ? ` for ${q(query)}` : target ? ` ${cut(target, 50)}` : '';
      return query
        ? { past: `Searched${tail}`, inf: `search${tail}` }
        : tail ? { past: `Looked at${tail}`, inf: `look at${tail}` } : used;
    }
    default:
      return { past: `Used the ${phrase} tool`, inf: `use the ${phrase} tool` };
  }
}

export function summarize(outcome: Outcome, p: Phrase, reason?: string): string {
  const r = reason ? ` ${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? '' : '.'}` : '';
  switch (outcome) {
    case 'done':
      return `${p.past}.`;
    case 'error':
      return `Tried to ${p.inf}, but the tool reported an error.`;
    case 'approved':
      return `You approved it. ${p.past}.`;
    case 'denied':
      return `You said no. Agent wanted to ${p.inf}.`;
    case 'timeout':
      return `No answer in time, so it was blocked. Agent wanted to ${p.inf}.`;
    case 'paused':
      return `Refused while paused. Agent wanted to ${p.inf}.`;
    default:
      return `Blocked. Agent wanted to ${p.inf}.${r}`;
  }
}
