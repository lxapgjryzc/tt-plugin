// `npm run autostart:on` / `npm run autostart:off` (requirements R9.6).
//
// on:  registers the Windows scheduled tasks described in tools/autostart-tasks.mjs (start
//      at logon, and a check every few minutes that brings a killed app back unless the user
//      quit it); then starts the app now.
// off: removes both tasks and asks a running app to quit.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, PORT } from '../app/paths.mjs';
import { registerScript, unregisterScript, WATCHDOG_MINUTES } from './autostart-tasks.mjs';

const SERVICE = fileURLToPath(new URL('../app/service.mjs', import.meta.url));

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim() || `PowerShell exited with ${r.status}`);
  return r.stdout.trim();
}

async function quitRunningApp() {
  if (!existsSync(DB_FILE)) return false;
  let key;
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    key = JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'appKey'").get()?.value || 'null');
  } finally {
    db.close();
  }
  if (!key) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/call/quit`, { method: 'POST', headers: { 'X-Chamber-Key': key, 'Content-Type': 'application/json' }, body: '{}' });
    return res.ok;
  } catch {
    return false; // not running
  }
}

const mode = process.argv[2];
if (process.platform !== 'win32') {
  console.error('Autostart is only set up on Windows. Run `npm start` instead.');
  process.exit(1);
}

if (mode === 'on') {
  ps(registerScript({ node: process.execPath, service: SERVICE }));
  console.log(`Autostart is on. Chamber starts at logon, comes back within ${WATCHDOG_MINUTES} minutes if it is killed, and is starting now: http://127.0.0.1:${PORT}/`);
} else if (mode === 'off') {
  ps(unregisterScript());
  const quit = await quitRunningApp();
  console.log(`Autostart is off.${quit ? ' The running app was asked to quit.' : ''}`);
} else {
  console.error('Usage: node tools/autostart.mjs on|off');
  process.exit(1);
}
