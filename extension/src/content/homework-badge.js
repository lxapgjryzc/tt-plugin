// Content script on tenten.art. Three jobs:
// 1. Hand the SPA's bearer token to the service worker (so ticks work after the tab closes).
// 2. On an assignment page, show one floating pill that links into the queue.
// 3. Below the site's own submit button, add an "add to queue" button: it queues the image the user
//    put into the site's upload box for the node being viewed, instead of submitting now.
// It never changes or restyles the platform's own controls.
(() => {
  const AUTH_KEY = 'tenten-auth';
  const DISMISS_KEY = 'chamber-badge-dismissed';
  const ROUTE = /^\/student\/assignment\/(\d+)/;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  // The site is Chinese-only, so injected UI uses the Chinese strings whatever the
  // extension's own language setting is (fetched once from the service worker).
  let strings = null;
  const t = (k, subs) => {
    const entry = strings?.[k];
    if (!entry) return chrome.i18n.getMessage(k, subs) || k;
    const list = [].concat(subs ?? []).map(String);
    return entry.message.replace(/\$P(\d)\$/g, (_, n) => list[Number(n) - 1] ?? '');
  };

  let lastToken;
  function syncToken() {
    let token = null;
    try { token = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.token || null; } catch { /* ignore */ }
    if (token !== lastToken) {
      lastToken = token;
      send({ type: 'chamber:token', token });
    }
  }

  // ---- badge ------------------------------------------------------------
  let host = null;
  let shown = null; // assignmentId currently rendered

  function svg(path) {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">${path}</svg>`;
  }

  function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const CSS = `
    :host { all: initial; }
    /* right: 84px keeps clear of the platform's own floating buttons (right 28-68px). */
    .pill { position: fixed; right: 84px; bottom: 40px; z-index: 2147483000;
      font: 13px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      font-variant-numeric: tabular-nums;
      --bg: #fafaf9; --fg: #1c1c1c; --muted: #6b6b6b; --line: #e2e2df; --accent: #c2410c;
      color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 20px;
      display: flex; flex-direction: column; overflow: hidden; max-width: 320px; }
    .pill.dark { --bg: #1b1b1a; --fg: #ececea; --muted: #9a9a96; --line: #343432; --accent: #fb923c; }
    .row { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px; }
    .name { font-weight: 600; white-space: nowrap; }
    .pips { display: flex; gap: 4px; }
    .pip { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--fg); box-sizing: border-box; }
    .pip.on { background: var(--fg); }
    .more { display: none; padding: 0 16px 16px; flex-direction: column; gap: 8px; }
    .pill:hover .more, .pill:focus-within .more { display: flex; }
    .label { font-size: 11px; color: var(--muted); text-transform: uppercase; }
    .val { overflow-wrap: anywhere; }
    button { font: inherit; color: inherit; background: none; border: 1px solid var(--line); border-radius: 6px;
      padding: 4px 12px; cursor: pointer; }
    button.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
    button.icon { border: 0; padding: 4px; display: inline-flex; color: var(--muted); margin-left: auto; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: no-preference) { button { transition: background-color 140ms ease; } }
  `;

  // Follow the site's own theme (it has a light/dark toggle independent of the OS):
  // judge by the page background, fall back to the OS preference if it is transparent.
  function siteIsDark() {
    for (const node of [document.body, document.documentElement]) {
      const m = node && getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0)) {
        const [r, g, b] = m.map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
      }
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }
  let pillEl = null;
  function syncTheme() {
    pillEl?.classList.toggle('dark', siteIsDark());
  }

  async function render(assignmentId) {
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return remove();
    if (shown === assignmentId && host) return;
    remove();
    shown = assignmentId;

    host = el('div', { id: 'chamber-badge' });
    const root = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = CSS;
    const pill = el('div', { class: 'pill', role: 'complementary', 'aria-label': t('extName') });
    pillEl = pill;
    syncTheme();

    const row = el('div', { class: 'row' });
    row.append(el('span', { class: 'name' }, t('extName')));
    const pips = el('span', { class: 'pips', 'aria-hidden': 'true' });
    row.append(pips);
    const close = el('button', { class: 'icon', title: t('badgeDismiss'), 'aria-label': t('badgeDismiss') });
    close.innerHTML = svg('<path d="M4 4l8 8M12 4l-8 8"/>');
    close.addEventListener('click', () => { sessionStorage.setItem(DISMISS_KEY, '1'); remove(); });
    row.append(close);

    const more = el('div', { class: 'more' });
    const aLabel = el('div', { class: 'label' }, t('badgeAssignment'));
    const aVal = el('div', { class: 'val' }, '…');
    const nLabel = el('div', { class: 'label' }, t('badgeLastNode'));
    const nVal = el('div', { class: 'val' }, t('badgeNoneYet'));
    const add = el('button', { class: 'primary' }, t('addToQueue'));
    more.append(aLabel, aVal, nLabel, nVal, add);
    pill.append(row, more);
    root.append(style, pill);
    document.documentElement.append(host);

    const [info, store] = await Promise.all([
      send({ type: 'chamber:lookup', assignmentId }),
      chrome.storage.local.get(['chamber:lastPick', 'chamber:snapshot']),
    ]);
    if (shown !== assignmentId) return;
    aVal.textContent = info?.title || t('badgeUnknown');
    const pick = store['chamber:lastPick'];
    let nodeId = null;
    if (pick && pick.assignmentId === assignmentId) {
      nodeId = pick.nodeId;
      nVal.textContent = pick.label;
    }
    const snap = store['chamber:snapshot'];
    if (snap?.limit != null) {
      for (let i = 0; i < snap.limit; i++) pips.append(el('span', { class: `pip${i < snap.pending.length ? ' on' : ''}` }));
      pips.setAttribute('title', t('slotsFree', [String(Math.max(0, snap.limit - snap.pending.length)), String(snap.limit)]));
    }
    add.addEventListener('click', () => {
      const q = new URLSearchParams({ a: assignmentId });
      if (nodeId) q.set('n', nodeId);
      send({ type: 'chamber:openQueue', query: `?${q}` });
    });
  }

  function remove() {
    host?.remove();
    host = null;
    pillEl = null;
    shown = null;
  }

  // ---- "add to queue" next to the site's submit button --------------------
  // The site shows the chosen image as img.upload-preview (a blob: URL of the original
  // file). As a fallback, remember the last file pasted / dropped / picked there.
  let lastFile = null;
  const remember = (f) => { if (f && f.type?.startsWith('image/')) lastFile = f; };
  document.addEventListener('paste', (e) => remember([...(e.clipboardData?.files || [])][0]), true);
  document.addEventListener('drop', (e) => { if (e.target.closest?.('.upload-zone')) remember([...(e.dataTransfer?.files || [])][0]); }, true);
  document.addEventListener('change', (e) => { if (e.target.closest?.('.upload-zone')) remember(e.target.files?.[0]); }, true);

  let enq = null; // { wrap, btn, note, busy }

  function buildEnqueue(submit) {
    const wrap = el('div', { class: 'chamber-enqueue', style: 'margin-top:8px' });
    const cls = submit.className.split(/\s+/).filter((c) => c && c !== 'submit-btn' && c !== 'ant-btn-primary');
    const btn = el('button', { type: 'button', class: [...cls, 'ant-btn-default'].join(' ') });
    btn.append(el('span', {}, t('enqueueOnPage')));
    const note = el('div', { role: 'status', style: 'margin-top:8px;font-size:13px;line-height:1.5;min-height:20px;opacity:.85' });
    btn.addEventListener('click', () => enqueueFromPage());
    wrap.append(btn, note);
    return { wrap, btn, note, busy: false };
  }

  function syncEnqueue(onAssignment) {
    const submit = onAssignment ? document.querySelector('.upload-section .submit-btn') : null;
    if (!submit) {
      enq?.wrap.remove();
      enq = null;
      return;
    }
    if (!enq) enq = buildEnqueue(submit);
    // The SPA may re-render its section; put the button back right after its submit button.
    if (submit.nextElementSibling !== enq.wrap) submit.after(enq.wrap);
    const preview = document.querySelector('.upload-section img.upload-preview');
    enq.btn.disabled = enq.busy || !preview;
  }

  function currentNode() {
    const active = document.querySelector('.node-steps .node-step-title.active');
    if (!active) return { nodeTitle: null, nodeOrder: null };
    const steps = [...document.querySelectorAll('.node-steps .node-step')];
    const idx = steps.findIndex((s) => s.contains(active));
    return { nodeTitle: active.textContent.trim(), nodeOrder: idx >= 0 ? idx + 1 : null };
  }

  async function currentImage() {
    const preview = document.querySelector('.upload-section img.upload-preview');
    if (preview?.src) {
      try {
        const b = await (await fetch(preview.src)).blob();
        if (b.size) return { blob: b, name: lastFile?.size === b.size ? lastFile.name : `drawing.${(b.type.split('/')[1] || 'png')}` };
      } catch { /* fall back to the remembered file */ }
    }
    return lastFile ? { blob: lastFile, name: lastFile.name } : null;
  }

  const toDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  function showNote(text, isError) {
    if (!enq) return;
    enq.note.textContent = text;
    enq.note.style.color = isError ? '#c2410c' : '';
  }

  async function enqueueFromPage() {
    const m = ROUTE.exec(location.pathname);
    if (!m || !enq || enq.busy) return;
    enq.busy = true;
    enq.btn.disabled = true;
    showNote(t('enqueueing'), false);
    try {
      const img = await currentImage();
      if (!img) { showNote(t('errNoImage'), true); return; }
      const res = await send({ type: 'chamber:enqueue', assignmentId: m[1], ...currentNode(), dataUrl: await toDataUrl(img.blob), name: img.name });
      if (res?.ok) {
        showNote(t(res.chained ? 'enqueuedChained' : 'enqueuedOk'), false);
      } else {
        const key = res?.error === 'NO_TAB' || res?.error === 'SESSION_INVALID' ? 'sessionInvalid' : res?.error;
        showNote(key ? `${t(key)}${res.detail ? `: ${res.detail}` : ''}` : t('enqueueFailed'), true);
      }
    } catch (e) {
      showNote(`${t('enqueueFailed')}: ${e?.message || e}`, true);
    } finally {
      enq.busy = false;
    }
  }

  // ---- SPA navigation (history API is not observable from the isolated world) ----
  let lastPath = null;
  function check() {
    syncToken();
    syncTheme();
    syncEnqueue(ROUTE.test(location.pathname));
    if (location.pathname === lastPath) return;
    if (enq) showNote('', false);
    lastPath = location.pathname;
    send({ type: 'chamber:pageNav' });
    const m = ROUTE.exec(location.pathname);
    if (m) render(m[1]);
    else remove();
  }

  send({ type: 'chamber:pageStrings' }).then((s) => {
    if (s && typeof s === 'object' && !s.error) strings = s;
  }).finally(() => {
    check();
    setInterval(check, 500);
  });
  window.addEventListener('popstate', check);
})();
