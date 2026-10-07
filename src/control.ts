import fs from 'node:fs';
import type { Files } from './paths.js';

export interface PauseState {
  paused: boolean;
  reason?: string;
  ts?: number;
}

export function readPause(f: Files): PauseState {
  try {
    const raw = JSON.parse(fs.readFileSync(f.paused, 'utf8'));
    return { paused: true, reason: raw.reason, ts: raw.ts };
  } catch {
    return fs.existsSync(f.paused) ? { paused: true, reason: 'Paused' } : { paused: false };
  }
}

export function setPause(f: Files, reason: string): void {
  fs.writeFileSync(f.paused, JSON.stringify({ reason, ts: Date.now() }));
}

export function clearPause(f: Files): void {
  fs.rmSync(f.paused, { force: true });
}

export interface DashInfo {
  port: number;
  pid: number;
  url: string;
}

export function readDash(f: Files): DashInfo | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(f.dash, 'utf8')) as DashInfo;
    process.kill(d.pid, 0);
    return d;
  } catch {
    return undefined;
  }
}
