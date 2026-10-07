import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, diff, isWrapped, plan, unwrapEntry, wrapEntry } from '../src/init.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-init-'));
const fixture = {
  theme: 'dark',
  mcpServers: {
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me'], env: { A: '1' } },
    remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc=def' } },
  },
  projects: { '/p': { mcpServers: { local: { command: 'node', args: ['s.js'] } } } },
};

describe('init', () => {
  it('wraps stdio and http servers, including per-project ones, and keeps everything else', () => {
    const f = path.join(tmp(), 'cfg.json');
    fs.writeFileSync(f, JSON.stringify(fixture, null, 2));
    const p = plan(f, 'wrap');
    expect(p.changed).toBe(3);
    const out = JSON.parse(p.after);
    expect(out.theme).toBe('dark');
    expect(out.mcpServers.files).toMatchObject({ command: 'npx', env: { A: '1' } });
    expect(out.mcpServers.files.args).toEqual(['-y', 'github:zaydmulani09/agent-seatbelt', 'proxy', '--name', 'files', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/Users/me']);
    expect(out.mcpServers.remote.url).toBeUndefined();
    expect(out.mcpServers.remote.args).toContain('--url');
    expect(out.projects['/p'].mcpServers.local.args.slice(-3)).toEqual(['--', 'node', 's.js']);
  });

  it('is idempotent', () => {
    const f = path.join(tmp(), 'cfg.json');
    fs.writeFileSync(f, JSON.stringify(fixture));
    const once = plan(f, 'wrap');
    fs.writeFileSync(f, once.after);
    expect(plan(f, 'wrap').changed).toBe(0);
  });

  it('undo restores the original entries exactly', () => {
    const f = path.join(tmp(), 'cfg.json');
    fs.writeFileSync(f, JSON.stringify(fixture, null, 2));
    fs.writeFileSync(f, plan(f, 'wrap').after);
    const undone = plan(f, 'undo');
    expect(undone.changed).toBe(3);
    expect(JSON.parse(undone.after)).toEqual(fixture);
  });

  it('--local launches this install with node', () => {
    const e = wrapEntry('x', { command: 'uvx', args: ['thing'] }, { local: true });
    expect(e.command).toBe(process.execPath);
    expect(e.args[0]).toMatch(/cli\.js$/);
    expect(unwrapEntry(e)).toEqual({ command: 'uvx', args: ['thing'] });
    expect(isWrapped(e)).toBe(true);
  });

  it('backs up before writing and a dry run writes nothing', () => {
    const dir = tmp();
    const f = path.join(dir, 'cfg.json');
    const original = JSON.stringify(fixture, null, 2);
    fs.writeFileSync(f, original);
    const p = plan(f, 'wrap');
    expect(fs.readFileSync(f, 'utf8')).toBe(original);
    const backup = apply(p);
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);
    expect(fs.readFileSync(f, 'utf8')).toBe(p.after);
  });

  it('diff shows only what changed', () => {
    const d = diff('{\n  "a": 1,\n  "b": 2\n}', '{\n  "a": 1,\n  "b": 3\n}');
    expect(d).toContain('-   "b": 2');
    expect(d).toContain('+   "b": 3');
    expect(d).not.toContain('+   "a"');
  });

  it('errors clearly on invalid json', () => {
    const f = path.join(tmp(), 'bad.json');
    fs.writeFileSync(f, '{ nope');
    expect(() => plan(f, 'wrap')).toThrow();
  });
});
