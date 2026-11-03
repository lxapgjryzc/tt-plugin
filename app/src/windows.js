// The few things the app asks of Windows, through Windows PowerShell 5.1 (part of every
// Windows 10/11; no install, no native module):
// - DPAPI encryption of the saved password for the current user (requirements R9.9);
// - toast notifications that open the queue page when clicked (R9.15).
// Inputs go through stdin, never the command line.

import { spawn } from 'node:child_process';

const POWERSHELL = 'powershell.exe';
export const AUMID = 'Chamber.QueueApp';

function ps(script, input = '', { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Windows only'));
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim().split('\n')[0] || `PowerShell exited with ${code}`));
    });
    // The script reads its input from the first line of stdin; the rest is the script.
    const b64 = Buffer.from(input, 'utf8').toString('base64');
    child.stdin.end(`$in = '${b64}'\n${script}\n`);
  });
}

const DPAPI = (fn) => `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($in)
$text = [Text.Encoding]::UTF8.GetString($bytes)
$data = [Convert]::FromBase64String($text)
$out = [Security.Cryptography.ProtectedData]::${fn}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

export const dpapi = {
  async protect(text) {
    const cipher = await ps(DPAPI('Protect'), Buffer.from(text, 'utf8').toString('base64'));
    if (!cipher) throw new Error('DPAPI returned nothing');
    return cipher;
  },
  async unprotect(cipher) {
    const plain = await ps(DPAPI('Unprotect'), cipher);
    return Buffer.from(plain, 'base64').toString('utf8');
  },
};

const xml = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Register the app's notification identity (name and icon in the Action Center) for the
// current user. Idempotent.
export function registerAumid(displayName, iconPath) {
  return ps(`
$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name DisplayName -Value '${displayName.replace(/'/g, "''")}'
Set-ItemProperty -Path $key -Name IconUri -Value '${iconPath.replace(/'/g, "''")}'
`);
}

const TOAST = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in)) | ConvertFrom-Json
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($p.xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
$toast.Tag = $p.tag
$toast.Group = 'chamber'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($toast)
`;

const CLEAR = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$tag = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in))
[Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, 'chamber', '${AUMID}')
`;

// A toast; clicking it opens `url` (the queue page) in the default browser.
// `sticky` keeps it on screen until dismissed (the logged-out notice).
export function toast({ tag, title, body, url, sticky = false }) {
  const doc = `<toast activationType="protocol" launch="${xml(url)}"${sticky ? ' duration="long"' : ''}>`
    + `<visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
  // Tags are limited to 64 characters.
  return ps(TOAST, JSON.stringify({ xml: doc, tag: String(tag).slice(0, 64) }));
}

export function clearToast(tag) {
  return ps(CLEAR, String(tag).slice(0, 64));
}
