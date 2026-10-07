import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir(): string {
  const env = process.env.SEATBELT_HOME;
  if (env) return env;
  const h = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(h, 'AppData', 'Roaming'), 'agent-seatbelt');
  }
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'agent-seatbelt');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(h, '.config'), 'agent-seatbelt');
}

export interface Files {
  home: string;
  policy: string;
  db: string;
  paused: string;
  token: string;
  dash: string;
  gateway: string;
}

export function files(home = homeDir()): Files {
  fs.mkdirSync(home, { recursive: true });
  return {
    home,
    policy: path.join(home, 'policy.yaml'),
    db: path.join(home, 'blackbox.db'),
    paused: path.join(home, 'PAUSED'),
    token: path.join(home, 'dashboard-token'),
    dash: path.join(home, 'dashboard.json'),
    gateway: path.join(home, 'gateway.yaml'),
  };
}
