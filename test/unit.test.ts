import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';
import { Store } from '../src/log.js';
import { PolicyError, decide, extractAmount, globToRegex, normalizePolicy, presetPolicy, savePolicy, loadPolicy } from '../src/policy.js';
import { buildReceipt, receiptHtml, receiptSvg } from '../src/receipt.js';
import { redact, redactString } from '../src/redact.js';
import { describe as describeCall, summarize } from '../src/summary.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unit-'));

describe('classifier', () => {
  const c = (name: string, extra: object = {}) => classify({ name, ...extra }).cls;
  it('uses name heuristics', () => {
    expect(c('read_file')).toBe('read');
    expect(c('list_orders')).toBe('read');
    expect(c('get_payment_status')).toBe('read');
    expect(c('send_email')).toBe('send');
    expect(c('buy_item')).toBe('money');
    expect(c('create_payment')).toBe('money');
    expect(c('delete_file')).toBe('delete');
    expect(c('run_shell')).toBe('exec');
    expect(c('writeFile')).toBe('write');
    expect(c('postMessage')).toBe('send');
    expect(c('mystery_tool')).toBe('unknown');
  });
  it('trusts readOnlyHint unless the name says something riskier', () => {
    expect(c('fetch_page', { annotations: { readOnlyHint: true } })).toBe('read');
    expect(c('weird', { annotations: { readOnlyHint: true } })).toBe('read');
    expect(c('delete_everything', { annotations: { readOnlyHint: true } })).toBe('delete');
  });
  it('treats destructiveHint as delete and a non-readonly unknown as write', () => {
    expect(c('weird', { annotations: { destructiveHint: true } })).toBe('delete');
    expect(c('weird', { annotations: { readOnlyHint: false } })).toBe('write');
  });
  it('falls back to schema and description', () => {
    expect(c('thing', { inputSchema: { properties: { amount: {} } } })).toBe('money');
    expect(c('thing', { inputSchema: { properties: { to: {}, body: {} } } })).toBe('send');
    expect(c('thing', { inputSchema: { properties: { command: {} } } })).toBe('exec');
    expect(c('thing', { description: 'Delete the record permanently' })).toBe('delete');
  });
  it('lets the user override', () => {
    expect(classify({ name: 'send_email' }, 'read')).toEqual({ cls: 'read', source: 'override' });
  });
});

describe('policy', () => {
  const base = (over: object = {}) => ({ tool: 'shop__buy', rawName: 'buy', cls: 'money' as const, args: { amount: 10 }, spentToday: 0, callsLastMinute: 0, ...over });

  it('presets differ as promised', () => {
    expect(presetPolicy('strict').classes.unknown).toBe('deny');
    expect(presetPolicy('strict').classes.exec).toBe('deny');
    expect(presetPolicy('balanced').classes.money).toBe('ask');
    expect(presetPolicy('relaxed').classes.send).toBe('allow');
  });
  it('class action applies by default', () => {
    expect(decide(presetPolicy('balanced'), base({ cls: 'read', args: {} })).action).toBe('allow');
    expect(decide(presetPolicy('balanced'), base()).action).toBe('ask');
    expect(decide(presetPolicy('strict'), base({ cls: 'unknown' })).action).toBe('deny');
  });
  it('per-call spend cap denies and says do not split', () => {
    const d = decide(presetPolicy('balanced'), base({ args: { amount: 240 } }));
    expect(d).toMatchObject({ action: 'deny', code: 'spend_per_call', amount: 240 });
    expect(d.reason).toContain('$25.00');
  });
  it('per-day spend cap counts what was already spent', () => {
    const p = presetPolicy('balanced');
    expect(decide(p, base({ args: { amount: 20 }, spentToday: 85 })).code).toBe('spend_per_day');
    expect(decide(p, base({ args: { amount: 10 }, spentToday: 85 })).action).toBe('ask');
  });
  it('spend caps still apply to an always-allow rule', () => {
    const p = normalizePolicy({ rules: [{ tool: 'shop__buy', action: 'allow' }] });
    expect(decide(p, base({ args: { amount: 999 } })).action).toBe('deny');
    expect(decide(p, base({ args: { amount: 5 } })).action).toBe('allow');
  });
  it('reads the amount from a configured path', () => {
    const p = normalizePolicy({ spend: { amountPath: 'order.total.value', paths: { 'x__*': 'price.cents' } } });
    expect(extractAmount('shop__buy', { order: { total: { value: '$12.50' } } }, p.spend)).toBe(12.5);
    expect(extractAmount('x__a', { price: { cents: 700 } }, p.spend)).toBe(700);
    expect(extractAmount('shop__buy', { nothing: 1 }, p.spend)).toBeUndefined();
    expect(extractAmount('t', { amount: -5 }, presetPolicy('balanced').spend)).toBe(5);
  });
  it('rate limit denies past the per-minute cap', () => {
    const p = normalizePolicy({ rateLimit: { perMinute: 3 } });
    expect(decide(p, base({ cls: 'read', args: {}, callsLastMinute: 3 })).code).toBe('rate_limit');
    expect(decide(p, base({ cls: 'read', args: {}, callsLastMinute: 2 })).action).toBe('allow');
  });
  it('argument regex guard only fires on a match', () => {
    const p = normalizePolicy({ rules: [{ tool: 'sh__*', action: 'deny', arg: { path: 'command', regex: 'rm -rf' }, reason: 'no wiping' }] });
    const f = { tool: 'sh__run', rawName: 'run', cls: 'exec' as const, spentToday: 0, callsLastMinute: 0 };
    expect(decide(p, { ...f, args: { command: 'rm -rf /' } })).toMatchObject({ action: 'deny', reason: 'no wiping' });
    expect(decide(p, { ...f, args: { command: 'ls' } }).action).toBe('ask');
  });
  it('globs match whole names, case-insensitively', () => {
    expect(globToRegex('a__*').test('a__b')).toBe(true);
    expect(globToRegex('a.b').test('axb')).toBe(false);
  });
  it('rejects bad policy files with a clear message', () => {
    expect(() => normalizePolicy({ preset: 'yolo' })).toThrow(PolicyError);
    expect(() => normalizePolicy({ classes: { read: 'maybe' } })).toThrow(/allow, ask or deny/);
    expect(() => normalizePolicy({ spend: { perDay: -1 } })).toThrow(/non-negative/);
    expect(() => normalizePolicy({ rules: [{ tool: 'x', action: 'deny', arg: { path: 'a', regex: '(' } }] })).toThrow(/regex/);
  });
  it('round-trips through yaml', () => {
    const f = path.join(tmp(), 'policy.yaml');
    const p = normalizePolicy({ preset: 'strict', rules: [{ tool: 'a*', action: 'allow' }], spend: { perCall: 3 } });
    savePolicy(f, p);
    expect(loadPolicy(f)).toEqual(p);
    expect(loadPolicy(path.join(tmp(), 'missing.yaml')).preset).toBe('balanced');
  });
});

describe('redaction', () => {
  it('hides well-known secret shapes', () => {
    const s = redactString('key sk-ant-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP and Bearer abcdefghijklmnopqrstuvwx');
    expect(s).not.toMatch(/sk-ant|ghp_|AKIA|abcdefghijklmnop/);
    expect(s).toContain('[redacted]');
  });
  it('hides card numbers that pass Luhn and keeps look-alikes', () => {
    expect(redactString('card 4242 4242 4242 4242 ok')).toBe('card [redacted] ok');
    expect(redactString('order 1234 5678 9012 3456')).toContain('1234 5678 9012 3456');
  });
  it('hides values under secret-looking keys and nested', () => {
    const r = redact({ user: 'zayd', password: 'hunter2', nested: { api_key: 'abc', list: [{ token: 't' }], max_tokens: 5 }, note: 'password: swordfish' }) as any;
    expect(r.user).toBe('zayd');
    expect(r.password).toBe('[redacted]');
    expect(r.nested.api_key).toBe('[redacted]');
    expect(r.nested.list[0].token).toBe('[redacted]');
    expect(r.nested.max_tokens).toBe(5);
    expect(r.note).not.toContain('swordfish');
  });
});

describe('black box log', () => {
  const ev = (n: number) => ({ tool: 't', cls: 'read', decision: 'allow' as const, outcome: 'done' as const, summary: `call ${n}` });

  it('chains hashes and verifies', () => {
    const s = new Store(path.join(tmp(), 'b.db'));
    for (let i = 0; i < 5; i++) s.append(ev(i));
    expect(s.verify()).toEqual({ ok: true, count: 5 });
    const rows = s.events(10).reverse();
    expect(rows[1].prevHash).toBe(rows[0].hash);
    s.close();
  });
  it('is append-only at the database level', () => {
    const s = new Store(path.join(tmp(), 'b.db'));
    s.append(ev(1));
    expect(() => s.db.exec("UPDATE events SET summary='x'")).toThrow(/append-only/);
    expect(() => s.db.exec('DELETE FROM events')).toThrow(/append-only/);
    s.close();
  });
  it('detects tampering even if the triggers are removed', () => {
    const s = new Store(path.join(tmp(), 'b.db'));
    for (let i = 0; i < 4; i++) s.append(ev(i));
    s.db.exec('DROP TRIGGER events_no_update');
    s.db.exec("UPDATE events SET summary = 'I did nothing wrong' WHERE id = 2");
    expect(s.verify()).toEqual({ ok: false, count: 1, brokenAt: 2 });
    s.close();
  });
  it('detects a deleted row', () => {
    const s = new Store(path.join(tmp(), 'b.db'));
    for (let i = 0; i < 4; i++) s.append(ev(i));
    s.db.exec('DROP TRIGGER events_no_delete');
    s.db.exec('DELETE FROM events WHERE id = 2');
    expect(s.verify().ok).toBe(false);
    s.close();
  });
  it('counts spend only for calls that went through, and only today', () => {
    const s = new Store(path.join(tmp(), 'b.db'));
    const base = { tool: 'buy', cls: 'money', decision: 'allow' as const, summary: 's' };
    s.append({ ...base, outcome: 'done', amount: 10 });
    s.append({ ...base, outcome: 'approved', amount: 5 });
    s.append({ ...base, outcome: 'blocked', amount: 500 });
    s.append({ ...base, outcome: 'done', amount: 99, ts: Date.now() - 3 * 86_400_000 });
    expect(s.spentToday()).toBe(15);
    s.close();
  });
  it('approvals are decided once', () => {
    const s = new Store(path.join(tmp(), 'b.db'));
    const id = s.createApproval({ agent: 'a', tool: 't', cls: 'send', summary: 's', detail: 'd', args: '{}' });
    expect(s.pending()).toHaveLength(1);
    expect(s.decide(id, 'approved')).toBe(true);
    expect(s.decide(id, 'denied')).toBe(false);
    expect(s.approval(id)?.status).toBe('approved');
    s.close();
  });
});

describe('summaries', () => {
  it('reads like English', () => {
    expect(summarize('blocked', describeCall('shop__buy_item', 'money', { item: 'Flight', amount: 240 }), 'over the limit')).toBe('Blocked. Agent wanted to spend $240.00 on "Flight". Over the limit.');
    expect(summarize('done', describeCall('mail__send_email', 'send', { to: 'a@b.com', subject: 'Hi' }))).toBe('Sent an email to a@b.com ("Hi").');
    expect(summarize('denied', describeCall('rm', 'delete', { path: '/tmp/x' }))).toBe('You said no. Agent wanted to delete /tmp/x.');
    expect(summarize('timeout', describeCall('sh', 'exec', { command: 'ls' }))).toContain('No answer in time');
  });
  it('never invents detail for odd tools', () => {
    expect(summarize('done', describeCall('get_weather', 'read', {}))).toBe('Used the get weather tool.');
  });
});

describe('receipt', () => {
  it('summarizes the week without leaking arguments', () => {
    const s = new Store(path.join(tmp(), 'b.db'));
    const a = { tool: 't', cls: 'send', decision: 'ask' as const, summary: 'secret@person.com was emailed', args: '{"to":"secret@person.com"}' };
    s.append({ ...a, outcome: 'approved' });
    s.append({ ...a, outcome: 'denied' });
    s.append({ tool: 'buy', cls: 'money', decision: 'deny', outcome: 'blocked', summary: 'x', amount: 240 });
    s.append({ tool: 'buy', cls: 'money', decision: 'allow', outcome: 'done', summary: 'x', amount: 12 });
    s.append({ tool: 'x', cls: 'read', decision: 'allow', outcome: 'done', summary: 'x', ts: Date.now() - 30 * 86_400_000 });
    const r = buildReceipt(s);
    expect(r).toMatchObject({ actions: 4, approved: 1, said_no: 1, blocked: 1, moneyStopped: 240, moneySpent: 12 });
    expect(receiptSvg(r)).toContain('$240');
    for (const out of [receiptSvg(r), receiptHtml(r)]) expect(out).not.toContain('secret@person.com');
    s.close();
  });
});
