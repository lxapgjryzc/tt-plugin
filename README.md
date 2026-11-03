# Chamber

A Chrome extension (Manifest V3) for [tenten.art](https://tenten.art). You queue finished drawings, and it submits them one at a time whenever one of the platform's review slots (`maxPendingSubmissions`, currently 2) frees up.

The extension UI is in English, with Chinese available as an optional language (Queue page → Controls → Language). Anything it adds to tenten.art itself is in Chinese, since the site is Chinese-only.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder of this repo.
3. Open https://tenten.art and log in. The extension picks up the session from the page and keeps it, so it keeps working after you close the tab and after a browser restart.

### Staying logged in

The site's login token is valid for exactly 24 hours and the site has no way to refresh it. Two options:

- **Reminders (default).** A notification about an hour before the login expires, and a persistent one (plus a red **!** on the toolbar icon) once it has. Click it to open the site and log in; queued drawings wait meanwhile and the extension resumes on its own.
- **Automatic login (opt-in).** Queue page → **Automatic login**: tick it, enter your phone or email and password, **Save**. The extension then logs in with the site's password login (it has no captcha) whenever the session is about to run out, and also restores the site's own login when you open it. If the site refuses the password, it stops and notifies you instead of retrying, so a wrong password cannot get the account locked; network errors are retried at most every 10 minutes. **The password is stored unencrypted** in this Chrome profile (`chrome.storage.local`), readable only by this extension, never logged, never exposed to the site page, and sent only to `tenten.art/api/auth/password/login`. **Forget account** removes it.
4. Click the toolbar icon to open the queue page.

After pulling new code, click the reload button on the extension's card in `chrome://extensions`, then refresh any open tenten.art tab.

## Use

- **On the site.** Put your images in the site's own upload box as usual, then click **加入 Chamber 队列** instead of submitting. On an assignment page the button sits below **提交作业** (one image, like the site there); on the course learning page it appears inside the **确认提交作业** dialog and queues all of the dialog's images (up to 3) for the node the dialog names. The site's own buttons still submit immediately. If you queue a node and then also submit it directly on the site, the queued item stops and tells you instead of submitting a second time.
- **Queue page.** Drop, paste or pick 1–3 images (PNG, JPG, WebP or GIF, 10 MB each; they go out together as one submission, in the order shown), choose the target node, and click **Add to queue**. Filter the node list with the **Status** chips (Can queue, Queued, In review, Returned, Approved, Unavailable; each shows its count) and **Type** chips (basic, advanced, graduation, …), on top of the search box. By default Approved and Unavailable are off; the choice is remembered, and **Reset filters** restores it. Other nodes that cannot be submitted are greyed out; hover for the reason. A locked node can be queued if the node before it is already queued or under review; it waits until that node is approved.
- **Queue page sections.** *Backlog* holds what has not been sent yet, or came back and needs you. *In review* lists everything waiting for a TA on the platform (also rounds submitted on the site); rounds the extension sent show their images and how many follow-ups are queued behind them. *Finished* (approved, followed up, not sent) is collapsed at the bottom.
- **Withdrawing.** A round still *Submitted* (no TA has opened it) shows **撤回 / Withdraw** and **Withdraw and replace images** under *In review*, also for rounds submitted on the site. After a confirmation that shows the queue position you lose, the round is deleted from the platform; with a replacement, the new images are queued in its place, ahead of follow-ups on that node. The site has no way to swap images in place, so a resubmission always goes to the back of the review queue. A round withdrawn on the site is picked up too (the item shows **Withdrawn**). See `docs/requirements.md` (R6).
- **Submission order.** When a slot frees up, the next item is picked by: earliest deadline → revisions (a returned node blocks every later node) → required before optional → your own order. The queue page lists items in that order and tags them **Due MM-DD**, **Revision**, **Optional**. Drag (or Alt+↑/↓) to reorder within the same priority; Delete removes.
- **Updating a queued drawing.** Queued items have **Replace images** on the queue page. Locked nodes queued behind an earlier node go out automatically once that node is approved, so if a returned earlier node means a later drawing needs changes, replace it before then.
- **Review hours.** TAs only review at certain times (measured from the review history: 10:00–15:00 and 18:00–23:00 Beijing time, every day). Outside them no slot can free up, so the regular check pauses, continuing 30 minutes past each window so a slot freed by the last review is still filled at once. Anything you do (adding an image, clicking the toolbar icon, Run one check now, visiting the site) still checks immediately, since the review queue is ordered by submission time. Edit the hours or turn this off under Controls; your local times are shown next to them.
- **Revisions.** When a submission comes back as reviewed / returned / shelved, its item turns into **Revision** with the teacher's feedback and review images. The returned images are never sent again. Queue your revised drawing like any other (on the site or the queue page); once it is sent, the returned item shows **Returned, followed up** and keeps the feedback.
- **Follow-ups (nodes reviewed in several rounds).** A node that is in review, or already has items in the queue, still accepts new items, tagged **Follow-up**. Each goes out after the one before it, once the node comes back returned. If the node is approved first (the TA approved directly, or you stop there), the remaining follow-ups become **Not sent** and nothing waits on them; later nodes carry on. Write the "more to come" note on the drawing itself, as the site has no note field. See `docs/requirements.md` (R2).
- **完整作业.** When every node of an assignment is approved and its 完整作业 has not been submitted, the queue page lists it as a reminder. Submit it on the site; it takes no review slot and the extension never submits it.
- **Open on the site.** Node names on the queue page (queue, In review, 完整作业) are links: they open that node on tenten.art in a new tab and select it there.
- **Toolbar icon.** Opens the queue page (or switches to it if already open) and runs a check. Its badge shows slots in use (e.g. **1/2**), the number of items needing attention, **||** when paused, or a red **!** when the login has run out.
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
- Withdrawing (`DELETE`) happens only when you confirm it for one specific round, never automatically and never retried. Right before the request, holding the same lock as the checks, the extension re-reads the platform and goes ahead only if that exact round is still the node's latest and still *Submitted*; afterwards it confirms the round is gone. Dry run never withdraws.

## Fix included: times on the site

The platform's API sends Beijing time without a timezone (e.g. `2026-10-27T12:45:44`), and the site parses it with `new Date()`, i.e. in your computer's timezone. Outside UTC+8 every relative time is off by hours and new messages show 刚刚 ("just now") forever.

The extension injects `src/content/tz-fix.js` before the site's scripts load and treats such date-time strings as +08:00. Strings with an explicit offset and date-only strings are untouched, and it does nothing if your computer is already on UTC+8.

## Platform notes

Verified against the live API and the site's front-end bundle. Keep this table up to date.

| Topic | Behaviour |
|---|---|
| Auth | `localStorage["tenten-auth"].token`, sent as `Authorization: Bearer <token>` |
| Session | The token is an HS512 JWT with a fixed 24 h lifetime (`exp`). There is no refresh endpoint; on 401 the site just logs out |
| Login | `POST /api/auth/password/login` `{ account, password }` → session object (`token`, `userId`, `displayName`, `roles`, …), stored by the site as `localStorage["tenten-auth"]`. No captcha on this endpoint (the slider captcha only guards sending SMS / email codes) |
| CORS | Any request with `Origin: chrome-extension://…` gets `403 Invalid CORS request`. Chrome omits Origin on the worker's GETs but sends it on POST/PUT, so a declarativeNetRequest session rule strips Origin from the worker's requests (pages are unaffected) |
| Main data | `GET /api/student/courses/terms/{termId}/weeks` returns the whole assignment tree and `maxPendingSubmissions` |
| Slot count | Submissions in `SUBMITTED` / `REVIEWING` take a slot. The site counts the last round per assignment; the extension counts the last round per node (can only over-count) |
| Upload | `POST /api/files/upload`, multipart `file` + `prefix=assignments/`. `data` is an object; its `objectName` is what goes into `fileUrl` |
| Submit | `POST .../submissions` when the node has no rounds yet, `PUT` when it has. Body `{ nodeId, fileUrl }` |
| Several images | The learning page sends up to 3 images as one round: each is uploaded, and the object names are joined with `,` into `fileUrl`. Rounds list them in `fileUrls` / `fileObjectNames`; `fileObjectName` / `fileUrl` hold the first image only (verified 2026-11-03, two images on a graduation node). The assignment page sends one image |
| Images | PNG, JPEG, WebP, GIF (assignment page: no GIF), at most 10 MB each |
| Notes | The submit body has no note field; students write notes on the drawing |
| Catalog | `GET /api/student/courses/terms/{termId}/catalog`: the same assignments grouped into chapters (`groupTitle`), as on the learning page. Its submit dialog only shows chapter · type label · node title, so the extension resolves the node through this |
| 完整作业 | After every node is approved (not for graduation projects): `POST`/`PUT`/`DELETE /student/assignments/{id}/final-submission` `{ fileUrl }`, shown as `finalSubmission` on the assignment. Takes no review slot. The extension only reminds |
| Review queue | Pending rounds carry `queuePosition` and `estimatedWaitMinutes` |
| Withdraw | `DELETE /student/assignments/{id}/submissions?nodeId=…` deletes the node's latest round; the site offers it only while that round is `SUBMITTED`. The node falls back to its previous round's status. No call replaces a round's images |
| Closed | `status === "CLOSED"`, or past `deadline` (term end date 23:59:59 if there is none) |
| IDs | 19-digit strings, beyond JS safe integers; never convert to Number |
| Times | Naive Beijing time, see above |
| Grouping | All assignments sit under a single lesson in week 0, so the picker groups by assignment |
| Assignment page | `/student/assignment/{id}`. Current node: `.node-steps .node-step-title.active`; upload box `.upload-zone`; chosen image `img.upload-preview` (blob URL of the original file); submit button `.upload-section .submit-btn` |
| Links | `/student/assignment/{id}` has no node parameter; the shown node is page state, set by clicking a `.node-step` (locked ones too). `/student/learning/{termId}?assignmentId=…` opens the learning page on that assignment |
| Learning page | `/student/learning/{termId}`. Submit dialog: `.ant-modal .submit-confirm-body`, context tags `.submit-context .ctx-tag` (chapter, type label, node title), images `img.submit-confirm-preview` (blob URLs, in order) |

## Layout

```
extension/            the folder Chrome loads (runtime files only)
  manifest.json
  _locales/           UI strings (en, zh_CN), generated from tools/locales.src.mjs
  src/
    target.js         site origin, auth key, status constants
    adapter.js        API client (envelope, error type, upload retry)
    model.js          pure helpers over the assignment tree
    images.js         image rules (types, size, count)
    picker.js         node picker states and filter defaults
    scheduler.js      pure: what to do this check, priority order, queue eligibility
    reconcile.js      pure: correct the local queue from platform data
    engine.js         one full check, all side effects injected (testable in Node)
    withdraw.js       a confirmed withdrawal (the only DELETE), same injected deps
    background.js     service worker: alarm, messages, badge, notifications
    i18n.js           language selection on top of _locales
    token-bridge.js   reads the session token from the page
    storage/          IndexedDB (queue + images), chrome.storage (settings, lock, log)
    content/          scripts injected into tenten.art: badge + queue button, timezone fix
  ui/                 queue page
test/                 node:test unit tests, incl. a fake platform for eviction, timeouts, 429, rejections
tools/                generators for strings and icons
docs/requirements.md  feature requirements beyond this README (several images, follow-ups, 完整作业)
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
