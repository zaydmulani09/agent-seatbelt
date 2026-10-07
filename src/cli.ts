#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { clearPause, readDash, readPause, setPause } from './control.js';
import { startDashboard } from './dashboard.js';
import { Gateway, type UpstreamSpec } from './gateway.js';
import { apply, detectTargets, diff, plan } from './init.js';
import { Store } from './log.js';
import { files } from './paths.js';
import { loadPolicy } from './policy.js';
import { buildReceipt, receiptHtml, receiptSvg } from './receipt.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const VERSION = '0.1.0';
const HELP = `Agent Seatbelt ${VERSION}: a seatbelt and black box for personal AI agents.

Usage: agent-seatbelt <command>

  init [--dry-run] [--undo] [--local] [--file <path>]
                    Route your Claude Desktop and Claude Code MCP servers through the gateway
  start [--port N] [--open]
                    Open the dashboard (timeline, approvals, rules, receipt)
  stop              Kill switch: pause every agent now
  resume            Let agents act again
  status            Show whether agents are paused, pending questions, spending
  receipt [--days 7] [--out DIR]
                    Write a shareable weekly receipt (SVG and HTML)
  demo [--port N] [--open]
                    Run a scripted misbehaving agent against the dashboard
  proxy --name N (--url U [--header K=V] | -- CMD ARGS...)
                    Guard one MCP server (this is what init writes into your config)
  serve [--config FILE]
                    Guard several MCP servers from gateway.yaml, tools named server__tool

Everything stays on this computer. No accounts, no telemetry.
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (n: string) => rest.includes(n);
const val = (n: string) => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : undefined;
};
const vals = (n: string) => rest.flatMap((a, i) => (a === n ? [rest[i + 1]] : []));

function openBrowser(url: string) {
  const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(c as string, a as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

async function main() {
  switch (cmd) {
    case 'init': {
      const targets = vals('--file').length ? vals('--file').map((file) => ({ label: file, file })) : detectTargets();
      if (!targets.length) return console.log('No Claude Desktop or Claude Code MCP config found. Use --file <path> to point at one.');
      const undo = flag('--undo');
      let total = 0;
      for (const t of targets) {
        let p;
        try {
          p = plan(t.file, undo ? 'undo' : 'wrap', { local: flag('--local') });
        } catch (err) {
          console.log(`${t.label}: skipped (${(err as Error).message})`);
          continue;
        }
        if (!p.changed) {
          console.log(`${t.label}: nothing to ${undo ? 'undo' : 'change'} (${t.file})`);
          continue;
        }
        total += p.changed;
        console.log(`\n${t.label}: ${p.changed} server${p.changed === 1 ? '' : 's'} (${t.file})\n${diff(p.before, p.after)}\n`);
        if (flag('--dry-run')) continue;
        console.log(`Backup saved to ${apply(p)}`);
      }
      console.log(flag('--dry-run') ? `Dry run: nothing written. ${total} change(s) would be made.` : total ? 'Done. Restart Claude so it picks up the change, then run: npx -y github:zaydmulani09/agent-seatbelt start' : 'Done.');
      return;
    }
    case 'start': {
      const d = await startDashboard({ port: val('--port') ? Number(val('--port')) : 7878 });
      console.log(`Dashboard: ${d.url}\nPress Ctrl+C to quit. Agents stay guarded whether or not this window is open.`);
      if (flag('--open')) openBrowser(d.url);
      process.on('SIGINT', () => d.close().then(() => process.exit(0)));
      return;
    }
    case 'stop':
    case 'resume': {
      const f = files();
      const store = new Store(f.db);
      if (cmd === 'stop') {
        setPause(f, 'You ran agent-seatbelt stop');
        store.append({ tool: '(cli)', cls: 'system', decision: 'system', outcome: 'system', code: 'stop', summary: 'You ran stop. Everything is paused.' });
        console.log('STOPPED. Every agent call is refused until you run: agent-seatbelt resume');
      } else {
        clearPause(f);
        store.append({ tool: '(cli)', cls: 'system', decision: 'system', outcome: 'system', code: 'resume', summary: 'You resumed. Agents can act again.' });
        console.log('Resumed.');
      }
      store.close();
      return;
    }
    case 'status': {
      const f = files();
      const store = new Store(f.db);
      const pause = readPause(f);
      const dash = readDash(f);
      const v = store.verify();
      const cur = loadPolicy(f.policy).spend.currency;
      console.log(`State:       ${pause.paused ? `PAUSED (${pause.reason})` : 'watching'}`);
      console.log(`Waiting:     ${store.pending().length} question(s) for you`);
      console.log(`Spent today: ${cur}${store.spentToday().toFixed(2)}`);
      console.log(`Black box:   ${v.count} entries, ${v.ok ? 'tamper check passed' : `TAMPERED near entry ${v.brokenAt}`}`);
      console.log(`Dashboard:   ${dash ? dash.url : 'not running (agent-seatbelt start)'}`);
      console.log(`Config dir:  ${f.home}`);
      store.close();
      return;
    }
    case 'receipt': {
      const f = files();
      const store = new Store(f.db);
      const r = buildReceipt(store, loadPolicy(f.policy).spend.currency, Number(val('--days') ?? 7));
      const out = val('--out') ?? process.cwd();
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'agent-receipt.svg'), receiptSvg(r));
      fs.writeFileSync(path.join(out, 'agent-receipt.html'), receiptHtml(r));
      console.log(`Wrote ${path.join(out, 'agent-receipt.svg')} and agent-receipt.html`);
      store.close();
      return;
    }
    case 'demo': {
      const { runDemo } = await import('./demo.js');
      const d = await runDemo({ port: val('--port') ? Number(val('--port')) : 7878 });
      console.log(`\nDashboard: ${d.url}`);
      if (flag('--open')) openBrowser(d.url);
      process.on('SIGINT', () => d.close().then(() => process.exit(0)));
      return;
    }
    case 'proxy': {
      const dd = rest.indexOf('--');
      const head = dd >= 0 ? rest.slice(0, dd) : rest;
      const tail = dd >= 0 ? rest.slice(dd + 1) : [];
      const get = (n: string) => { const i = head.indexOf(n); return i >= 0 ? head[i + 1] : undefined; };
      const headers = Object.fromEntries(head.flatMap((a, i) => (a === '--header' ? [[...head[i + 1].split(/=(.*)/s)].slice(0, 2) as [string, string]] : [])));
      const spec: UpstreamSpec = { name: get('--name') ?? 'server', ...(get('--url') ? { url: get('--url'), headers } : { command: tail[0], args: tail.slice(1) }) };
      const g = new Gateway({ upstreams: [spec] });
      await g.serve(new StdioServerTransport());
      process.stdin.on('close', () => g.close().then(() => process.exit(0)));
      return;
    }
    case 'serve': {
      const cfg = YAML.parse(fs.readFileSync(val('--config') ?? files().gateway, 'utf8'));
      const upstreams: UpstreamSpec[] = Object.entries<any>(cfg.upstreams ?? {}).map(([name, s]) => ({ name, ...s }));
      if (!upstreams.length) throw new Error('gateway.yaml has no upstreams');
      const g = new Gateway({ upstreams, namespace: true });
      await g.serve(new StdioServerTransport());
      process.stdin.on('close', () => g.close().then(() => process.exit(0)));
      return;
    }
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`agent-seatbelt: ${(err as Error).message}`);
  process.exit(1);
});
