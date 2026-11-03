// `npm run autostart:on` / `npm run autostart:off` (requirements R9.6).
//
// on:  registers a Windows scheduled task "Chamber" that runs app/service.mjs at the
//      user's logon with no console window (conhost --headless), with no run-time limit
//      and on battery power; then starts it now.
// off: removes the task and asks a running app to quit.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, PORT } from '../app/paths.mjs';

const TASK = 'Chamber';
const SERVICE = fileURLToPath(new URL('../app/service.mjs', import.meta.url));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

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
  ps(`
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless "' + ${q(process.execPath)} + '" "' + ${q(SERVICE)} + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${q(TASK)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Chamber: submits queued tenten.art drawings as review slots free up.' -Force | Out-Null
Start-ScheduledTask -TaskName ${q(TASK)}
`);
  console.log(`Autostart is on. Chamber starts at logon and is starting now: http://127.0.0.1:${PORT}/`);
} else if (mode === 'off') {
  ps(`if (Get-ScheduledTask -TaskName ${q(TASK)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${q(TASK)} -Confirm:$false }`);
  const quit = await quitRunningApp();
  console.log(`Autostart is off.${quit ? ' The running app was asked to quit.' : ''}`);
} else {
  console.error('Usage: node tools/autostart.mjs on|off');
  process.exit(1);
}
