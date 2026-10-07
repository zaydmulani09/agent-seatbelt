import type { Store } from './log.js';

export interface Receipt {
  from: number;
  to: number;
  actions: number;
  allowed: number;
  asked: number;
  approved: number;
  said_no: number;
  blocked: number;
  paused: number;
  moneyStopped: number;
  moneySpent: number;
  byClass: Record<string, number>;
  chain: { ok: boolean; count: number };
  currency: string;
}

export function buildReceipt(store: Store, currency = '$', days = 7, now = Date.now()): Receipt {
  const from = now - days * 86_400_000;
  const rows = store.events(1_000_000, from).filter((e) => e.decision !== 'system');
  const r: Receipt = {
    from, to: now, actions: rows.length, allowed: 0, asked: 0, approved: 0, said_no: 0, blocked: 0, paused: 0,
    moneyStopped: 0, moneySpent: 0, byClass: {}, chain: store.verify(), currency,
  };
  for (const e of rows) {
    r.byClass[e.cls] = (r.byClass[e.cls] ?? 0) + 1;
    if (e.decision === 'ask') r.asked++;
    if (e.outcome === 'done' || e.outcome === 'error') r.allowed++;
    if (e.outcome === 'approved') r.approved++;
    if (e.outcome === 'denied' || e.outcome === 'timeout') r.said_no++;
    if (e.outcome === 'blocked') r.blocked++;
    if (e.outcome === 'paused') r.paused++;
    if (e.amount) {
      if (e.outcome === 'done' || e.outcome === 'approved') r.moneySpent += e.amount;
      else r.moneyStopped += e.amount;
    }
  }
  return r;
}

const fmtDate = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number, cur: string) => `${cur}${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const LABEL: Record<string, string> = { read: 'Looking things up', write: 'Making changes', money: 'Spending money', send: 'Sending messages', delete: 'Deleting things', exec: 'Running commands', unknown: 'Other' };

function stats(r: Receipt): [string, string][] {
  return [
    [String(r.actions), 'actions your agents took'],
    [String(r.approved + r.said_no), 'times they had to ask you'],
    [String(r.blocked + r.said_no + r.paused), 'things stopped'],
    [money(r.moneyStopped, r.currency), 'money kept in your pocket'],
  ];
}

export function receiptSvg(r: Receipt): string {
  const s = stats(r);
  const cell = (i: number, [n, l]: [string, string]) => {
    const x = 70 + (i % 2) * 520;
    const y = 310 + Math.floor(i / 2) * 140;
    return `<text x="${x}" y="${y}" font-family="Georgia,'Times New Roman',serif" font-size="76" font-weight="700" fill="${i === 3 ? '#C2410C' : '#1B1A17'}">${esc(n)}</text><text x="${x}" y="${y + 36}" font-family="system-ui,Segoe UI,sans-serif" font-size="24" fill="#5B574E">${esc(l)}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-label="Agent receipt">
<rect width="1200" height="630" fill="#F4EFE6"/>
<rect x="24" y="24" width="1152" height="582" rx="20" fill="none" stroke="#1B1A17" stroke-width="2" stroke-dasharray="3 8" stroke-linecap="round"/>
<text x="70" y="96" font-family="ui-monospace,Consolas,monospace" font-size="22" letter-spacing="4" fill="#C2410C">AGENT RECEIPT</text>
<text x="70" y="160" font-family="Georgia,'Times New Roman',serif" font-size="52" font-weight="700" fill="#1B1A17">What my AI agents did this week</text>
<text x="70" y="200" font-family="system-ui,Segoe UI,sans-serif" font-size="24" fill="#5B574E">${esc(fmtDate(r.from))} to ${esc(fmtDate(r.to))}</text>
${s.map((x, i) => cell(i, x)).join('\n')}
<line x1="70" y1="560" x2="1130" y2="560" stroke="#1B1A17" stroke-opacity=".25"/>
<text x="70" y="592" font-family="ui-monospace,Consolas,monospace" font-size="18" fill="#5B574E">${r.chain.ok ? 'log tamper check passed' : 'LOG TAMPER CHECK FAILED'} · local only, no personal data · agent-seatbelt</text>
</svg>`;
}

export function receiptHtml(r: Receipt): string {
  const classes = Object.entries(r.byClass).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...classes.map(([, n]) => n));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent receipt</title>
<style>
:root{--paper:#F4EFE6;--ink:#1B1A17;--mute:#5B574E;--accent:#C2410C;--line:#d9d1c1}
@media(prefers-color-scheme:dark){:root{--paper:#16150f;--ink:#F4EFE6;--mute:#b3ab9b;--accent:#fb923c;--line:#3a372c}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.5 system-ui,Segoe UI,sans-serif;padding:32px 16px}
main{max-width:620px;margin:0 auto;border:2px dashed var(--ink);border-radius:20px;padding:32px}
.k{font:600 13px ui-monospace,Consolas,monospace;letter-spacing:.2em;color:var(--accent)}
h1{font:700 34px/1.15 Georgia,serif;margin:.3em 0 .1em}.sub{color:var(--mute);margin:0 0 24px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:20px 16px}.n{font:700 48px/1 Georgia,serif}.l{color:var(--mute);font-size:15px}
.hot{color:var(--accent)}h2{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:32px 0 8px}
.row{display:grid;grid-template-columns:150px 1fr 40px;gap:10px;align-items:center;margin:6px 0;font-size:15px}
.bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
footer{margin-top:28px;border-top:1px solid var(--line);padding-top:12px;color:var(--mute);font:13px ui-monospace,Consolas,monospace}
@media print{body{padding:0}}
</style></head><body><main>
<div class="k">AGENT RECEIPT</div><h1>What my AI agents did this week</h1><p class="sub">${esc(fmtDate(r.from))} to ${esc(fmtDate(r.to))}</p>
<div class="g">${stats(r).map(([n, l], i) => `<div><div class="n${i === 3 ? ' hot' : ''}">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
<h2>What they did</h2>
${classes.length ? classes.map(([c, n]) => `<div class="row"><span>${esc(LABEL[c] ?? c)}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><b>${n}</b></div>`).join('') : '<p class="l">Nothing yet.</p>'}
<h2>Your say</h2>
<p class="l">${r.approved} approved, ${r.said_no} turned down or timed out, ${r.blocked} blocked by your rules, ${r.paused} refused while paused. ${money(r.moneySpent, r.currency)} was spent with your approval.</p>
<footer>${r.chain.ok ? `log tamper check passed (${r.chain.count} entries)` : 'LOG TAMPER CHECK FAILED'} · made on this computer · no personal data · agent-seatbelt</footer>
</main></body></html>`;
}
