import { t, initI18n, applyI18n, send, el, icon, itemTag, queueText, reasonText, renderPips, onChanged, openSite, why } from './common.js';
import * as store from '../src/storage/idb.js';
import { KEYS, getSettings } from '../src/storage/settings.js';

const $ = (id) => document.getElementById(id);
const NEXT_SHOWN = 3;

async function render() {
  const [settings, backlog, local] = await Promise.all([
    getSettings(),
    store.listBacklog(),
    chrome.storage.local.get([KEYS.snapshot]),
  ]);
  const snap = local[KEYS.snapshot] || null;

  // ---- slot meter ----
  const limit = snap?.limit ?? null;
  const used = snap?.pending?.length ?? 0;
  renderPips($('pips'), used, limit);
  $('slotsText').textContent = limit == null ? t('slotsUnknown') : t('slotsFree', [String(Math.max(0, limit - used)), String(limit)]);
  $('meterSub').textContent = [snap?.courseName, why(snap?.why)].filter(Boolean).join(' · ');

  const mode = settings.paused ? 'modePaused' : settings.dryRun ? 'modeDryRun' : !settings.autoSubmit ? 'modeManual' : null;
  $('mode').hidden = !mode;
  if (mode) $('mode').textContent = t(mode);

  // ---- banner ----
  const needsLogin = snap?.error === 'NO_TAB' || settings.sessionInvalid;
  $('banner').hidden = !needsLogin;
  if (needsLogin) $('bannerText').textContent = t(settings.sessionInvalid ? 'sessionInvalid' : 'noTab');

  // ---- needs attention ----
  const attention = backlog.filter((i) => ['needs_revision', 'blocked', 'failed'].includes(i.status));
  $('revisionZone').hidden = attention.length === 0;
  $('revisionList').replaceChildren(...attention.map((i) => el('li', { class: 'row' },
    el('div', { class: 'main' },
      el('div', { class: 'title', text: i.title }),
      el('div', { class: 'sub accent' }, itemTag(i.status), i.status !== 'needs_revision' ? reasonText(i.reason, i.reasonDetail) : null),
      i.teacherFeedback ? el('div', { class: 'feedback', text: i.teacherFeedback }) : null),
  )));

  // ---- now submitting ----
  const now = backlog.filter((i) => i.status === 'uploading' || i.status === 'submitting');
  $('nowZone').hidden = now.length === 0;
  $('nowList').replaceChildren(...now.map((i) => el('li', { class: 'row' },
    el('div', { class: 'main' }, el('div', { class: 'title', text: i.title }), el('div', { class: 'sub' }, itemTag(i.status))))));

  // ---- in review (server truth, includes rounds submitted outside the extension) ----
  const pend = snap?.pending || [];
  $('reviewZone').hidden = pend.length === 0;
  $('reviewList').replaceChildren(...pend.map((p) => el('li', { class: 'row' },
    el('div', { class: 'main' },
      el('div', { class: 'title', text: p.label }),
      el('div', { class: 'sub' },
        el('span', { class: 'tag', 'data-tone': 'strong', text: t(p.status === 'REVIEWING' ? 'nsReviewing' : 'nsSubmitted') }),
        queueText(p.queuePosition, p.estimatedWaitMinutes))))));

  // ---- next up ----
  const rank = new Map((snap?.order || []).map((id, i) => [id, i]));
  const queued = backlog.filter((i) => i.status === 'queued')
    .sort((x, y) => (rank.get(x.id) ?? Infinity) - (rank.get(y.id) ?? Infinity));
  $('nextZone').hidden = queued.length === 0;
  $('nextList').replaceChildren(...queued.slice(0, NEXT_SHOWN).map((i) => el('li', { class: 'row' },
    el('div', { class: 'main' },
      el('div', { class: 'title', text: i.title }),
      snap?.notes?.[i.id] ? el('div', { class: 'sub', text: t(snap.notes[i.id]) }) : null),
    el('button', {
      class: 'icon', type: 'button', title: t('remove'), 'aria-label': t('removeItem', [i.title]),
      onclick: async () => { await store.removeItem(i.id); await send('chamber:itemsChanged'); },
    }, icon('x')),
  )));
  const more = queued.length - NEXT_SHOWN;
  $('nextMore').hidden = more <= 0;
  $('nextMore').textContent = more > 0 ? t('nMore', [String(more)]) : '';

  const nothing = backlog.length === 0 && pend.length === 0;
  $('emptyZone').hidden = !nothing;
  $('openBtn').textContent = t(nothing ? 'addImage' : 'openQueue');

  $('pauseBtn').textContent = t(settings.paused ? 'resumeAll' : 'pauseAll');
  $('pauseBtn').classList.toggle('danger', settings.paused);
  $('pauseBtn').onclick = () => send('chamber:settings', { patch: { paused: !settings.paused } });
}

await initI18n();
applyI18n();
$('openBtn').addEventListener('click', () => { send('chamber:openQueue'); window.close(); });
$('bannerAction').addEventListener('click', openSite);
onChanged(render);
render();
// Kick a tick so the meter is fresh when the popup opens (read-only unless the scheduler decides).
send('chamber:tick').catch(() => {});
