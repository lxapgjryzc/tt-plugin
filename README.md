# Chamber

A Chrome extension (Manifest V3) for [tenten.art](https://tenten.art). You queue finished drawings, and it submits them one at a time whenever one of the platform's review slots (`maxPendingSubmissions`, currently 2) frees up.

The extension UI is in English, with Chinese available as an optional language (Queue page → Controls → Language). Anything it adds to tenten.art itself is in Chinese, since the site is Chinese-only.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder of this repo.
3. Open https://tenten.art and log in once. The extension picks up the session from the page and keeps it, so it keeps working after you close the tab and after a browser restart. You only need to visit the site again if the session expires or you log out (the popup will say so).
4. Click the toolbar icon → **Open queue**.

After pulling new code, click the reload button on the extension's card in `chrome://extensions`, then refresh any open tenten.art tab.

## Use

- **On the site's assignment page.** Paste, drop or pick your image in the site's own upload box as usual, then click **加入 Chamber 队列** below the site's **提交作业** button. The image is queued for the node you are viewing and is submitted when a slot frees up. **提交作业** still submits immediately. If you queue a node and then also submit it directly on the site, the queued item stops and tells you instead of submitting a second time.
- **Queue page.** Drop, paste or pick an image, choose the target node, and click **Add to queue**. Nodes that cannot be submitted are greyed out; hover for the reason. A locked node can be queued if the node before it is already queued or under review; it waits until that node is approved.
- **Submission order.** When a slot frees up, the next item is picked by: earliest deadline → revisions (a returned node blocks every later node) → required before optional → your own order. The queue page lists items in that order and tags them **Due MM-DD**, **Revision**, **Optional**. Drag (or Alt+↑/↓) to reorder within the same priority; Delete removes.
- **Revisions.** When a submission comes back as reviewed / returned / shelved, its item turns into **Revision** with the teacher's feedback and review images. The returned image is never sent again. Queue your revised drawing like any other (on the site or the queue page) and it replaces that item.
- **Popup.** Slot meter (one dot per slot, filled = in use), what is being submitted, what is in review with the platform's queue position and estimate, what needs attention, what is next, and **Pause all**.
- **Floating badge** in the bottom-right of the assignment page: hover it and click to open the queue page for that assignment. × hides it for the tab.

### First run

The extension starts with **Dry run on and Auto-submit off**: it only writes what it would submit to the activity log. Once that looks right:

1. untick **Dry run**;
2. click **Run one check now** to submit the first queued item, and check the platform's submission history shows exactly one new round;
3. then tick **Auto-submit**.

## Never submitting twice

A duplicate submission burns a round on the platform and cannot be undone, so:

- Only one item is in flight at a time. Each check takes a lock in `chrome.storage.session`, so an evicted service worker cannot run two checks at once.
- **After the upload and right before the submit request**, the extension re-reads the platform and checks again: a slot is free, the node has no pending round, and the node's round count has not changed.
- If the submit request times out or the network drops, the item stays in **Submitting** and is not retried. The next check decides from the platform's data: if a new round appeared on the node (matched by file name, or simply because the count went up) it counts as submitted; only if there is none does the item go back to the queue, reusing the uploaded file.
- A round submitted for the node outside the extension after the item was queued stops the item (**Blocked**) until you decide.
- An explicit rejection from the platform marks the item **Blocked** with the platform's message and waits for you to press **Retry**.
- There is no code that withdraws (DELETEs) a submission.

## Fix included: times on the site

The platform's API sends Beijing time without a timezone (e.g. `2026-10-27T12:45:44`), and the site parses it with `new Date()`, i.e. in your computer's timezone. Outside UTC+8 every relative time is off by hours and new messages show 刚刚 ("just now") forever.

The extension injects `src/content/tz-fix.js` before the site's scripts load and treats such date-time strings as +08:00. Strings with an explicit offset and date-only strings are untouched, and it does nothing if your computer is already on UTC+8.

## Platform notes

Verified against the live API and the site's front-end bundle. Keep this table up to date.

| Topic | Behaviour |
|---|---|
| Auth | `localStorage["tenten-auth"].token`, sent as `Authorization: Bearer <token>` |
| CORS | Any request with `Origin: chrome-extension://…` gets `403 Invalid CORS request`. Chrome omits Origin on the worker's GETs but sends it on POST/PUT, so a declarativeNetRequest session rule strips Origin from the worker's requests (pages are unaffected) |
| Main data | `GET /api/student/courses/terms/{termId}/weeks` returns the whole assignment tree and `maxPendingSubmissions` |
| Slot count | Submissions in `SUBMITTED` / `REVIEWING` take a slot. The site counts the last round per assignment; the extension counts the last round per node (can only over-count) |
| Upload | `POST /api/files/upload`, multipart `file` + `prefix=assignments/`. `data` is an object; its `objectName` is what goes into `fileUrl` |
| Submit | `POST .../submissions` when the node has no rounds yet, `PUT` when it has. Body `{ nodeId, fileUrl }` |
| File size | The site caps images at 10 MB |
| Closed | `status === "CLOSED"`, or past `deadline` (term end date 23:59:59 if there is none) |
| IDs | 19-digit strings, beyond JS safe integers; never convert to Number |
| Times | Naive Beijing time, see above |
| Grouping | All assignments sit under a single lesson in week 0, so the picker groups by assignment |
| Assignment page | Current node: `.node-steps .node-step-title.active`; upload box `.upload-zone`; chosen image `img.upload-preview` (blob URL of the original file); submit button `.upload-section .submit-btn` |

## Layout

```
extension/            the folder Chrome loads (runtime files only)
  manifest.json
  _locales/           UI strings (en, zh_CN), generated from tools/locales.src.mjs
  src/
    target.js         site origin, auth key, status constants
    adapter.js        API client (envelope, error type, upload retry)
    model.js          pure helpers over the assignment tree
    scheduler.js      pure: what to do this check, priority order, queue eligibility
    reconcile.js      pure: correct the local queue from platform data
    engine.js         one full check, all side effects injected (testable in Node)
    background.js     service worker: alarm, messages, badge, notifications
    i18n.js           language selection on top of _locales
    token-bridge.js   reads the session token from the page
    storage/          IndexedDB (queue + images), chrome.storage (settings, lock, log)
    content/          scripts injected into tenten.art: badge + queue button, timezone fix
  ui/                 popup and queue page
test/                 node:test unit tests, incl. a fake platform for eviction, timeouts, 429, rejections
tools/                generators for strings and icons
```

## Development

No dependencies; Node 24:

```
npm test           # run the tests
npm run locales    # regenerate _locales after editing tools/locales.src.mjs
npm run icons      # regenerate the icons
```

All UI strings live in `tools/locales.src.mjs`; nothing is hard-coded in components. `test/i18n.test.mjs` checks every key used in code exists in both languages.

For debugging, open the service worker console from `chrome://extensions`: `self.chamber.probe()` summarises the current term, `self.chamber.tick()` runs one check, `self.chamber.getAudit()` shows the activity log.
