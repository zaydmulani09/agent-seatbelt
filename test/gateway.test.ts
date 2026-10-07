import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { clearPause, setPause } from '../src/control.js';
import { Gateway, type UpstreamSpec } from '../src/gateway.js';
import { files } from '../src/paths.js';
import { normalizePolicy, savePolicy } from '../src/policy.js';

const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mock-upstream.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function setup(policy: object = {}, o: { upstreams?: UpstreamSpec[]; elicit?: (msg: string) => boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gw-'));
  const f = files(home);
  savePolicy(f.policy, normalizePolicy({ runaway: { enabled: false }, ...policy }));
  const gw = new Gateway({ upstreams: o.upstreams ?? [{ name: 'shop', command: process.execPath, args: [MOCK] }], home, pollMs: 20 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gw.serve(b);
  const client = new Client({ name: 'test-agent', version: '1' }, { capabilities: o.elicit ? { elicitation: {} } : {} });
  if (o.elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (r) => ({ action: 'accept', content: { allow: o.elicit!((r.params as any).message) } }));
  }
  await client.connect(a);
  open.push(async () => {
    await client.close();
    await gw.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;
  const refused = (r: any) => (r.isError ? JSON.parse(r.content[0].text) : undefined);
  const waitPending = async () => {
    for (let i = 0; i < 200; i++) {
      const p = gw.store.pending();
      if (p.length) return p;
      await sleep(10);
    }
    throw new Error('no approval appeared');
  };
  return { gw, f, client, call, refused, waitPending, store: gw.store };
}

describe('gateway integration', () => {
  it('passes allowed calls through and logs them in plain English', async () => {
    const t = await setup();
    const r = await t.call('read_file', { path: '/notes.txt' });
    expect(r.content[0].text).toBe('contents of /notes.txt');
    const [e] = t.store.events(1);
    expect(e).toMatchObject({ tool: 'read_file', cls: 'read', outcome: 'done', agent: 'test-agent' });
    expect(e.summary).toBe('Looked at /notes.txt.');
  });

  it('lists tools unchanged for a single upstream and passes resources and prompts', async () => {
    const t = await setup();
    const names = (await t.client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('send_email');
    expect((await t.client.listResources()).resources[0].uri).toBe('mock://readme');
    expect((await t.client.readResource({ uri: 'mock://readme' })).contents[0]).toMatchObject({ text: 'hello' });
    expect((await t.client.listPrompts()).prompts[0].name).toBe('greet');
    expect((await t.client.getPrompt({ name: 'greet' })).messages).toHaveLength(1);
  });

  it('namespaces tools, resources and prompts across several upstreams', async () => {
    const spec = (name: string): UpstreamSpec => ({ name, command: process.execPath, args: [MOCK] });
    const t = await setup({}, { upstreams: [spec('a'), spec('b')] });
    const names = (await t.client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('a__read_file');
    expect(names).toContain('b__read_file');
    expect((await t.call('b__read_file', { path: '/x' })).content[0].text).toBe('contents of /x');
    const [res] = (await t.client.listResources()).resources;
    expect((await t.client.readResource({ uri: res.uri })).contents[0]).toMatchObject({ text: 'hello' });
    expect((await t.client.listPrompts()).prompts.map((p) => p.name)).toEqual(['a__greet', 'b__greet']);
    expect(t.store.events(1)[0].upstream).toBe('a');
  });

  it('ask then approve: holds the call, then runs it', async () => {
    const t = await setup();
    const p = t.call('send_email', { to: 'a@b.com', subject: 'Hi' });
    const [a] = await t.waitPending();
    expect(a.summary).toBe('Agent wants to send an email to a@b.com ("Hi").');
    expect(t.store.events(5).filter((e) => e.tool === 'send_email')).toHaveLength(0);
    t.store.decide(a.id, 'approved');
    expect((await p).content[0].text).toBe('sent to a@b.com');
    expect(t.store.events(1)[0]).toMatchObject({ outcome: 'approved', decision: 'ask' });
  });

  it('ask then deny: refuses with a machine-readable reason and never reaches the tool', async () => {
    const t = await setup();
    const p = t.call('delete_file', { path: '/tax.pdf' });
    const [a] = await t.waitPending();
    t.store.decide(a.id, 'denied');
    const out = t.refused(await p);
    expect(out).toMatchObject({ blocked: true, by: 'agent-seatbelt', code: 'user_denied', tool: 'delete_file' });
    expect(out.instruction).toMatch(/Do not retry/);
    expect(t.store.events(1)[0]).toMatchObject({ outcome: 'denied' });
  });

  it('ask then timeout: denies after the configured time', async () => {
    const t = await setup({ approvalTimeoutSec: 0.3 });
    const out = t.refused(await t.call('send_email', { to: 'x@y.z', subject: 's' }));
    expect(out.code).toBe('approval_timeout');
    expect(t.store.events(1)[0].outcome).toBe('timeout');
    expect(t.store.pending()).toHaveLength(0);
  });

  it('deny rule with an argument regex blocks without asking', async () => {
    const t = await setup({ rules: [{ tool: 'run_shell', action: 'deny', arg: { path: 'command', regex: 'rm -rf' }, reason: 'no wiping' }] });
    const out = t.refused(await t.call('run_shell', { command: 'rm -rf ~' }));
    expect(out).toMatchObject({ code: 'rule' });
    expect(out.reason).toContain('no wiping');
    expect(t.store.pending()).toHaveLength(0);
    const p = t.call('run_shell', { command: 'ls' });
    const [a] = await t.waitPending();
    t.store.decide(a.id, 'approved');
    expect((await p).content[0].text).toBe('ran ls');
  });

  it('strict mode denies unknown tools outright', async () => {
    const t = await setup({ preset: 'strict' });
    expect(t.refused(await t.call('mystery_tool'))?.code).toBe('class');
  });

  it('spend cap: per purchase and per day, and money stopped is recorded', async () => {
    const t = await setup({ spend: { perCall: 50, perDay: 60 }, classes: { money: 'allow' } });
    const big = t.refused(await t.call('buy_item', { item: 'flight', amount: 240 }));
    expect(big.code).toBe('spend_per_call');
    expect(big.reason).toMatch(/Do not retry|per-purchase limit/);
    expect((await t.call('buy_item', { item: 'a', amount: 40 })).isError).toBeUndefined();
    expect(t.store.spentToday()).toBe(40);
    expect(t.refused(await t.call('buy_item', { item: 'b', amount: 40 }))?.code).toBe('spend_per_day');
    expect(t.store.spentToday()).toBe(40);
    expect(t.store.events(10).find((e) => e.code === 'spend_per_call')?.amount).toBe(240);
  });

  it('rate limit refuses calls beyond the per-minute cap', async () => {
    const t = await setup({ rateLimit: { perMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await t.call('read_file', { path: `/${i}` })).isError).toBeUndefined();
    expect(t.refused(await t.call('read_file', { path: '/4' }))?.code).toBe('rate_limit');
  });

  it('runaway detection pauses everything, then resume works', async () => {
    const t = await setup({ runaway: { enabled: true, calls: 100, windowSec: 10, repeats: 5 } });
    let tripped: any;
    for (let i = 0; i < 8 && !tripped; i++) tripped = t.refused(await t.call('get_weather', { city: 'x' }));
    expect(tripped.code).toBe('runaway');
    expect(t.refused(await t.call('read_file', { path: '/other' })).code).toBe('paused');
    expect(t.store.events(20).some((e) => e.code === 'runaway' && e.cls === 'system')).toBe(true);
    clearPause(t.f);
    expect((await t.call('read_file', { path: '/other' })).isError).toBeUndefined();
  });

  it('runaway detection also trips on raw volume', async () => {
    const t = await setup({ runaway: { enabled: true, calls: 6, windowSec: 10, repeats: 0 } });
    let tripped: any;
    for (let i = 0; i < 8 && !tripped; i++) tripped = t.refused(await t.call('read_file', { path: `/${i}` }));
    expect(tripped.code).toBe('runaway');
  });

  it('kill switch refuses every call and releases held approvals', async () => {
    const t = await setup();
    const held = t.call('send_email', { to: 'a@b.c', subject: 's' });
    await t.waitPending();
    setPause(t.f, 'You pressed STOP');
    expect(t.refused(await held).code).toBe('paused');
    expect(t.store.pending()).toHaveLength(0);
    const out = t.refused(await t.call('read_file', { path: '/x' }));
    expect(out.code).toBe('paused');
    expect(out.reason).toContain('STOP');
    expect(t.store.events(1)[0].outcome).toBe('paused');
    clearPause(t.f);
    expect((await t.call('read_file', { path: '/x' })).isError).toBeUndefined();
  });

  it('redacts secrets in the log but still forwards the real arguments', async () => {
    const t = await setup({ classes: { send: 'allow' } });
    const r = await t.call('send_email', { to: 'a@b.com', subject: 's', body: 'card 4242 4242 4242 4242 key sk-abcdefghijklmnopqrstuvwx' });
    expect(r.content[0].text).toBe('sent to a@b.com');
    const e = t.store.events(1)[0];
    expect(e.args).not.toMatch(/4242|sk-abc/);
    expect(e.args).toContain('[redacted]');
  });

  it('can log argument hashes only', async () => {
    const t = await setup({ logArguments: 'hash' });
    await t.call('read_file', { path: '/secret/place' });
    const e = t.store.events(1)[0];
    expect(e.args).toBe('');
    expect(e.argsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports upstream errors as errors, not as spent money', async () => {
    const t = await setup();
    const r = await t.call('boom');
    expect(r.isError).toBe(true);
    expect(t.store.events(1)[0].outcome).toBe('error');
  });

  it('keeps the black box intact through all of it', async () => {
    const t = await setup();
    await t.call('read_file', { path: '/a' });
    t.refused(await t.call('buy_item', { item: 'x', amount: 9999 }));
    expect(t.store.verify().ok).toBe(true);
  });

  it('uses elicitation when the client supports it', async () => {
    let asked = '';
    const t = await setup({}, { elicit: (m) => ((asked = m), true) });
    const r = await t.call('send_email', { to: 'a@b.com', subject: 'Hi' });
    expect(r.content[0].text).toBe('sent to a@b.com');
    expect(asked).toContain('send an email to a@b.com');
    expect(t.store.events(1)[0].outcome).toBe('approved');
  });

  it('elicitation decline means deny', async () => {
    const t = await setup({}, { elicit: () => false });
    expect(t.refused(await t.call('send_email', { to: 'a@b.com', subject: 'Hi' })).code).toBe('user_denied');
  });

  it('falls back to strict when the policy file is broken', async () => {
    const t = await setup();
    fs.writeFileSync(t.f.policy, 'preset: nonsense');
    expect(t.refused(await t.call('mystery_tool'))?.code).toBe('class');
  });
});
