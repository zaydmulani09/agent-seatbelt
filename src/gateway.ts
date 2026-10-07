import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { classify, type ToolClass } from './classify.js';
import { readPause, setPause } from './control.js';
import { Store } from './log.js';
import { files, type Files } from './paths.js';
import { decide, extractAmount, loadPolicy, presetPolicy, type Policy } from './policy.js';
import { canonical, redact, sha256 } from './redact.js';
import { describe, summarize, type Outcome } from './summary.js';

export interface UpstreamSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface Upstream {
  spec: UpstreamSpec;
  client: Client;
}

interface Resolved {
  up: Upstream;
  raw: string;
  tool: Tool;
}

export interface GatewayOptions {
  upstreams: UpstreamSpec[];
  home?: string;
  /** Force or forbid `server__tool` names. Default: only when there is more than one upstream. */
  namespace?: boolean;
  /** Override for tests. */
  pollMs?: number;
}

const SEP = '__';

export class Gateway {
  readonly files: Files;
  readonly store: Store;
  private ups: Upstream[] = [];
  private server!: Server;
  private ns: boolean;
  private tools = new Map<string, Resolved>();
  private pollMs: number;

  constructor(private opts: GatewayOptions) {
    this.files = files(opts.home);
    this.store = new Store(this.files.db);
    this.ns = opts.namespace ?? opts.upstreams.length > 1;
    this.pollMs = opts.pollMs ?? 200;
  }

  async connect(): Promise<void> {
    this.ups = await Promise.all(
      this.opts.upstreams.map(async (spec) => {
        const client = new Client({ name: 'agent-seatbelt', version: '0.1.0' }, { capabilities: {} });
        let t: Transport;
        if (spec.url) {
          t = new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } });
        } else if (spec.command) {
          t = new StdioClientTransport({
            command: spec.command,
            args: spec.args ?? [],
            env: { ...(process.env as Record<string, string>), ...spec.env },
            stderr: 'inherit',
          });
        } else throw new Error(`upstream "${spec.name}" needs a command or a url`);
        await client.connect(t);
        return { spec, client };
      }),
    );
    const caps = this.ups.map((u) => u.client.getServerCapabilities() ?? {});
    const any = (k: 'tools' | 'resources' | 'prompts') => caps.some((c) => c[k]);
    this.server = new Server(
      { name: 'agent-seatbelt', version: '0.1.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          ...(any('resources') ? { resources: { listChanged: true } } : {}),
          ...(any('prompts') ? { prompts: { listChanged: true } } : {}),
        },
      },
    );
    this.wire();
  }

  async serve(transport: Transport): Promise<void> {
    if (!this.server) await this.connect();
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server?.close().catch(() => {});
    await Promise.all(this.ups.map((u) => u.client.close().catch(() => {})));
    this.store.close();
  }

  // ---- naming -------------------------------------------------------------

  private pub(up: Upstream, raw: string): string {
    return this.ns ? `${up.spec.name}${SEP}${raw}` : raw;
  }

  private split(name: string): { up: Upstream; raw: string } | undefined {
    if (!this.ns) return this.ups[0] ? { up: this.ups[0], raw: name } : undefined;
    const i = name.indexOf(SEP);
    const up = this.ups.find((u) => u.spec.name === name.slice(0, i));
    return up ? { up, raw: name.slice(i + SEP.length) } : undefined;
  }

  // ---- protocol wiring ----------------------------------------------------

  private wire(): void {
    const s = this.server;
    const bounce = (schema: any, send: () => Promise<void>) =>
      this.ups.forEach((u) => u.client.setNotificationHandler(schema, () => send().catch(() => {})));
    bounce(ToolListChangedNotificationSchema, () => this.server.sendToolListChanged());
    bounce(ResourceListChangedNotificationSchema, () => this.server.sendResourceListChanged());
    bounce(PromptListChangedNotificationSchema, () => this.server.sendPromptListChanged());

    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listAll() }));

    s.setRequestHandler(CallToolRequestSchema, (req) => this.handleCall(req.params.name, req.params.arguments ?? {}));

    s.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = [];
      for (const up of this.ups) {
        if (!up.client.getServerCapabilities()?.resources) continue;
        const r = await up.client.listResources();
        resources.push(...r.resources.map((x) => ({ ...x, uri: this.pubUri(up, x.uri), name: this.ns ? this.pub(up, x.name) : x.name })));
      }
      return { resources };
    });
    s.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const resourceTemplates = [];
      for (const up of this.ups) {
        if (!up.client.getServerCapabilities()?.resources) continue;
        const r = await up.client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
        // Templates cannot be rewritten safely with a namespace prefix, so they are only exposed in transparent mode.
        if (!this.ns) resourceTemplates.push(...r.resourceTemplates);
      }
      return { resourceTemplates };
    });
    s.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const hit = this.resolveUri(req.params.uri);
      if (!hit) throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${req.params.uri}`);
      const policy = this.policy();
      const phrase = describe('read resource', 'read', { uri: hit.raw });
      const blocked = readPause(this.files).paused ? 'paused' : policy.classes.read === 'deny' ? 'blocked' : undefined;
      this.log({ tool: `resource:${hit.raw}`, up: hit.up, cls: 'read', decision: blocked ? 'deny' : 'allow', outcome: (blocked ?? 'done') as Outcome, code: blocked ? 'resource' : '', phrase, args: { uri: hit.raw }, policy });
      if (blocked) throw new McpError(ErrorCode.InvalidRequest, 'Agent Seatbelt blocked this resource read.');
      const r = await hit.up.client.readResource({ uri: hit.raw });
      return { ...r, contents: r.contents.map((c) => ({ ...c, uri: req.params.uri })) };
    });

    s.setRequestHandler(ListPromptsRequestSchema, async () => {
      const prompts = [];
      for (const up of this.ups) {
        if (!up.client.getServerCapabilities()?.prompts) continue;
        const r = await up.client.listPrompts();
        prompts.push(...r.prompts.map((p) => ({ ...p, name: this.pub(up, p.name) })));
      }
      return { prompts };
    });
    s.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const hit = this.split(req.params.name);
      if (!hit) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt ${req.params.name}`);
      return hit.up.client.getPrompt({ name: hit.raw, arguments: req.params.arguments });
    });
  }

  private pubUri(up: Upstream, uri: string): string {
    return this.ns ? `seatbelt://${encodeURIComponent(up.spec.name)}/${encodeURIComponent(uri)}` : uri;
  }

  private resolveUri(uri: string): { up: Upstream; raw: string } | undefined {
    if (!this.ns) return this.ups[0] ? { up: this.ups[0], raw: uri } : undefined;
    const m = /^seatbelt:\/\/([^/]+)\/(.+)$/.exec(uri);
    const up = m && this.ups.find((u) => u.spec.name === decodeURIComponent(m[1]));
    return up && m ? { up, raw: decodeURIComponent(m[2]) } : undefined;
  }

  // ---- the guarded path ---------------------------------------------------

  private policy(): Policy {
    try {
      return loadPolicy(this.files.policy);
    } catch (err) {
      // A broken policy file must never silently open the gate: fall back to the strictest preset.
      process.stderr.write(`agent-seatbelt: policy.yaml is invalid (${(err as Error).message}), using strict\n`);
      return presetPolicy('strict');
    }
  }

  private log(o: {
    tool: string;
    up?: Upstream;
    cls: string;
    decision: 'allow' | 'ask' | 'deny' | 'paused' | 'system';
    outcome: Outcome | 'system';
    code: string;
    phrase: { past: string; inf: string };
    args: unknown;
    policy: Policy;
    reason?: string;
    amount?: number;
  }): void {
    const hash = sha256(canonical(o.args));
    this.store.append({
      agent: this.server?.getClientVersion()?.name ?? '',
      upstream: o.up?.spec.name ?? '',
      tool: o.tool,
      cls: o.cls,
      decision: o.decision,
      outcome: o.outcome,
      code: o.code,
      summary: o.outcome === 'system' ? o.phrase.past : summarize(o.outcome, o.phrase, o.reason),
      detail: o.reason ?? '',
      args: o.policy.logArguments === 'hash' ? '' : JSON.stringify(redact(o.args)),
      argsHash: hash,
      amount: o.amount,
    });
  }

  private refusal(code: string, reason: string, tool: string): CallToolResult {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            blocked: true,
            by: 'agent-seatbelt',
            code,
            tool,
            reason: `Blocked by the user's safety settings: ${reason}.`,
            instruction: 'Do not retry this call, do not split it up, reword it or try another tool to get around it. Tell the user it was blocked and why.',
          }),
        },
      ],
    };
  }

  async handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.tools.has(name)) await this.listAll();
    const hit = this.tools.get(name);
    if (!hit) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${name}`);
    const policy = this.policy();
    const override = policy.classOverrides[name] ?? policy.classOverrides[hit.raw];
    const cls: ToolClass = classify(hit.tool, override).cls;
    const amountForLog = cls === 'money' ? extractAmount(name, args, policy.spend) : undefined;
    const phrase = describe(name, cls, args, policy.spend.currency);
    const base = { tool: name, up: hit.up, cls, phrase, args, policy, amount: amountForLog };

    const pause = readPause(this.files);
    if (pause.paused) {
      this.log({ ...base, decision: 'paused', outcome: 'paused', code: 'paused', reason: pause.reason });
      return this.refusal('paused', `everything is paused (${pause.reason ?? 'STOP pressed'})`, name);
    }

    const now = Date.now();
    const argsHash = sha256(canonical(args));
    const ru = policy.runaway;
    if (ru.enabled) {
      const volume = ru.calls > 0 && this.store.callsSince(now - ru.windowSec * 1000) + 1 >= ru.calls;
      const loop = ru.repeats > 0 && this.store.repeatsSince(now - 60_000, name, argsHash) + 1 >= ru.repeats;
      if (volume || loop) {
        const why = loop ? `the same call to "${name}" repeated ${ru.repeats} times in a minute` : `${ru.calls} calls in ${ru.windowSec} seconds`;
        setPause(this.files, `Runaway agent: ${why}`);
        this.store.append({ tool: '(gateway)', cls: 'system', decision: 'system', outcome: 'system', code: 'runaway', summary: `Everything paused automatically: ${why}. Press Resume when you are ready.` });
        this.log({ ...base, decision: 'paused', outcome: 'paused', code: 'runaway', reason: why });
        return this.refusal('runaway', `the agent looks stuck in a loop (${why}), so everything was paused`, name);
      }
    }

    const d = decide(policy, {
      tool: name,
      rawName: hit.raw,
      cls,
      args,
      spentToday: this.store.spentToday(),
      callsLastMinute: this.store.callsSince(now - 60_000),
    });

    if (d.action === 'deny') {
      this.log({ ...base, decision: 'deny', outcome: 'blocked', code: d.code, reason: d.reason, amount: d.amount ?? amountForLog });
      return this.refusal(d.code, d.reason, name);
    }

    let outcome: Outcome = 'done';
    if (d.action === 'ask') {
      const verdict = await this.askHuman(name, cls, phrase.inf, args, policy, d.amount ?? amountForLog, d.reason);
      if (verdict !== 'approved') {
        const out: Outcome = verdict === 'paused' ? 'paused' : verdict;
        this.log({ ...base, decision: 'ask', outcome: out, code: verdict, reason: verdict === 'timeout' ? `no answer in ${policy.approvalTimeoutSec} seconds` : undefined });
        const why = verdict === 'denied' ? 'the user said no' : verdict === 'timeout' ? 'the user did not approve in time' : 'everything was paused';
        return this.refusal(verdict === 'denied' ? 'user_denied' : verdict === 'timeout' ? 'approval_timeout' : 'paused', why, name);
      }
      outcome = 'approved';
    }

    try {
      const result = (await hit.up.client.callTool({ name: hit.raw, arguments: args })) as CallToolResult;
      this.log({ ...base, decision: d.action, outcome: result.isError ? 'error' : outcome, code: d.code, amount: result.isError ? undefined : d.amount ?? amountForLog });
      return result;
    } catch (err) {
      this.log({ ...base, decision: d.action, outcome: 'error', code: 'upstream_error', reason: (err as Error).message });
      throw err;
    }
  }

  private async listAll(): Promise<Tool[]> {
    this.tools.clear();
    const out: Tool[] = [];
    for (const up of this.ups) {
      if (!up.client.getServerCapabilities()?.tools) continue;
      let cursor: string | undefined;
      do {
        const r = await up.client.listTools({ cursor });
        for (const t of r.tools) {
          const name = this.pub(up, t.name);
          this.tools.set(name, { up, raw: t.name, tool: t });
          out.push({ ...t, name });
        }
        cursor = r.nextCursor;
      } while (cursor);
    }
    return out;
  }

  private async askHuman(
    tool: string,
    cls: string,
    inf: string,
    args: unknown,
    policy: Policy,
    amount: number | undefined,
    why: string,
  ): Promise<'approved' | 'denied' | 'timeout' | 'paused'> {
    const id = this.store.createApproval({
      agent: this.server.getClientVersion()?.name ?? '',
      tool,
      cls,
      summary: `Agent wants to ${inf}.`,
      detail: why,
      args: policy.logArguments === 'hash' ? '' : JSON.stringify(redact(args)),
      amount,
    });
    const abort = new AbortController();
    const caps = this.server.getClientCapabilities();
    if (caps?.elicitation) {
      this.server
        .elicitInput(
          {
            mode: 'form',
            message: `Agent Seatbelt: the agent wants to ${inf}. Allow it?`,
            requestedSchema: { type: 'object', properties: { allow: { type: 'boolean', title: 'Allow this action' } }, required: ['allow'] },
          },
          { signal: abort.signal, timeout: policy.approvalTimeoutSec * 1000 },
        )
        .then((r) => this.store.decide(id, r.action === 'accept' && r.content?.allow === true ? 'approved' : 'denied'))
        .catch(() => {});
    }
    const deadline = Date.now() + policy.approvalTimeoutSec * 1000;
    try {
      for (;;) {
        const a = this.store.approval(id);
        if (a && a.status !== 'pending') return a.status === 'approved' ? 'approved' : a.status === 'timeout' ? 'timeout' : 'denied';
        if (readPause(this.files).paused) {
          this.store.decide(id, 'denied');
          return 'paused';
        }
        if (Date.now() >= deadline) {
          if (this.store.decide(id, 'timeout')) return 'timeout';
          continue;
        }
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    } finally {
      abort.abort();
    }
  }
}
