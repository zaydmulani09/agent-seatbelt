import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPause, readPause, setPause } from './control.js';
import { Store } from './log.js';
import { files } from './paths.js';
import { PRESETS, PolicyError, loadPolicy, normalizePolicy, savePolicy } from './policy.js';
import { buildReceipt, receiptHtml, receiptSvg } from './receipt.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export interface Dashboard {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface DashboardOptions {
  home?: string;
  port?: number;
}

function readToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* fall through */
  }
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export async function startDashboard(opts: DashboardOptions = {}): Promise<Dashboard> {
  const f = files(opts.home);
  const store = new Store(f.db);
  const token = readToken(f.token);
  let allowedHosts = new Set<string>();

  const cookieOf = (req: http.IncomingMessage) => /(?:^|;\s*)sb=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  const authed = (req: http.IncomingMessage) => {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    return same(cookieOf(req), token) || same(bearer, token);
  };

  const state = () => {
    const policy = loadPolicy(f.policy);
    return {
      paused: readPause(f),
      pending: store.pending(),
      events: store.events(200).map((e) => ({ id: e.id, ts: e.ts, agent: e.agent, tool: e.tool, cls: e.cls, decision: e.decision, outcome: e.outcome, code: e.code, summary: e.summary, detail: e.detail, args: e.args, amount: e.amount })),
      spentToday: store.spentToday(),
      policy,
      presets: PRESETS,
    };
  };

  const clients = new Set<http.ServerResponse>();
  let last = '';
  const tick = setInterval(() => {
    const sig = `${store.fingerprint()}|${readPause(f).paused}|${fs.existsSync(f.policy) ? fs.statSync(f.policy).mtimeMs : 0}`;
    if (sig !== last) {
      last = sig;
      for (const c of clients) c.write(`event: update\ndata: ${Date.now()}\n\n`);
    }
  }, 400);
  const beat = setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 15_000);

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let n = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 256_000) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('bad json'));
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    try {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return send(res, 403, { error: 'loopback only' });
      if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return send(res, 403, { error: 'bad host' });
      const origin = req.headers.origin;
      if (origin !== undefined && ![...allowedHosts].some((h) => origin === `http://${h}`)) return send(res, 403, { error: 'bad origin' });
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'cross-site' });

      const url = new URL(req.url ?? '/', 'http://x');
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';

      if (url.pathname === '/' && url.searchParams.has('t')) {
        if (!same(url.searchParams.get('t') ?? '', token)) return send(res, 401, 'Wrong token.', 'text/plain');
        res.writeHead(302, { location: '/', 'set-cookie': `sb=${token}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
      if (!authed(req)) {
        return send(res, 401, '<!doctype html><meta charset="utf-8"><title>Agent Seatbelt</title><p style="font:18px system-ui;padding:2rem">Open the link printed by <code>agent-seatbelt start</code> to sign in.</p>', 'text/html; charset=utf-8');
      }
      if (mutating && req.headers['x-seatbelt'] !== '1') return send(res, 403, { error: 'missing x-seatbelt header' });

      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, state());
      if (req.method === 'GET' && p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'content-security-policy': CSP });
        res.write('retry: 1500\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && p === '/api/verify') return send(res, 200, store.verify());
      if (req.method === 'POST' && p === '/api/stop') {
        setPause(f, 'You pressed STOP');
        store.append({ tool: '(dashboard)', cls: 'system', decision: 'system', outcome: 'system', code: 'stop', summary: 'You pressed STOP. Everything is paused.' });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/resume') {
        clearPause(f);
        store.append({ tool: '(dashboard)', cls: 'system', decision: 'system', outcome: 'system', code: 'resume', summary: 'You resumed. Agents can act again.' });
        return send(res, 200, { ok: true });
      }
      const m = /^\/api\/approvals\/(\d+)$/.exec(p);
      if (req.method === 'POST' && m) {
        const body = await readBody(req);
        const id = Number(m[1]);
        const a = store.approval(id);
        if (!a) return send(res, 404, { error: 'not found' });
        if (body.decision !== 'approve' && body.decision !== 'deny') return send(res, 400, { error: 'decision must be approve or deny' });
        const ok = store.decide(id, body.decision === 'approve' ? 'approved' : 'denied', body.decision === 'approve' && body.always === true);
        if (ok && body.decision === 'approve' && body.always === true) {
          const pol = loadPolicy(f.policy);
          if (!pol.rules.some((r) => r.tool === a.tool && r.action === 'allow' && !r.arg)) {
            pol.rules.push({ tool: a.tool, action: 'allow', reason: 'you chose "always allow this"' });
            savePolicy(f.policy, pol);
          }
        }
        return send(res, ok ? 200 : 409, { ok });
      }
      if (req.method === 'PUT' && p === '/api/policy') {
        try {
          savePolicy(f.policy, normalizePolicy(await readBody(req)));
          return send(res, 200, { ok: true });
        } catch (err) {
          return send(res, 400, { error: err instanceof PolicyError ? err.message : 'invalid policy' });
        }
      }
      if (req.method === 'GET' && p === '/api/receipt') return send(res, 200, buildReceipt(store, loadPolicy(f.policy).spend.currency));
      if (req.method === 'GET' && p === '/receipt.svg') return send(res, 200, receiptSvg(buildReceipt(store, loadPolicy(f.policy).spend.currency)), TYPES['.svg']);
      if (req.method === 'GET' && p === '/receipt.html') {
        // The receipt page is self-contained and has inline styles, so it gets its own CSP.
        res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
        return res.end(receiptHtml(buildReceipt(store, loadPolicy(f.policy).spend.currency)));
      }

      if (req.method === 'GET') {
        const name = p === '/' ? 'index.html' : p.slice(1);
        if (/^[a-z0-9.-]+$/i.test(name) && TYPES[path.extname(name)] && fs.existsSync(path.join(UI_DIR, name))) {
          return send(res, 200, fs.readFileSync(path.join(UI_DIR, name)), TYPES[path.extname(name)]);
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7878, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  fs.writeFileSync(f.dash, JSON.stringify({ port, pid: process.pid, url }));

  return {
    url,
    port,
    token,
    close: async () => {
      clearInterval(tick);
      clearInterval(beat);
      clients.forEach((c) => c.end());
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(f.dash, { force: true });
      store.close();
    },
  };
}
