// The PowerShell that `npm run autostart:on|off` runs (requirements R9.6). Kept apart from
// tools/autostart.mjs so the task definitions can be tested without registering anything.
//
// Two tasks, both running app/service.mjs with no console window (conhost --headless), with
// no run-time limit, on battery power, as the current user while logged on:
//
//   "Chamber"           at logon (and once by `autostart:on`): starts the app. A new logon
//                       undoes Quit app.
//   "Chamber watchdog"  every WATCHDOG_MINUTES: starts the app if nothing listens on its
//                       port and the user did not quit (service.mjs --watchdog). This brings
//                       the app back after its whole process tree is killed, which the
//                       supervisor cannot survive and Task Scheduler cannot see (conhost
//                       always exits 0, so "restart on failure" never fires).
//
// MultipleInstances IgnoreNew: a firing while that task's previous run still hosts the app
// is dropped, and a run that finds the app up exits at once.

export const TASK = 'Chamber';
export const WATCHDOG_TASK = 'Chamber watchdog';
export const WATCHDOG_MINUTES = 5;
// The longest repetition Task Scheduler accepts here is 3650 days ([TimeSpan]::MaxValue and
// 9999 days are refused with 0x80041318); `autostart:on` again renews it.
export const WATCHDOG_DAYS = 3650;

export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function registerScript({ node, service }) {
  const args = (extra = '') => `('--headless "' + ${psQuote(node)} + '" "' + ${psQuote(service)} + '"${extra}')`;
  return `
$user = "$env:USERDOMAIN\\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${args()}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
Register-ScheduledTask -TaskName ${psQuote(TASK)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Chamber: submits queued tenten.art drawings as review slots free up.' -Force | Out-Null

$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${args(' --watchdog')}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(${WATCHDOG_MINUTES}) -RepetitionInterval (New-TimeSpan -Minutes ${WATCHDOG_MINUTES}) -RepetitionDuration (New-TimeSpan -Days ${WATCHDOG_DAYS})
Register-ScheduledTask -TaskName ${psQuote(WATCHDOG_TASK)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Chamber: starts the app again if it was killed (not after Quit app).' -Force | Out-Null

Start-ScheduledTask -TaskName ${psQuote(TASK)}
`;
}

export function unregisterScript() {
  return [TASK, WATCHDOG_TASK]
    .map((t) => `if (Get-ScheduledTask -TaskName ${psQuote(t)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${psQuote(t)} -Confirm:$false }`)
    .join('\n');
}
