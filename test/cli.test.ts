import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runDemo } from '../src/demo.js';
import { Store } from '../src/log.js';
import { files } from '../src/paths.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cli-'));
const run = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, SEATBELT_HOME: home }, encoding: 'utf8' });

describe('cli', () => {
  it('stop, status, resume', () => {
    expect(run('status')).toContain('watching');
    expect(run('stop')).toContain('STOPPED');
    expect(fs.existsSync(files(home).paused)).toBe(true);
    expect(run('status')).toContain('PAUSED');
    expect(run('resume')).toContain('Resumed');
    expect(run('status')).toContain('tamper check passed');
  });

  it('init --dry-run changes nothing, init wraps with a backup, --undo restores', () => {
    const f = path.join(home, 'claude_desktop_config.json');
    const original = JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['server'] } } }, null, 2);
    fs.writeFileSync(f, original);
    expect(run('init', '--dry-run', '--file', f)).toContain('Dry run');
    expect(fs.readFileSync(f, 'utf8')).toBe(original);
    run('init', '--file', f);
    expect(fs.readFileSync(f, 'utf8')).toContain('"proxy"');
    expect(fs.readdirSync(home).some((n) => n.includes('seatbelt-backup'))).toBe(true);
    run('init', '--undo', '--file', f);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual(JSON.parse(original));
  });

  it('receipt writes svg and html', () => {
    const out = path.join(home, 'out');
    run('receipt', '--out', out);
    expect(fs.readFileSync(path.join(out, 'agent-receipt.svg'), 'utf8')).toContain('<svg');
    expect(fs.existsSync(path.join(out, 'agent-receipt.html'))).toBe(true);
  });

  it('prints help and fails on unknown commands', () => {
    expect(run('--help')).toContain('Usage: agent-seatbelt');
    expect(() => run('wat')).toThrow();
  });

  it('demo: blocks, a runaway pause, a kill switch and held questions all show up in the black box', async () => {
    const d = await runDemo({ fast: true, auto: true, port: 0, say: () => {} });
    await d.done;
    const s = new Store(files(d.home).db);
    const rows = s.events(500);
    expect(rows.some((e) => e.code === 'spend_per_call')).toBe(true);
    expect(rows.some((e) => e.code === 'rule')).toBe(true);
    expect(rows.some((e) => e.code === 'runaway')).toBe(true);
    expect(rows.some((e) => e.code === 'stop')).toBe(true);
    expect(rows.filter((e) => e.decision === 'ask').length).toBe(3);
    expect(s.verify().ok).toBe(true);
    s.close();
    await d.close();
  }, 60000);
});
