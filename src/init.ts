import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Target {
  label: string;
  file: string;
}

export function detectTargets(cwd = process.cwd()): Target[] {
  const h = os.homedir();
  const desktop =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(h, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? path.join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(h, '.config'), 'Claude', 'claude_desktop_config.json');
  const all: Target[] = [
    { label: 'Claude Desktop', file: desktop },
    { label: 'Claude Code (user)', file: path.join(h, '.claude.json') },
    { label: 'Claude Code (this project)', file: path.join(cwd, '.mcp.json') },
  ];
  return all.filter((t) => fs.existsSync(t.file));
}

type Entry = Record<string, any>;

export interface WrapOptions {
  /** Launch with `node <cli.js>` instead of npx from GitHub. */
  local?: boolean;
}

function launcher(o: WrapOptions): { command: string; args: string[] } {
  if (o.local) return { command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')] };
  return { command: 'npx', args: ['-y', 'github:zaydmulani09/agent-seatbelt'] };
}

export function isWrapped(e: Entry): boolean {
  return Array.isArray(e.args) && e.args.includes('proxy') && e.args.includes('--');
}

export function wrapEntry(name: string, e: Entry, o: WrapOptions = {}): Entry {
  if (isWrapped(e)) return e;
  const l = launcher(o);
  const out: Entry = { ...e };
  const proxyArgs = [...l.args, 'proxy', '--name', name];
  if (e.url) {
    proxyArgs.push('--url', e.url);
    for (const [k, v] of Object.entries(e.headers ?? {})) proxyArgs.push('--header', `${k}=${v}`);
    proxyArgs.push('--');
    delete out.url;
    delete out.headers;
    delete out.type;
  } else if (e.command) {
    proxyArgs.push('--', e.command, ...(e.args ?? []));
  } else return e;
  out.command = l.command;
  out.args = proxyArgs;
  if (e.type === 'stdio') out.type = 'stdio';
  return out;
}

export function unwrapEntry(e: Entry): Entry {
  if (!isWrapped(e)) return e;
  const args: string[] = e.args;
  const rest = args.slice(args.indexOf('--') + 1);
  const out: Entry = { ...e };
  const urlAt = args.indexOf('--url');
  if (urlAt >= 0 && urlAt < args.indexOf('--')) {
    out.type = 'http';
    out.url = args[urlAt + 1];
    const headers: Record<string, string> = {};
    args.forEach((a, i) => {
      if (a === '--header' && i < args.indexOf('--')) {
        const [k, ...v] = args[i + 1].split('=');
        headers[k] = v.join('=');
      }
    });
    if (Object.keys(headers).length) out.headers = headers;
    delete out.command;
    delete out.args;
  } else {
    out.command = rest[0];
    out.args = rest.slice(1);
    if (!out.args.length) delete out.args;
  }
  return out;
}

/** Applies fn to every mcpServers map in the file (top level and per project, as ~/.claude.json has both). */
function mapServers(cfg: any, fn: (name: string, e: Entry) => Entry): number {
  let n = 0;
  const visit = (m: Record<string, Entry> | undefined) => {
    if (!m || typeof m !== 'object') return;
    for (const [k, v] of Object.entries(m)) {
      if (!v || typeof v !== 'object') continue;
      const next = fn(k, v);
      if (next !== v) {
        m[k] = next;
        n++;
      }
    }
  };
  visit(cfg.mcpServers);
  for (const p of Object.values<any>(cfg.projects ?? {})) visit(p?.mcpServers);
  return n;
}

export interface Plan {
  file: string;
  changed: number;
  before: string;
  after: string;
}

export function plan(file: string, mode: 'wrap' | 'undo', o: WrapOptions = {}): Plan {
  const before = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(before);
  const changed = mapServers(cfg, (name, e) => (mode === 'wrap' ? wrapEntry(name, e, o) : unwrapEntry(e)));
  const indent = /^\{\n(\s+)"/.exec(before)?.[1]?.length ?? 2;
  return { file, changed, before, after: JSON.stringify(cfg, null, indent) + (before.endsWith('\n') ? '\n' : '') };
}

/** Line diff, good enough for small JSON files: shows removed and added lines with a little context. */
export function diff(a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let ea = x.length - 1;
  let eb = y.length - 1;
  while (ea >= s && eb >= s && x[ea] === y[eb]) {
    ea--;
    eb--;
  }
  const ctx = (from: number, to: number) => x.slice(Math.max(0, from), to).map((l) => `  ${l}`);
  return [...ctx(s - 2, s), ...x.slice(s, ea + 1).map((l) => `- ${l}`), ...y.slice(s, eb + 1).map((l) => `+ ${l}`), ...ctx(ea + 1, ea + 3)].join('\n');
}

export function apply(p: Plan): string {
  const backup = `${p.file}.seatbelt-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(p.file, backup);
  fs.writeFileSync(p.file, p.after);
  return backup;
}
