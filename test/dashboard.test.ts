import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPause } from '../src/control.js';
import { startDashboard, type Dashboard } from '../src/dashboard.js';
import { Store } from '../src/log.js';
import { files } from '../src/paths.js';
import { loadPolicy } from '../src/policy.js';

let d: Dashboard;
let home: string;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dash-'));
  d = await startDashboard({ home, port: 0 });
});
afterEach(() => d.close());

function req(opts: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: unknown }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: d.port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: { host: opts.host ?? `127.0.0.1:${d.port}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    r.on('error', reject);
    if (opts.body !== undefined) r.write(JSON.stringify(opts.body));
    r.end();
  });
}
const authed = (extra: Record<string, string> = {}) => ({ cookie: `sb=${d.token}`, ...extra });
const mut = (extra: Record<string, string> = {}) => authed({ 'x-seatbelt': '1', 'content-type': 'application/json', ...extra });

describe('dashboard security', () => {
  it('binds to loopback only', () => {
    expect(new URL(d.url).hostname).toBe('127.0.0.1');
  });

  it('is unreachable on a non-loopback interface', async () => {
    const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!ext) return;
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const s = net.connect(d.port, ext.address);
      s.on('error', resolve);
      s.on('connect', () => resolve(Object.assign(new Error('connected'), { code: 'CONNECTED' })));
    });
    expect(err.code).toBe('ECONNREFUSED');
  });

  it('rejects requests with no token', async () => {
    expect((await req({ path: '/api/state' })).status).toBe(401);
    expect((await req({ path: '/' })).status).toBe(401);
  });

  it('rejects a wrong token in the URL and in the cookie', async () => {
    expect((await req({ path: '/?t=nope' })).status).toBe(401);
    expect((await req({ path: '/api/state', headers: { cookie: 'sb=deadbeef' } })).status).toBe(401);
    expect((await req({ path: '/api/state', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('accepts the right token, sets a strict cookie, then serves the app', async () => {
    const r = await req({ path: `/?t=${d.token}` });
    expect(r.status).toBe(302);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    const page = await req({ path: '/', headers: authed() });
    expect(page.status).toBe(200);
    expect(page.body).toContain('Agent Seatbelt');
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'");
    expect((await req({ path: '/api/state', headers: { authorization: `Bearer ${d.token}` } })).status).toBe(200);
  });

  it('rejects bad Host headers (DNS rebinding)', async () => {
    for (const host of ['evil.com', `evil.com:${d.port}`, '127.0.0.1', `127.0.0.1.evil.com:${d.port}`, '192.168.1.5:' + d.port]) {
      expect((await req({ path: '/api/state', host, headers: authed() })).status, host).toBe(403);
    }
    expect((await req({ path: '/api/state', host: `localhost:${d.port}`, headers: authed() })).status).toBe(200);
  });

  it('rejects foreign Origins and cross-site fetches', async () => {
    expect((await req({ path: '/api/state', headers: authed({ origin: 'https://evil.com' }) })).status).toBe(403);
    expect((await req({ path: '/api/state', headers: authed({ origin: 'http://localhost:1' }) })).status).toBe(403);
    expect((await req({ path: '/api/state', headers: authed({ 'sec-fetch-site': 'cross-site' }) })).status).toBe(403);
    const ok = await req({ path: '/api/state', headers: authed({ origin: `http://127.0.0.1:${d.port}` }) });
    expect(ok.status).toBe(200);
  });

  it('refuses state changes without the custom header, and with a bad Origin', async () => {
    expect((await req({ method: 'POST', path: '/api/stop', headers: authed() })).status).toBe(403);
    expect((await req({ method: 'POST', path: '/api/stop', headers: mut({ origin: 'https://evil.com' }) })).status).toBe(403);
    expect(readPause(files(home)).paused).toBe(false);
  });

  it('does not serve files outside the ui folder', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/package.json', '/src/cli.ts']) {
      expect((await req({ path: p, headers: authed() })).status, p).toBe(404);
    }
  });
});

describe('dashboard behavior', () => {
  it('stop and resume toggle the kill switch file and log it', async () => {
    const f = files(home);
    expect((await req({ method: 'POST', path: '/api/stop', headers: mut() })).status).toBe(200);
    expect(readPause(f).paused).toBe(true);
    const st = JSON.parse((await req({ path: '/api/state', headers: authed() })).body);
    expect(st.paused.paused).toBe(true);
    await req({ method: 'POST', path: '/api/resume', headers: mut() });
    expect(readPause(f).paused).toBe(false);
    const s = new Store(f.db);
    expect(s.events(5).map((e) => e.code)).toEqual(['resume', 'stop']);
    s.close();
  });

  it('approves with "always allow", which adds a rule once', async () => {
    const s = new Store(files(home).db);
    const id = s.createApproval({ agent: 'a', tool: 'mail__send', cls: 'send', summary: 's', detail: 'd', args: '{}' });
    const r = await req({ method: 'POST', path: `/api/approvals/${id}`, headers: mut(), body: { decision: 'approve', always: true } });
    expect(r.status).toBe(200);
    expect(s.approval(id)?.status).toBe('approved');
    expect(loadPolicy(files(home).policy).rules).toEqual([{ tool: 'mail__send', action: 'allow', reason: 'you chose "always allow this"' }]);
    expect((await req({ method: 'POST', path: `/api/approvals/${id}`, headers: mut(), body: { decision: 'deny' } })).status).toBe(409);
    expect((await req({ method: 'POST', path: '/api/approvals/9999', headers: mut(), body: { decision: 'deny' } })).status).toBe(404);
    expect((await req({ method: 'POST', path: `/api/approvals/${id}`, headers: mut(), body: { decision: 'maybe' } })).status).toBe(400);
    s.close();
  });

  it('validates and saves policy edits', async () => {
    const bad = await req({ method: 'PUT', path: '/api/policy', headers: mut(), body: { classes: { read: 'nope' } } });
    expect(bad.status).toBe(400);
    const ok = await req({ method: 'PUT', path: '/api/policy', headers: mut(), body: { preset: 'strict', spend: { perCall: 7 } } });
    expect(ok.status).toBe(200);
    const p = loadPolicy(files(home).policy);
    expect(p.preset).toBe('strict');
    expect(p.spend.perCall).toBe(7);
  });

  it('streams a live update when something happens', async () => {
    const got = new Promise<string>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: d.port, path: '/api/stream', headers: { host: `127.0.0.1:${d.port}`, ...authed() } }, (res) => {
        res.on('data', (c) => {
          if (String(c).includes('event: update')) {
            resolve('update');
            r.destroy();
          }
        });
      });
      r.on('error', (e) => (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e));
      r.end();
    });
    await new Promise((r) => setTimeout(r, 200));
    const s = new Store(files(home).db);
    s.append({ tool: 't', cls: 'read', decision: 'allow', outcome: 'done', summary: 'x' });
    s.close();
    expect(await got).toBe('update');
  });

  it('serves the receipt as svg and html', async () => {
    const svg = await req({ path: '/receipt.svg', headers: authed() });
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.body).toContain('AGENT RECEIPT');
    expect((await req({ path: '/receipt.html', headers: authed() })).body).toContain('Agent receipt');
  });
});
