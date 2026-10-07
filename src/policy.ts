import fs from 'node:fs';
import YAML from 'yaml';
import { CLASSES, type ToolClass } from './classify.js';

export type Action = 'allow' | 'ask' | 'deny';
export type PresetName = 'strict' | 'balanced' | 'relaxed';

export interface Rule {
  /** Glob on the tool name, `*` is the only wildcard. */
  tool: string;
  action: Action;
  reason?: string;
  /** Only applies when the argument at `path` matches `regex`. */
  arg?: { path: string; regex: string };
}

export interface Policy {
  preset: PresetName | 'custom';
  classes: Record<ToolClass, Action>;
  rules: Rule[];
  classOverrides: Record<string, ToolClass>;
  spend: { perCall: number; perDay: number; amountPath?: string; paths: Record<string, string>; currency: string };
  rateLimit: { perMinute: number };
  runaway: { enabled: boolean; calls: number; windowSec: number; repeats: number };
  approvalTimeoutSec: number;
  logArguments: 'redacted' | 'hash';
}

type Preset = Pick<Policy, 'classes'> & { spend: Pick<Policy['spend'], 'perCall' | 'perDay'>; rateLimit: number; runaway: [number, number, number] };

export const PRESETS: Record<PresetName, Preset> = {
  strict: {
    classes: { read: 'allow', write: 'ask', money: 'ask', send: 'ask', delete: 'ask', exec: 'deny', unknown: 'deny' },
    spend: { perCall: 5, perDay: 20 },
    rateLimit: 30,
    runaway: [20, 10, 5],
  },
  balanced: {
    classes: { read: 'allow', write: 'allow', money: 'ask', send: 'ask', delete: 'ask', exec: 'ask', unknown: 'ask' },
    spend: { perCall: 25, perDay: 100 },
    rateLimit: 120,
    runaway: [40, 10, 8],
  },
  relaxed: {
    classes: { read: 'allow', write: 'allow', money: 'ask', send: 'allow', delete: 'ask', exec: 'allow', unknown: 'allow' },
    spend: { perCall: 100, perDay: 500 },
    rateLimit: 300,
    runaway: [80, 10, 15],
  },
};

export class PolicyError extends Error {}

const ACTIONS: Action[] = ['allow', 'ask', 'deny'];
const isAction = (v: unknown): v is Action => ACTIONS.includes(v as Action);
const num = (v: unknown, d: number, what: string): number => {
  if (v === undefined || v === null) return d;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new PolicyError(`${what} must be a non-negative number`);
  return v;
};

export function presetPolicy(name: PresetName): Policy {
  const p = PRESETS[name];
  return {
    preset: name,
    classes: { ...p.classes },
    rules: [],
    classOverrides: {},
    spend: { ...p.spend, paths: {}, currency: '$' },
    rateLimit: { perMinute: p.rateLimit },
    runaway: { enabled: true, calls: p.runaway[0], windowSec: p.runaway[1], repeats: p.runaway[2] },
    approvalTimeoutSec: 120,
    logArguments: 'redacted',
  };
}

export function normalizePolicy(raw: unknown): Policy {
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r !== 'object' || Array.isArray(r)) throw new PolicyError('policy must be a mapping');
  const presetName: PresetName = r.preset === undefined || r.preset === 'custom' ? 'balanced' : r.preset;
  if (!(presetName in PRESETS)) throw new PolicyError(`unknown preset "${r.preset}"`);
  const base = presetPolicy(presetName);

  for (const [k, v] of Object.entries(r.classes ?? {})) {
    if (!CLASSES.includes(k as ToolClass)) throw new PolicyError(`unknown tool class "${k}"`);
    if (!isAction(v)) throw new PolicyError(`classes.${k} must be allow, ask or deny`);
    base.classes[k as ToolClass] = v;
  }
  const rules: Rule[] = [];
  for (const [i, x] of (r.rules ?? []).entries()) {
    if (!x || typeof x.tool !== 'string' || !isAction(x.action)) throw new PolicyError(`rules[${i}] needs tool and action`);
    const rule: Rule = { tool: x.tool, action: x.action };
    if (typeof x.reason === 'string') rule.reason = x.reason;
    if (x.arg) {
      if (typeof x.arg.path !== 'string' || typeof x.arg.regex !== 'string') throw new PolicyError(`rules[${i}].arg needs path and regex`);
      try {
        new RegExp(x.arg.regex);
      } catch {
        throw new PolicyError(`rules[${i}].arg.regex is not a valid regex`);
      }
      rule.arg = { path: x.arg.path, regex: x.arg.regex };
    }
    rules.push(rule);
  }
  for (const [k, v] of Object.entries(r.classOverrides ?? {})) {
    if (!CLASSES.includes(v as ToolClass)) throw new PolicyError(`classOverrides.${k} is not a tool class`);
    base.classOverrides[k] = v as ToolClass;
  }
  const s = r.spend ?? {};
  base.spend = {
    perCall: num(s.perCall, base.spend.perCall, 'spend.perCall'),
    perDay: num(s.perDay, base.spend.perDay, 'spend.perDay'),
    amountPath: typeof s.amountPath === 'string' ? s.amountPath : undefined,
    paths: s.paths && typeof s.paths === 'object' ? { ...s.paths } : {},
    currency: typeof s.currency === 'string' ? s.currency : '$',
  };
  base.rateLimit.perMinute = num(r.rateLimit?.perMinute, base.rateLimit.perMinute, 'rateLimit.perMinute');
  const ru = r.runaway ?? {};
  base.runaway = {
    enabled: ru.enabled === undefined ? true : !!ru.enabled,
    calls: num(ru.calls, base.runaway.calls, 'runaway.calls'),
    windowSec: num(ru.windowSec, base.runaway.windowSec, 'runaway.windowSec'),
    repeats: num(ru.repeats, base.runaway.repeats, 'runaway.repeats'),
  };
  base.approvalTimeoutSec = num(r.approvalTimeoutSec, 120, 'approvalTimeoutSec');
  if (r.logArguments !== undefined && r.logArguments !== 'redacted' && r.logArguments !== 'hash') {
    throw new PolicyError('logArguments must be redacted or hash');
  }
  base.logArguments = r.logArguments ?? 'redacted';
  base.rules = rules;
  base.preset = r.preset === 'custom' ? 'custom' : presetName;
  return base;
}

export function loadPolicy(file: string): Policy {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return presetPolicy('balanced');
  }
  return normalizePolicy(YAML.parse(text));
}

export function savePolicy(file: string, p: Policy): void {
  const header = '# Agent Seatbelt policy. Safe to edit by hand or from the dashboard.\n';
  fs.writeFileSync(file, header + YAML.stringify(p));
}

export function globToRegex(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const AMOUNT_KEYS = ['amount', 'price', 'total', 'cost', 'value', 'sum'];

export function extractAmount(tool: string, args: unknown, spend: Policy['spend']): number | undefined {
  const custom = Object.entries(spend.paths).find(([g]) => globToRegex(g).test(tool))?.[1] ?? spend.amountPath;
  const candidates = custom ? [getPath(args, custom)] : AMOUNT_KEYS.map((k) => getPath(args, k));
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : typeof c === 'string' ? parseFloat(c.replace(/[^0-9.\-]/g, '')) : NaN;
    if (Number.isFinite(n)) return Math.abs(n);
  }
  return undefined;
}

export interface Facts {
  tool: string;
  rawName: string;
  cls: ToolClass;
  args: unknown;
  spentToday: number;
  callsLastMinute: number;
}

export interface Decision {
  action: Action;
  code: 'rule' | 'spend_per_call' | 'spend_per_day' | 'rate_limit' | 'class';
  reason: string;
  amount?: number;
}

function ruleMatches(rule: Rule, f: Facts): boolean {
  const re = globToRegex(rule.tool);
  if (!re.test(f.tool) && !re.test(f.rawName)) return false;
  if (!rule.arg) return true;
  const v = getPath(f.args, rule.arg.path);
  return v !== undefined && new RegExp(rule.arg.regex, 'i').test(typeof v === 'string' ? v : JSON.stringify(v));
}

const money = (n: number, cur: string) => `${cur}${n.toFixed(2)}`;

export function decide(p: Policy, f: Facts): Decision {
  const rule = p.rules.find((r) => ruleMatches(r, f));
  const amount = f.cls === 'money' ? extractAmount(f.tool, f.args, p.spend) : undefined;

  if (rule?.action === 'deny') {
    return { action: 'deny', code: 'rule', reason: rule.reason ?? `a rule you set blocks "${rule.tool}"`, amount };
  }
  if (amount !== undefined) {
    if (p.spend.perCall > 0 && amount > p.spend.perCall) {
      return {
        action: 'deny',
        code: 'spend_per_call',
        reason: `${money(amount, p.spend.currency)} is over your per-purchase limit of ${money(p.spend.perCall, p.spend.currency)}`,
        amount,
      };
    }
    if (p.spend.perDay > 0 && f.spentToday + amount > p.spend.perDay) {
      return {
        action: 'deny',
        code: 'spend_per_day',
        reason: `this would bring today's spending to ${money(f.spentToday + amount, p.spend.currency)}, over your daily limit of ${money(p.spend.perDay, p.spend.currency)}`,
        amount,
      };
    }
  }
  if (p.rateLimit.perMinute > 0 && f.callsLastMinute >= p.rateLimit.perMinute) {
    return { action: 'deny', code: 'rate_limit', reason: `more than ${p.rateLimit.perMinute} calls in a minute`, amount };
  }
  if (rule) return { action: rule.action, code: 'rule', reason: rule.reason ?? `a rule you set for "${rule.tool}"`, amount };
  const action = p.classes[f.cls];
  const label = { read: 'looking things up', write: 'making changes', money: 'spending money', send: 'sending messages', delete: 'deleting things', exec: 'running commands', unknown: 'unrecognized actions' }[f.cls];
  return { action, code: 'class', reason: `your ${p.preset} settings say ${action === 'allow' ? 'allow' : action === 'ask' ? 'ask first for' : 'block'} ${label}`, amount };
}
