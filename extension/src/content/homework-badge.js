// Content script on tenten.art. Three jobs:
// 1. Hand the SPA's bearer token to the service worker (so ticks work after the tab closes).
// 2. On an assignment page, show one floating pill that links into the queue.
// 3. Add an "add to queue" button next to the site's own submit controls, queuing what
//    the user put in the site's upload box instead of submitting now:
//    - assignment page: below the submit button, the one image in the upload box;
//    - learning page: inside the submit confirmation dialog, all of its images (up to 3).
// It never changes or restyles the platform's own controls.
(() => {
  const AUTH_KEY = 'tenten-auth';
  const DISMISS_KEY = 'chamber-badge-dismissed';
  const ROUTE = /^\/student\/assignment\/(\d+)/;
  const LEARNING = /^\/student\/learning\/(\d+)/;
  const FINAL_STEP_TITLE = '完整作业'; // the site's extra step after all nodes; never queued
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

  // Seconds-precision JWT expiry check (same rule as src/session.js).
  function tokenUsable(token) {
    const part = typeof token === 'string' ? token.split('.')[1] : null;
    if (!part) return !!token;
    try {
      const exp = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')))?.exp;
      return !Number.isFinite(exp) || exp * 1000 > Date.now();
    } catch {
      return true;
    }
  }

  // With automatic login on, put its session into the site's own storage when the
  // site's login has run out, then reload so the site picks it up. Once per session.
  async function restoreSiteLogin() {
    let page = null;
    try { page = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { /* ignore */ }
    if (page?.token && tokenUsable(page.token)) return;
    const session = await send({ type: 'chamber:siteSession' });
    if (!session?.token || !tokenUsable(session.token)) return;
    const guard = `chamber-restored:${session.token.slice(-24)}`;
    if (sessionStorage.getItem(guard)) return;
    sessionStorage.setItem(guard, '1');
    localStorage.setItem(AUTH_KEY, JSON.stringify(session));
    if (location.pathname.startsWith('/login')) location.replace('/');
    else location.reload();
  }

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

  // ---- "add to queue" next to the site's submit controls --------------------
  // The site shows chosen images as blob: URLs of the original files. Files pasted,
  // dropped or picked are remembered so queued images keep their names, and as a
  // fallback for the assignment page.
  const recent = [];
  const remember = (files) => {
    for (const f of [...(files || [])]) if (f?.type?.startsWith('image/')) recent.unshift(f);
    recent.length = Math.min(recent.length, 12);
  };
  const inUpload = (e) => e.target.closest?.('.upload-zone, .upload-cell, .ant-modal');
  document.addEventListener('paste', (e) => remember(e.clipboardData?.files), true);
  document.addEventListener('drop', (e) => { if (inUpload(e)) remember(e.dataTransfer?.files); }, true);
  document.addEventListener('change', (e) => { if (e.target.type === 'file') remember(e.target.files); }, true);

  const nameFor = (blob, i) => recent.find((f) => f.size === blob.size && f.type === blob.type)?.name
    || `drawing-${i + 1}.${(blob.type.split('/')[1] || 'png')}`;

  async function blobsFrom(imgs) {
    const out = [];
    for (const [i, img] of imgs.entries()) {
      const blob = await (await fetch(img.src)).blob();
      if (blob.size) out.push({ blob, name: nameFor(blob, i) });
    }
    return out;
  }

  // Assignment page: one image, node from the step bar.
  function currentNode() {
    const active = document.querySelector('.node-steps .node-step-title.active');
    if (!active) return { nodeTitle: null, nodeOrder: null };
    const steps = [...document.querySelectorAll('.node-steps .node-step')];
    const idx = steps.findIndex((s) => s.contains(active));
    return { nodeTitle: active.textContent.trim(), nodeOrder: idx >= 0 ? idx + 1 : null };
  }

  // Learning page dialog: "chapter · type · node" tags (node absent for node-less work).
  function dialogContext(body) {
    const [chapterTitle, typeLabel, nodeTitle] = [...body.querySelectorAll('.submit-context .ctx-tag')].map((n) => n.textContent.trim());
    return { chapterTitle: chapterTitle ?? null, typeLabel: typeLabel ?? null, nodeTitle: nodeTitle ?? null };
  }

  const SLOTS = {
    page: {
      anchor: () => (ROUTE.test(location.pathname) ? document.querySelector('.upload-section .submit-btn') : null),
      buttonClass: (anchor) => anchor.className.split(/\s+/).filter((c) => c && c !== 'submit-btn' && c !== 'ant-btn-primary'),
      images: () => [...document.querySelectorAll('.upload-section img.upload-preview')],
      refusal: () => null,
      async collect(imgs) {
        let images = await blobsFrom(imgs).catch(() => []);
        if (!images.length && recent[0]) images = [{ blob: recent[0], name: recent[0].name }];
        return { where: { assignmentId: ROUTE.exec(location.pathname)[1], ...currentNode() }, images };
      },
    },
    dialog: {
      anchor: () => (LEARNING.test(location.pathname) ? document.querySelector('.ant-modal .submit-confirm-body') : null),
      buttonClass: (anchor) => {
        const cancel = anchor.closest('.ant-modal')?.querySelector('.ant-modal-footer .ant-btn:not(.ant-btn-primary)');
        return cancel ? cancel.className.split(/\s+/).filter(Boolean) : ['ant-btn'];
      },
      images: () => [...document.querySelectorAll('.ant-modal .submit-confirm-body img.submit-confirm-preview')],
      refusal: (anchor) => (dialogContext(anchor).nodeTitle === FINAL_STEP_TITLE ? 'reasonFinalSubmission' : null),
      async collect(imgs, anchor) {
        return { where: { termId: LEARNING.exec(location.pathname)[1], dialog: dialogContext(anchor) }, images: await blobsFrom(imgs) };
      },
    },
  };

  const mounted = {}; // slot name -> { wrap, btn, note, busy, seen }

  function build(slot, anchor) {
    const wrap = el('div', { class: 'chamber-enqueue', style: 'margin-top:8px' });
    const cls = [...new Set([...SLOTS[slot].buttonClass(anchor), 'ant-btn-default'])];
    const btn = el('button', { type: 'button', class: cls.join(' ') });
    btn.append(el('span', {}, t('enqueueOnPage')));
    const note = el('div', { role: 'status', style: 'margin-top:8px;font-size:13px;line-height:1.5;min-height:20px;opacity:.85' });
    btn.addEventListener('click', () => enqueueFrom(slot));
    wrap.append(btn, note);
    return { wrap, btn, note, busy: false, seen: '' };
  }

  function showNote(m, text, isError) {
    m.note.textContent = text;
    m.note.style.color = isError ? '#c2410c' : '';
  }

  function syncSlot(slot) {
    const spec = SLOTS[slot];
    const anchor = spec.anchor();
    let m = mounted[slot];
    if (!anchor) {
      m?.wrap.remove();
      delete mounted[slot];
      return;
    }
    if (!m) m = mounted[slot] = build(slot, anchor);
    // The SPA may re-render; keep the button right after its anchor.
    if (anchor.nextElementSibling !== m.wrap) anchor.after(m.wrap);
    const imgs = spec.images();
    // A different set of images: the last note no longer applies.
    const seen = imgs.map((i) => i.src).join('|');
    if (seen !== m.seen && !m.busy) { m.seen = seen; showNote(m, '', false); }
    const refusal = spec.refusal(anchor);
    if (refusal && !m.busy) showNote(m, t(refusal), true);
    m.btn.disabled = m.busy || !!refusal || !imgs.length;
  }

  const toDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  async function enqueueFrom(slot) {
    const m = mounted[slot];
    const anchor = SLOTS[slot].anchor();
    if (!m || m.busy || !anchor) return;
    m.busy = true;
    m.btn.disabled = true;
    showNote(m, t('enqueueing'), false);
    try {
      const { where, images } = await SLOTS[slot].collect(SLOTS[slot].images(), anchor);
      if (!images.length) { showNote(m, t('errNoImage'), true); return; }
      const payload = [];
      for (const img of images) payload.push({ dataUrl: await toDataUrl(img.blob), name: img.name });
      const res = await send({ type: 'chamber:enqueue', where, images: payload });
      if (res?.ok) {
        const key = res.followUp ? 'enqueuedFollowUp' : res.chained ? 'enqueuedChained' : 'enqueuedOk';
        showNote(m, slot === 'dialog' ? `${t(key)} ${t('enqueuedCloseDialog')}` : t(key), false);
      } else {
        const key = res?.error === 'NO_TAB' || res?.error === 'SESSION_INVALID' ? 'sessionInvalid' : res?.error;
        showNote(m, key ? `${t(key)}${res.detail ? `: ${res.detail}` : ''}` : t('enqueueFailed'), true);
      }
    } catch (e) {
      showNote(m, `${t('enqueueFailed')}: ${e?.message || e}`, true);
    } finally {
      m.busy = false;
    }
  }

  // ---- SPA navigation (history API is not observable from the isolated world) ----
  let lastPath = null;
  function check() {
    syncToken();
    syncTheme();
    for (const slot of Object.keys(SLOTS)) syncSlot(slot);
    if (location.pathname === lastPath) return;
    for (const m of Object.values(mounted)) showNote(m, '', false);
    lastPath = location.pathname;
    restoreSiteLogin();
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
