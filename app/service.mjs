// Supervisor used by autostart (requirements R9.6): runs app/main.mjs with its output in
// app.log, and restarts it after a crash (any exit other than 0 = quit, 3 = already
// running), waiting longer after repeated quick crashes.
//
// `node app/service.mjs`             the logon task: start the app unless it is running.
// `node app/service.mjs --watchdog`  the periodic task: also stay down if the user quit
//                                    (QUIT_FILE). It covers what this supervisor cannot:
//                                    its own death, e.g. every node.exe killed at once.

import { spawn } from 'node:child_process';
import { createWriteStream, statSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOME, LOG_FILE, PORT, QUIT_FILE, EXIT_ALREADY_RUNNING } from './paths.mjs';
import { launchDecision, isListening } from './launch.mjs';

const MAIN = fileURLToPath(new URL('./main.mjs', import.meta.url));
const MAX_LOG = 1024 * 1024;
const mode = process.argv.includes('--watchdog') ? 'watchdog' : 'logon';

// Decide before touching the log, so the periodic check leaves no trace when it has
// nothing to do.
const decision = launchDecision({ mode, running: await isListening(PORT), quit: existsSync(QUIT_FILE) });
if (decision !== 'start') process.exit(0);

mkdirSync(HOME, { recursive: true });
try {
  if (statSync(LOG_FILE).size > MAX_LOG) renameSync(LOG_FILE, `${LOG_FILE}.1`);
} catch { /* no log yet */ }
const out = createWriteStream(LOG_FILE, { flags: 'a' });
const log = (m) => out.write(`${new Date().toISOString()} [service] ${m}\n`);

let delay = 2_000;
function run() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [MAIN], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on('exit', (code, signal) => {
    if (code === 0 || code === EXIT_ALREADY_RUNNING) {
      log(`app exited (${code}); not restarting`);
      out.end(() => process.exit(0));
      return;
    }
    // A run that lasted a while resets the back-off.
    delay = Date.now() - startedAt > 10 * 60_000 ? 2_000 : Math.min(delay * 2, 5 * 60_000);
    log(`app crashed (${code ?? signal}); restarting in ${Math.round(delay / 1000)} s`);
    setTimeout(run, delay);
  });
}
log(mode === 'watchdog' ? 'starting (the app was not running)' : 'starting');
run();
