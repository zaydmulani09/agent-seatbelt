import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPause, setPause } from './control.js';
import { startDashboard } from './dashboard.js';
import { Store } from './log.js';
import { files } from './paths.js';
import { normalizePolicy, savePolicy } from './policy.js';

const src = path.dirname(fileURLToPath(import.meta.url));
// When run from TypeScript sources (tests) the compiled CLI lives in ../dist.
const here = fs.existsSync(path.join(src, 'cli.js')) ? src : path.join(src, '..', 'dist');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DemoOptions {
  port?: number;
  /** No pauses between steps. */
  fast?: boolean;
  /** Resolve the held questions automatically (used by tests), then finish. */
  auto?: boolean;
  home?: string;
  say?: (line: string) => void;
}

export async function runDemo(o: DemoOptions = {}) {
  const say = o.say ?? ((l: string) => console.log(l));
  const home = o.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-demo-'));
  const f = files(home);
  savePolicy(
    f.policy,
    normalizePolicy({
      preset: 'balanced',
      approvalTimeoutSec: 900,
      runaway: { calls: 60, windowSec: 10, repeats: 8 },
      rules: [{ tool: 'run_shell', action: 'deny', arg: { path: 'command', regex: 'rm -rf|curl .*\\|\\s*(ba)?sh' }, reason: 'destructive shell commands are blocked' }],
    }),
  );
  const dash = await startDashboard({ home, port: o.port ?? 7878 });
  const store = new Store(f.db);
  const beat = (ms: number) => (o.fast ? sleep(10) : sleep(ms));

  const client = new Client({ name: 'demo-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(here, 'cli.js'), 'proxy', '--name', 'shop', '--', process.execPath, path.join(here, 'mock-upstream.js')],
      env: { ...(process.env as Record<string, string>), SEATBELT_HOME: home },
      stderr: 'inherit',
    }),
  );

  const call = async (label: string, name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 })) as any;
    const t: string = r.content?.[0]?.text ?? '';
    say(`  agent: ${label} -> ${r.isError ? 'REFUSED ' + (safe(t)?.code ?? '') : 'ok'}`);
    return r;
  };
  const safe = (t: string) => { try { return JSON.parse(t); } catch { return undefined; } };

  const script = (async () => {
    say('agent: starting its day');
    await client.listTools();
    await call('read notes', 'read_file', { path: '~/Documents/trip-notes.txt' });
    await beat(500);
    await call('search flights', 'search_web', { query: 'cheap flights to Lisbon in March' });
    await beat(500);
    await call('save a note', 'write_note', { path: '~/Documents/lisbon.md', body: 'Flights looked at' });
    await beat(700);
    await call('buy a $240 flight', 'buy_item', { item: 'Flight to Lisbon', amount: 240 });
    await beat(700);
    await call('run a destructive command', 'run_shell', { command: 'rm -rf ~/Documents' });
    await beat(900);

    say('agent: gets stuck in a loop');
    for (let i = 0; i < 12; i++) {
      await call(`check the weather (try ${i + 1})`, 'get_weather', { city: 'Lisbon' });
      await beat(120);
    }
    say('you: resume after the runaway pause');
    await beat(2200);
    clearPause(f);
    store.append({ tool: '(demo)', cls: 'system', decision: 'system', outcome: 'system', code: 'resume', summary: 'You resumed. Agents can act again.' });
    await beat(900);

    say('you: hit STOP for a moment');
    setPause(f, 'You pressed STOP');
    store.append({ tool: '(demo)', cls: 'system', decision: 'system', outcome: 'system', code: 'stop', summary: 'You pressed STOP. Everything is paused.' });
    await beat(600);
    await call('look up a recipe', 'search_web', { query: 'pasta recipes' });
    await beat(1800);
    clearPause(f);
    store.append({ tool: '(demo)', cls: 'system', decision: 'system', outcome: 'system', code: 'resume', summary: 'You resumed. Agents can act again.' });
    await beat(800);

    say('agent: now tries things that need your say');
    const held = [
      call('email a stranger', 'send_email', { to: 'deals@totally-legit-prizes.biz', subject: 'Your account details', body: 'Here is the card number 4242 4242 4242 4242 as requested' }),
      call('buy a $12 gift card', 'buy_item', { item: 'Gift card', amount: 12 }),
      call('delete the tax return', 'delete_file', { path: '~/Documents/taxes-2025.pdf' }),
    ];
    if (o.auto) {
      await sleep(600);
      const pend = store.pending();
      pend.forEach((a, i) => store.decide(a.id, i === 0 ? 'denied' : 'approved'));
    } else {
      say('\nThree actions are waiting for you in the dashboard. Approve or deny them. Press Ctrl+C when done.');
    }
    await Promise.all(held);
  })();

  return {
    url: dash.url,
    home,
    done: script,
    async close() {
      await client.close().catch(() => {});
      store.close();
      await dash.close();
    },
  };
}
