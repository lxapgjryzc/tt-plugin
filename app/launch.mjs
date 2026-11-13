// What app/service.mjs does when a scheduled task runs it (requirements R9.6). Pure, so it
// can be tested; the caller supplies the facts.
//
// mode 'logon'     the logon task, or `npm run autostart:on`: start the app. A new logon
//                  undoes Quit app.
// mode 'watchdog'  the check every few minutes: start the app only if it is gone and the
//                  user did not quit it (the quit marker is absent). This is what brings
//                  the app back after its whole process tree was killed.
//
// running: something already listens on the app's port.  quit: the quit marker exists.
// Returns 'start', 'running' (leave it alone) or 'quit' (the user quit; stay down).
export function launchDecision({ mode, running, quit }) {
  if (running) return 'running';
  if (mode === 'watchdog' && quit) return 'quit';
  return 'start';
}

// Whether something accepts connections on 127.0.0.1:port.
export async function isListening(port, { host = '127.0.0.1', timeoutMs = 2_000 } = {}) {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
