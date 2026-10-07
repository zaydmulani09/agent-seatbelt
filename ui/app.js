// Agent Seatbelt dashboard. No dependencies, no external requests.
// Everything that comes from an agent is rendered with textContent, never as HTML.

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
let S = null; // last state
let tab = (() => { try { return localStorage.getItem('sb-tab') || 'now'; } catch { return 'now'; } })();
const open = new Set(); // expanded event ids
let busy = false;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by our CSP, style attributes are not
    else if (k === 'html') el.innerHTML = v; // only ever called with static icon strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const ICONS = {
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  write: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.6 0-2.8.8-2.8 2s1 1.7 2.8 2 2.8.8 2.8 2-1.2 2-2.8 2c-1.3 0-2.3-.4-2.8-1.2M12 6v2m0 8v2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14"/></svg>',
  exec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2M12 17h.01"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg>',
};
const CLS = { read: 'Look up', write: 'Change', money: 'Money', send: 'Send', delete: 'Delete', exec: 'Run', unknown: 'Other' };
const OUT = {
  done: ['Allowed', 'ok'], approved: ['You approved', 'ok'], blocked: ['Blocked', 'bad'], denied: ['You said no', 'bad'],
  timeout: ['No answer', 'warn'], paused: ['Paused', 'warn'], error: ['Tool error', ''],
};

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'x-seatbelt': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.id);
  toast.id = setTimeout(() => t.classList.remove('on'), 1800);
}

const money = (n) => `${S.policy.spend.currency}${n.toFixed(2)}`;
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function dayLabel(ts) {
  const d = new Date(ts), n = new Date();
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// ---- views ----------------------------------------------------------------

function eventRow(e) {
  const system = e.cls === 'system';
  const [outLabel, outTone] = OUT[e.outcome] || ['', ''];
  const body = [h('div', { class: 'sum' }, e.summary)];
  if (!system) {
    body.push(h('div', { class: 'meta' }, h('span', {}, time(e.ts)), h('span', { class: 'chip' }, CLS[e.cls] || e.cls), h('span', { class: `chip ${outTone}` }, outLabel)));
  } else body.push(h('div', { class: 'meta' }, h('span', {}, time(e.ts))));
  const li = h('li', { class: `ev ${system ? 'system' : e.outcome}` });
  li.append(h('span', { class: 'dot', html: system ? (e.code === 'resume' ? ICONS.play : ICONS.pause) : ICONS[e.cls] || ICONS.unknown }));
  const btn = h('button', { type: 'button', 'aria-expanded': open.has(e.id) ? 'true' : 'false', onclick: () => { open.has(e.id) ? open.delete(e.id) : open.add(e.id); render(); } }, ...body);
  li.append(btn);
  if (open.has(e.id) && !system) {
    li.append(h('dl', { class: 'det' },
      h('dt', {}, 'Tool'), h('dd', {}, `${e.tool}${e.agent ? `  (from ${e.agent})` : ''}`),
      e.detail ? [h('dt', {}, 'Why'), h('dd', {}, e.detail)] : null,
      h('dt', {}, 'Details sent'), h('dd', {}, e.args ? prettyArgs(e.args) : 'Not saved (fingerprint only mode)'),
    ));
  }
  return li;
}

function prettyArgs(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }

function viewNow() {
  const sheet = h('section', { class: 'sheet' });
  const today = S.events.filter((e) => e.cls !== 'system' && new Date(e.ts).toDateString() === new Date().toDateString());
  const stopped = today.filter((e) => ['blocked', 'denied', 'timeout', 'paused'].includes(e.outcome)).length;
  const limit = S.policy.spend.perDay;
  sheet.append(h('h2', {}, 'What your agents are doing'), h('p', { class: 'lede' }, 'Every action, in plain English, as it happens. Click any line for the details.'));
  if (S.paused.paused) sheet.append(h('div', { class: 'banner red', role: 'alert' }, h('span', {}, `Everything is paused. ${S.paused.reason || ''}`), ));
  if (S.pending.length) sheet.append(h('button', { class: 'banner', type: 'button', onclick: () => go('approve') }, h('span', {}, `${S.pending.length} ${S.pending.length === 1 ? 'action is' : 'actions are'} waiting for you`), h('span', {}, 'Review ->')));
  sheet.append(h('div', { class: 'tiles' },
    h('div', { class: 'tile' }, h('div', { class: 'n' }, today.length), h('div', { class: 'l' }, 'actions today')),
    h('div', { class: `tile${stopped ? ' hot' : ''}` }, h('div', { class: 'n' }, stopped), h('div', { class: 'l' }, 'stopped today')),
    h('div', { class: 'tile' }, h('div', { class: 'n' }, money(S.spentToday)), h('div', { class: 'l' }, limit ? `spent today, limit ${money(limit)}` : 'spent today'),
      limit ? h('div', { class: 'meter', role: 'img', 'aria-label': 'Daily spending used' }, h('i', { style: `width:${Math.min(100, (S.spentToday / limit) * 100)}%` })) : null),
  ));
  if (!S.events.length) {
    sheet.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, 'All quiet.'), h('div', {}, 'When an agent uses a tool you protect, it shows up here.')));
    return sheet;
  }
  let lastDay = '';
  let ol = null;
  for (const e of S.events) {
    const d = dayLabel(e.ts);
    if (d !== lastDay) { lastDay = d; sheet.append(h('div', { class: 'day' }, d)); ol = h('ol', { class: 'tl' }); sheet.append(ol); }
    ol.append(eventRow(e));
  }
  return sheet;
}

function viewApprove() {
  const sheet = h('section', { class: 'sheet' }, h('h2', {}, 'Needs your approval'), h('p', { class: 'lede' }, 'Agents are paused on these until you decide. If you do nothing, they are denied.'));
  if (!S.pending.length) {
    sheet.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, 'Nothing waiting.'), h('div', {}, 'You are all caught up.')));
    return sheet;
  }
  for (const a of S.pending) {
    const left = Math.max(0, Math.round((a.ts + S.policy.approvalTimeoutSec * 1000 - Date.now()) / 1000));
    const decide = (decision, always) => async () => {
      try { await api(`/api/approvals/${a.id}`, 'POST', { decision, always }); toast(decision === 'approve' ? 'Approved' : 'Denied'); } catch (e) { toast(e.message); }
      refresh();
    };
    sheet.append(h('article', { class: 'card' },
      h('div', {}, h('span', { class: 'chip warn' }, CLS[a.cls] || a.cls), ' ', h('span', { class: 'chip' }, a.agent || 'agent')),
      h('div', { class: 'q' }, a.summary),
      h('p', { class: 'why' }, `Asking because ${a.detail || 'your rules say so'}.`),
      a.args ? h('details', {}, h('summary', {}, 'See the exact details'), h('pre', { class: 'det' }, prettyArgs(a.args))) : null,
      h('div', { class: 'btns', style: 'margin-top:12px' },
        h('button', { class: 'btn go', type: 'button', onclick: decide('approve', false) }, 'Approve'),
        h('button', { class: 'btn no', type: 'button', onclick: decide('deny', false) }, 'Deny'),
        h('button', { class: 'btn quiet', type: 'button', onclick: decide('approve', true) }, `Always allow ${a.tool}`),
        h('span', { class: 'timer', 'data-ts': a.ts }, `denies in ${left}s`)),
    ));
  }
  return sheet;
}

const CLASS_ROWS = [
  ['read', 'Looking things up', 'Reading files, searching, fetching pages.'],
  ['write', 'Making changes', 'Creating or editing files and records.'],
  ['money', 'Spending money', 'Purchases, payments, transfers.'],
  ['send', 'Sending messages', 'Email, chat, posts. Things other people see.'],
  ['delete', 'Deleting things', 'Removing files, records or accounts.'],
  ['exec', 'Running commands', 'Shell commands and scripts on your computer.'],
  ['unknown', 'Anything unrecognized', 'Tools we could not classify.'],
];

async function save(next) {
  try { await api('/api/policy', 'PUT', next); S.policy = next; toast('Saved'); } catch (e) { toast(`Not saved: ${e.message}`); }
  render();
}

function seg(options, value, onpick, label) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([v, t, cls]) => h('button', { type: 'button', class: cls || v, 'aria-pressed': String(value === v), onclick: () => onpick(v) }, t)));
}

function numField(label, sub, value, onset) {
  const input = h('input', { type: 'number', min: '0', step: 'any', value: String(value), 'aria-label': label });
  input.addEventListener('change', () => { const n = Number(input.value); if (Number.isFinite(n) && n >= 0) onset(n); });
  return h('div', { class: 'row' }, h('div', { class: 't' }, h('b', {}, label), h('span', {}, sub)), input);
}

function toggle(label, sub, on, onset) {
  return h('div', { class: 'row' }, h('div', { class: 't' }, h('b', {}, label), h('span', {}, sub)), h('button', { class: 'tog', type: 'button', 'aria-pressed': String(on), 'aria-label': label, onclick: () => onset(!on) }));
}

function viewRules() {
  const p = structuredClone(S.policy);
  const sheet = h('section', { class: 'sheet' }, h('h2', {}, 'Rules'), h('p', { class: 'lede' }, 'Pick how careful you want to be. Changes apply to the next action an agent takes.'));
  const PRE = { strict: ['Strict', 'Asks about almost everything. Blocks commands.'], balanced: ['Balanced', 'Free to look and edit. Asks before money, messages, deleting.'], relaxed: ['Relaxed', 'Mostly free. Still asks about money and deleting.'] };
  sheet.append(h('div', { class: 'presets' }, Object.entries(PRE).map(([k, [t, d]]) => h('button', { class: 'preset', type: 'button', 'aria-pressed': String(p.preset === k), onclick: () => {
    const pr = S.presets[k];
    save({ ...p, preset: k, classes: { ...pr.classes }, spend: { ...p.spend, perCall: pr.spend.perCall, perDay: pr.spend.perDay }, rateLimit: { perMinute: pr.rateLimit }, runaway: { ...p.runaway, calls: pr.runaway[0], windowSec: pr.runaway[1], repeats: pr.runaway[2] } });
  } }, h('b', {}, t), h('span', {}, d)))));

  sheet.append(h('h3', {}, 'What agents may do'));
  for (const [k, t, d] of CLASS_ROWS) {
    sheet.append(h('div', { class: 'row' }, h('div', { class: 't' }, h('b', {}, t), h('span', {}, d)),
      seg([['allow', 'Allow'], ['ask', 'Ask me'], ['deny', 'Block']], p.classes[k], (v) => save({ ...p, preset: 'custom', classes: { ...p.classes, [k]: v } }), t)));
  }

  sheet.append(h('h3', {}, 'Spending limits'));
  sheet.append(numField('Most for one purchase', `Anything above this is refused (${p.spend.currency}). 0 means no limit.`, p.spend.perCall, (n) => save({ ...p, preset: 'custom', spend: { ...p.spend, perCall: n } })));
  sheet.append(numField('Most per day', `Total across all agents, resets at midnight (${p.spend.currency}).`, p.spend.perDay, (n) => save({ ...p, preset: 'custom', spend: { ...p.spend, perDay: n } })));

  sheet.append(h('h3', {}, 'Safety nets'));
  sheet.append(toggle('Auto-pause runaway agents', `Pauses everything if an agent makes ${p.runaway.calls} calls in ${p.runaway.windowSec} seconds or repeats one call ${p.runaway.repeats} times.`, p.runaway.enabled, (v) => save({ ...p, runaway: { ...p.runaway, enabled: v } })));
  sheet.append(numField('Calls per minute', 'Above this, new calls are refused. 0 means no limit.', p.rateLimit.perMinute, (n) => save({ ...p, rateLimit: { perMinute: n } })));
  sheet.append(numField('Seconds to answer a question', 'If you do not answer in time, it is denied.', p.approvalTimeoutSec, (n) => save({ ...p, approvalTimeoutSec: n })));

  sheet.append(h('h3', {}, 'Privacy'));
  sheet.append(toggle('Only keep fingerprints', 'Do not store what agents sent, only a one-way fingerprint. Secrets are always hidden either way.', p.logArguments === 'hash', (v) => save({ ...p, logArguments: v ? 'hash' : 'redacted' })));

  sheet.append(h('h3', {}, 'Your own rules'));
  if (!p.rules.length) sheet.append(h('p', { class: 'lede' }, 'None yet. Choose "Always allow" on a question and it will show up here.'));
  p.rules.forEach((r, i) => sheet.append(h('div', { class: 'rule' },
    h('span', {}, `${r.action.toUpperCase()}  ${r.tool}${r.arg ? `  when ${r.arg.path} matches /${r.arg.regex}/` : ''}`),
    h('button', { type: 'button', onclick: () => save({ ...p, rules: p.rules.filter((_, j) => j !== i) }) }, 'Remove'))));
  return sheet;
}

function viewReceipt() {
  const sheet = h('section', { class: 'sheet' }, h('h2', {}, 'Your weekly receipt'), h('p', { class: 'lede' }, 'A shareable summary of the last 7 days. It holds counts only. No names, messages or file contents.'));
  sheet.append(h('img', { class: 'rimg', src: `/receipt.svg?t=${Date.now()}`, alt: 'Agent receipt: actions taken, questions asked, things stopped and money kept' }));
  sheet.append(h('div', { class: 'btns', style: 'margin-top:18px' },
    h('a', { class: 'btn go', href: '/receipt.svg', download: 'agent-receipt.svg' }, 'Download image'),
    h('a', { class: 'btn', href: '/receipt.html', target: '_blank', rel: 'noopener' }, 'Open as a page'),
    h('button', { class: 'btn quiet', type: 'button', onclick: async () => { const v = await api('/api/verify'); toast(v.ok ? `Log is intact (${v.count} entries)` : `Log was tampered with near entry ${v.brokenAt}`); } }, 'Check the log is untampered')));
  return sheet;
}

const VIEWS = { now: viewNow, approve: viewApprove, rules: viewRules, receipt: viewReceipt };

function render() {
  if (!S) return;
  document.body.classList.toggle('paused', S.paused.paused);
  $('#status span').textContent = S.paused.paused ? 'Paused' : 'Watching';
  const stop = $('#stop');
  stop.querySelector('.stop-txt').textContent = S.paused.paused ? 'RESUME' : 'STOP';
  stop.querySelector('.stop-sub').textContent = S.paused.paused ? 'let agents act' : 'all agents';
  stop.setAttribute('aria-label', S.paused.paused ? 'Resume all agents' : 'Stop all agents now');
  const badge = $('#badge');
  badge.hidden = !S.pending.length;
  badge.textContent = S.pending.length;
  document.title = `${S.pending.length ? `(${S.pending.length}) ` : ''}${S.paused.paused ? 'Paused - ' : ''}Agent Seatbelt`;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const keepScroll = window.scrollY;
  const active = document.activeElement;
  const focusKey = active && active.closest('main') ? [...view.querySelectorAll('button,input,a')].indexOf(active) : -1;
  view.replaceChildren(VIEWS[tab]());
  if (focusKey >= 0) view.querySelectorAll('button,input,a')[focusKey]?.focus({ preventScroll: true });
  window.scrollTo(0, keepScroll);
}

function go(t) {
  tab = t;
  try { localStorage.setItem('sb-tab', t); } catch { /* private mode */ }
  render();
}

async function refresh() {
  try { S = await api('/api/state'); render(); } catch (e) { toast(e.message); }
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
$('#stop').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try { await api(S.paused.paused ? '/api/resume' : '/api/stop', 'POST'); toast(S.paused.paused ? 'Resumed' : 'Stopped. Nothing gets through.'); } catch (e) { toast(e.message); }
  busy = false;
  refresh();
});

// countdown text only, without rebuilding the page
setInterval(() => {
  document.querySelectorAll('.timer').forEach((t) => {
    const left = Math.max(0, Math.round((Number(t.dataset.ts) + S.policy.approvalTimeoutSec * 1000 - Date.now()) / 1000));
    t.textContent = `denies in ${left}s`;
  });
}, 1000);

const es = new EventSource('/api/stream');
es.addEventListener('update', refresh);
setInterval(refresh, 8000); // safety net if the stream drops
refresh();
