// Autostart and recovery after a kill (requirements R9.6): the launch decision, the task
// definitions, and app/service.mjs's periodic mode, which must stay silent when it has
// nothing to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchDecision, isListening } from '../app/launch.mjs';
import { registerScript, unregisterScript, TASK, WATCHDOG_TASK, WATCHDOG_MINUTES } from '../tools/autostart-tasks.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'chamber-test-'));
const SERVICE = fileURLToPath(new URL('../app/service.mjs', import.meta.url));
const MAIN = fileURLToPath(new URL('../app/main.mjs', import.meta.url));

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function runNode(file, args, env) {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: 'ignore' });
  return new Promise((r) => child.on('exit', r));
}

// ---- the decision -----------------------------------------------------------------

test('launch: the logon task starts the app, even after Quit app', () => {
  assert.equal(launchDecision({ mode: 'logon', running: false, quit: false }), 'start');
  assert.equal(launchDecision({ mode: 'logon', running: false, quit: true }), 'start');
});

test('launch: the periodic check brings a killed app back', () => {
  assert.equal(launchDecision({ mode: 'watchdog', running: false, quit: false }), 'start');
});

test('launch: the periodic check leaves a quit app down', () => {
  assert.equal(launchDecision({ mode: 'watchdog', running: false, quit: true }), 'quit');
});

test('launch: nothing starts while the app is running', () => {
  for (const mode of ['logon', 'watchdog']) {
    for (const quit of [false, true]) assert.equal(launchDecision({ mode, running: true, quit }), 'running');
  }
});

test('isListening sees a listening port and a closed one', async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  try {
    assert.equal(await isListening(port), true);
  } finally {
    await new Promise((r) => s.close(r));
  }
  assert.equal(await isListening(port), false);
});

// ---- the tasks ----------------------------------------------------------------------

test('tasks: a logon task and a periodic task, both headless and IgnoreNew', () => {
  const s = registerScript({ node: 'C:\\Program Files\\nodejs\\node.exe', service: "C:\\it's\\app\\service.mjs" });
  const registrations = s.match(/Register-ScheduledTask .*/g);
  assert.equal(registrations.length, 2);
  assert.match(registrations[0], new RegExp(`-TaskName '${TASK}' `));
  assert.match(registrations[1], new RegExp(`-TaskName '${WATCHDOG_TASK}' `));
  assert.match(s, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(s, new RegExp(`-Once .*-RepetitionInterval \\(New-TimeSpan -Minutes ${WATCHDOG_MINUTES}\\) -RepetitionDuration \\(New-TimeSpan -Days 3650\\)`));
  assert.ok(WATCHDOG_MINUTES <= 10, 'the recovery window stays short');
  assert.match(s, /-MultipleInstances IgnoreNew/);
  assert.match(s, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  const actions = s.match(/New-ScheduledTaskAction .*/g);
  assert.equal(actions.length, 2);
  for (const a of actions) assert.match(a, /-Execute 'conhost.exe' -Argument \('--headless "'/);
  assert.doesNotMatch(actions[0], /--watchdog/);
  assert.match(actions[1], /" --watchdog'\)$/);
  assert.match(s, /'C:\\it''s\\app\\service.mjs'/, 'paths are quoted for PowerShell');
  assert.match(s, new RegExp(`Start-ScheduledTask -TaskName '${TASK}'\\s*$`), 'starts the logon task (which ignores Quit app)');
});

test('tasks: off removes both, and nothing kills by image name', () => {
  const s = unregisterScript();
  assert.match(s, new RegExp(`Unregister-ScheduledTask -TaskName '${TASK}'`));
  assert.match(s, new RegExp(`Unregister-ScheduledTask -TaskName '${WATCHDOG_TASK}'`));
  for (const x of [s, registerScript({ node: 'n', service: 's' })]) assert.doesNotMatch(x, /taskkill|Stop-Process/i);
});

// ---- service.mjs --watchdog and the quit marker --------------------------------------

test('service --watchdog after Quit app: exits without starting or logging anything', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'quit'), 'x\n');
    const port = await freePort();
    const code = await runNode(SERVICE, ['--watchdog'], { CHAMBER_HOME: dir, CHAMBER_PORT: String(port) });
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'app.log')), false);
    assert.equal(existsSync(join(dir, 'chamber.sqlite')), false);
    assert.equal(existsSync(join(dir, 'quit')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('service while the app is running: exits without starting or logging anything', async () => {
  const dir = tmp();
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  try {
    for (const args of [['--watchdog'], []]) {
      const code = await runNode(SERVICE, args, { CHAMBER_HOME: dir, CHAMBER_PORT: String(port) });
      assert.equal(code, 0);
      assert.equal(existsSync(join(dir, 'app.log')), false, args.join(' ') || 'logon');
    }
  } finally {
    blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second instance leaves the quit marker alone', async () => {
  const dir = tmp();
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  try {
    writeFileSync(join(dir, 'quit'), 'x\n');
    const code = await runNode(MAIN, [], { CHAMBER_HOME: dir, CHAMBER_PORT: String(port) });
    assert.equal(code, 3);
    assert.equal(existsSync(join(dir, 'quit')), true);
  } finally {
    blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
