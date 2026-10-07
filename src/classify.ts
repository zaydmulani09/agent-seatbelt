export type ToolClass = 'read' | 'write' | 'money' | 'send' | 'delete' | 'exec' | 'unknown';
export const CLASSES: ToolClass[] = ['read', 'write', 'money', 'send', 'delete', 'exec', 'unknown'];

export interface ToolInfo {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
  inputSchema?: { properties?: Record<string, unknown> };
}

const WORDS: Record<Exclude<ToolClass, 'unknown'>, string[]> = {
  money: ['pay', 'payment', 'purchase', 'buy', 'checkout', 'order', 'charge', 'refund', 'transfer', 'withdraw', 'invoice', 'subscribe', 'bid', 'tip', 'donate', 'swap', 'trade', 'wire', 'spend', 'book', 'reserve'],
  delete: ['delete', 'remove', 'drop', 'destroy', 'purge', 'erase', 'wipe', 'truncate', 'rm', 'unlink', 'trash', 'revoke', 'cancel', 'uninstall', 'terminate', 'clear'],
  exec: ['exec', 'execute', 'run', 'shell', 'bash', 'cmd', 'eval', 'spawn', 'terminal', 'command', 'script', 'deploy', 'invoke', 'powershell'],
  send: ['send', 'email', 'mail', 'post', 'publish', 'tweet', 'message', 'notify', 'reply', 'forward', 'dm', 'sms', 'share', 'invite', 'broadcast', 'comment', 'text'],
  write: ['write', 'create', 'update', 'edit', 'set', 'add', 'put', 'patch', 'move', 'rename', 'upload', 'append', 'save', 'insert', 'modify', 'commit', 'push', 'mkdir', 'copy', 'new', 'open', 'close', 'merge', 'apply', 'import'],
  read: ['read', 'get', 'list', 'search', 'find', 'fetch', 'query', 'view', 'show', 'describe', 'lookup', 'cat', 'ls', 'stat', 'check', 'load', 'browse', 'scrape', 'count', 'head', 'summarize', 'download', 'inspect', 'resolve', 'screenshot', 'snapshot'],
};

/** Words that decide the class wherever they appear, unless the tool starts with a read verb. */
const STRONG: Partial<Record<ToolClass, string[]>> = {
  money: ['pay', 'payment', 'purchase', 'buy', 'checkout', 'charge', 'refund', 'withdraw', 'invoice'],
  delete: ['delete', 'remove', 'drop', 'destroy', 'purge', 'wipe', 'erase', 'truncate'],
  send: ['send', 'publish', 'tweet'],
};

const ORDER: Exclude<ToolClass, 'unknown'>[] = ['money', 'delete', 'exec', 'send', 'write', 'read'];
const STRICTNESS: Record<ToolClass, number> = { read: 0, write: 1, unknown: 2, send: 3, exec: 4, delete: 5, money: 6 };

export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function wordClass(w: string): Exclude<ToolClass, 'unknown'> | undefined {
  return ORDER.find((c) => WORDS[c].includes(w));
}

function fromName(name: string): ToolClass | undefined {
  const ws = words(name);
  const first = ws.map(wordClass).find(Boolean);
  if (first === 'read') return 'read';
  for (const c of ['money', 'delete', 'send'] as const) {
    if (ws.some((w) => STRONG[c]!.includes(w))) return c;
  }
  return first;
}

function fromDescription(desc: string): ToolClass | undefined {
  const ws = words(desc).slice(0, 12);
  const classes = ws.map(wordClass).filter(Boolean) as ToolClass[];
  return classes.sort((a, b) => STRICTNESS[b] - STRICTNESS[a])[0];
}

const stricter = (a: ToolClass, b: ToolClass): ToolClass => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);

export interface Classification {
  cls: ToolClass;
  source: 'override' | 'annotation' | 'name' | 'description' | 'schema' | 'default';
}

export function classify(tool: ToolInfo, override?: ToolClass): Classification {
  if (override) return { cls: override, source: 'override' };
  const a = tool.annotations ?? {};
  const byName = fromName(tool.name);

  if (a.readOnlyHint === true) {
    if (byName && ['money', 'send', 'delete', 'exec'].includes(byName)) return { cls: byName, source: 'name' };
    return { cls: 'read', source: 'annotation' };
  }
  if (a.destructiveHint === true) {
    return { cls: byName && STRICTNESS[byName] >= STRICTNESS.delete ? byName : 'delete', source: 'annotation' };
  }
  if (byName) return { cls: byName, source: 'name' };

  const props = Object.keys(tool.inputSchema?.properties ?? {}).map((p) => p.toLowerCase());
  if (props.some((p) => ['amount', 'price', 'total', 'cost'].includes(p))) return { cls: 'money', source: 'schema' };
  if (props.includes('to') || props.includes('recipient') || props.includes('recipients')) return { cls: 'send', source: 'schema' };
  if (props.includes('command') || props.includes('cmd')) return { cls: 'exec', source: 'schema' };

  const byDesc = tool.description ? fromDescription(tool.description) : undefined;
  if (byDesc) return { cls: byDesc, source: 'description' };
  if (a.readOnlyHint === false) return { cls: 'write', source: 'annotation' };
  return { cls: 'unknown', source: 'default' };
}

export { stricter };
