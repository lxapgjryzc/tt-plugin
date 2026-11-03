// Chamber background app: `npm start` (foreground) or via app/service.mjs (autostart).
// Exit codes: 0 quit on request, 3 another instance is running, anything else a crash.

import { fileURLToPath } from 'node:url';
import { target } from './src/target.js';
import { makeApp } from './src/app.js';
import { makeServer } from './src/server.js';
import { dpapi, toast, clearToast, registerAumid } from './src/windows.js';
import { HOME, PORT, DB_FILE, EXIT_ALREADY_RUNNING } from './paths.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const BASE = `http://127.0.0.1:${PORT}`;

let app = null;
const server = makeServer(() => app, { port: PORT });

// One instance (R9.3): take the port before opening the database, so a second start
// never touches the data.
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    log(`Port ${PORT} is in use: Chamber is already running (${BASE}/). Exiting.`);
    process.exit(EXIT_ALREADY_RUNNING);
  }
  throw e;
}

let quitting = false;
async function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  log('stopping');
  server.close();
  server.closeAllConnections?.();
  await app?.stop().catch((e) => log('stop failed', e?.message));
  process.exit(code);
}

app = makeApp({
  dbFile: DB_FILE,
  target,
  baseUrl: BASE,
  secret: dpapi,
  notifier: {
    show: (n) => toast(n).catch((e) => log('notification failed:', e?.message)),
    clear: (tag) => clearToast(tag).catch(() => {}),
  },
  onQuit: () => quit(0),
});

process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));

registerAumid('Chamber', fileURLToPath(new URL('./icons/128.png', import.meta.url))).catch(() => {});
await app.start();
log(`Chamber is running: ${BASE}/  (data in ${HOME})`);
