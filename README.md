# Chamber

A small background app for [tenten.art](https://tenten.art). You queue finished drawings, and it submits them one at a time whenever one of the platform's review slots (`maxPendingSubmissions`, currently 2) frees up. It runs on its own (Node, no browser needed), so you can close the browser while a batch waits. An optional Chrome extension adds queue buttons to the site.

The queue page is in English, with Chinese available as an optional language (Queue page → Controls → Language). Anything the extension adds to tenten.art itself is in Chinese, since the site is Chinese-only.

## Install

You need [Node.js](https://nodejs.org) 24 or later. Nothing else is installed (`npm install` is not needed).

1. **Start the app.** In this folder, run `npm run autostart:on`. This registers a Windows scheduled task that starts Chamber in the background every time you log on (no window; it restarts itself after a crash) and starts it now. `npm run autostart:off` removes it. To run it in a terminal instead, use `npm start`.
2. **Open the queue page** at http://127.0.0.1:47815/ in any browser. Closing the page or the browser does not stop anything; **Quit Chamber** under Controls does (until you start it again or log on next time).
3. **Log in.** Turn on **Automatic login** on the queue page (see below), or log in to tenten.art in Chrome with the extension installed, which hands the session over to the app.
4. **Optional: the extension**, for the queue buttons on the site. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension/` folder. Then open the queue page once in that Chrome, which connects the two. The toolbar icon opens the queue page; its badge shows the app's state, or a grey **off** when the app is not running.

Data (queue, images, settings, activity log) is kept in `%LOCALAPPDATA%\Chamber\chamber.sqlite`; the app's log is `app.log` next to it. `CHAMBER_HOME` and `CHAMBER_PORT` override the folder and the port (47815; the extension only knows the default).

The computer must be awake for anything to be submitted. After it wakes up, the app checks right away.

**Coming from the extension-only version (0.1).** Updating the extension deletes its old queue, images, settings and saved password from Chrome; nothing is carried over. Switch while no item is *Uploading* or *Submitting*, then queue what is still waiting again in the app and enter your password there. Rounds already submitted show up under *In review*.

After pulling new code, restart the app (Quit, then `npm start` or log off and on), reload the extension in `chrome://extensions`, and refresh any open tenten.art tab.

### Staying logged in

The site's login token is valid for exactly 24 hours and the site has no way to refresh it. Two options:

- **Automatic login (recommended).** Queue page → **Automatic login**: tick it, enter your phone or email and password, **Save**. The app then logs in with the site's password login (it has no captcha) whenever the session is about to run out, and the extension restores the site's own login with it when you open the site. If the site refuses the password, it stops and notifies you instead of retrying, so a wrong password cannot get the account locked; network errors are retried at most every 10 minutes. The password is **encrypted for your Windows account (DPAPI)** and stored only on this computer; it is never logged, never shown to any page, and sent only to `tenten.art/api/auth/password/login`. If it cannot be encrypted it is not saved. **Forget account** removes it.
- **Reminders.** Without automatic login the app uses the session the extension hands over when you log in on the site. A Windows notification comes about an hour before it expires, and a persistent one once it has; queued drawings wait meanwhile and the app resumes on its own after you log in again.

## Use

- **On the site** (extension). Put your images in the site's own upload box as usual, then click **加入 Chamber 队列** instead of submitting. On an assignment page the button sits below **提交作业** (one image, like the site there); on the course learning page it appears inside the **确认提交作业** dialog and queues all of the dialog's images (up to 3) for the node the dialog names. The site's own buttons still submit immediately. If you queue a node and then also submit it directly on the site, the queued item stops and tells you instead of submitting a second time. If the app is not running (or the extension is not connected yet), the button says so and queues nothing.
- **Queue page.** Drop, paste or pick 1–3 images (PNG, JPG, WebP or GIF, 10 MB each; they go out together as one submission, in the order shown), choose the target node, and click **Add to queue**. Filter the node list with the **Status** chips (Can queue, Queued, In review, Returned, Approved, Unavailable; each shows its count) and **Type** chips (basic, advanced, graduation, …), on top of the search box. By default Approved and Unavailable are off; the choice is remembered, and **Reset filters** restores it. Other nodes that cannot be submitted are greyed out; hover for the reason. A locked node can be queued if the node before it is already queued or under review; it waits until that node is approved.
- **Queue page sections.** *Backlog* holds what has not been sent yet, or came back and needs you. *In review* lists everything waiting for a TA on the platform (also rounds submitted on the site); rounds the extension sent show their images and how many follow-ups are queued behind them. *Finished* (approved, followed up, not sent) is collapsed at the bottom.
- **Withdrawing.** A round still *Submitted* (no TA has opened it) shows **撤回 / Withdraw** and **Withdraw and replace images** under *In review*, also for rounds submitted on the site. After a confirmation that shows the queue position you lose, the round is deleted from the platform; with a replacement, the new images are queued in its place, ahead of follow-ups on that node. The site has no way to swap images in place, so a resubmission always goes to the back of the review queue. A round withdrawn on the site is picked up too (the item shows **Withdrawn**). See `docs/requirements.md` (R6).
- **Submission order.** When a slot frees up, the next item is picked by: earliest deadline → revisions (a returned node blocks every later node) → required before optional → your own order. The queue page lists items in that order and tags them **Due MM-DD**, **Revision**, **Optional**. Drag (or Alt+↑/↓) to reorder within the same priority; Delete removes.
- **Updating a queued drawing.** Queued items have **Replace images** on the queue page. Locked nodes queued behind an earlier node go out automatically once that node is approved, so if a returned earlier node means a later drawing needs changes, replace it before then.
- **Review hours.** TAs only review at certain times (measured from the review history: 10:00–15:00 and 18:00–23:00 Beijing time, every day). Outside them no slot can free up, so the regular check pauses, continuing 30 minutes past each window so a slot freed by the last review is still filled at once. Anything you do (adding an image, clicking the toolbar icon, Run one check now, visiting the site) still checks immediately, and so does waking the computer from sleep, since the review queue is ordered by submission time. Edit the hours or turn this off under Controls; your local times are shown next to them.
- **Revisions.** When a submission comes back as reviewed / returned / shelved, its item turns into **Revision** with the teacher's feedback and review images. The returned images are never sent again. Queue your revised drawing like any other (on the site or the queue page); once it is sent, the returned item shows **Returned, followed up** and keeps the feedback.
- **Follow-ups (nodes reviewed in several rounds).** A node that is in review, or already has items in the queue, still accepts new items, tagged **Follow-up**. Each goes out after the one before it, once the node comes back returned. If the node is approved first (the TA approved directly, or you stop there), the remaining follow-ups become **Not sent** and nothing waits on them; later nodes carry on. Write the "more to come" note on the drawing itself, as the site has no note field. See `docs/requirements.md` (R2).
- **完整作业.** When every node of an assignment is approved and its 完整作业 has not been submitted, the queue page lists it as a reminder. Submit it on the site; it takes no review slot and the extension never submits it.
- **Open on the site.** Node names on the queue page (queue, In review, 完整作业) are links: they open that node on tenten.art in a new tab and select it there.
- **Notifications.** Approved, returned for revision, follow-up not sent, and login reminders are Windows notifications; clicking one opens the queue page.
- **Toolbar icon** (extension). Opens the queue page (or switches to it if already open) and runs a check. Its badge shows slots in use (e.g. **1/2**), the number of items needing attention, **||** when paused, a red **!** when the login has run out, or **off** when the app is not running.
- **Floating badge** (extension) in the bottom-right of the assignment page: hover it and click to open the queue page for that assignment. × hides it for the tab.

### First run

The app starts with **Dry run on and Auto-submit off**: it only writes what it would submit to the activity log. Once that looks right:

1. untick **Dry run**;
2. click **Run one check now** to submit the first queued item, and check the platform's submission history shows exactly one new round;
3. then tick **Auto-submit**.

## Never submitting twice

A duplicate submission burns a round on the platform and cannot be undone, so:

- Only one item is in flight at a time. Only one app runs (it holds the port), and within it each check takes a lock, so two checks never overlap.
- Killing the app, a crash or a power cut at any point is safe: every change to the queue is one database transaction, and an item left in *Uploading* or *Submitting* is settled from platform data on the next start, as below.
- **After the upload and right before the submit request**, the extension re-reads the platform and checks again: a slot is free, the node has no pending round, and the node's round count has not changed.
- If the submit request times out or the network drops, the item stays in **Submitting** and is not retried. The next check decides from the platform's data: if a new round appeared on the node (matched by file name, or simply because the count went up) it counts as submitted; only if there is none does the item go back to the queue, reusing the uploaded file.
- A round submitted for the node outside the extension after the item was queued stops the item (**Blocked**) until you decide.
- An explicit rejection from the platform marks the item **Blocked** with the platform's message and waits for you to press **Retry**.
- Withdrawing (`DELETE`) happens only when you confirm it for one specific round, never automatically and never retried. Right before the request, holding the same lock as the checks, the extension re-reads the platform and goes ahead only if that exact round is still the node's latest and still *Submitted*; afterwards it confirms the round is gone. Dry run never withdraws.

## Fix included: times on the site

The platform's API sends Beijing time without a timezone (e.g. `2026-10-27T12:45:44`), and the site parses it with `new Date()`, i.e. in your computer's timezone. Outside UTC+8 every relative time is off by hours and new messages show 刚刚 ("just now") forever.

The extension injects `extension/src/content/tz-fix.js` before the site's scripts load and treats such date-time strings as +08:00. Strings with an explicit offset and date-only strings are untouched, and it does nothing if your computer is already on UTC+8.

## Platform notes

Verified against the live API and the site's front-end bundle. Keep this table up to date.

| Topic | Behaviour |
|---|---|
| Auth | `localStorage["tenten-auth"].token`, sent as `Authorization: Bearer <token>` |
| Session | The token is an HS512 JWT with a fixed 24 h lifetime (`exp`). There is no refresh endpoint; on 401 the site just logs out |
| Login | `POST /api/auth/password/login` `{ account, password }` → session object (`token`, `userId`, `displayName`, `roles`, …), stored by the site as `localStorage["tenten-auth"]`. No captcha on this endpoint (the slider captcha only guards sending SMS / email codes) |
| CORS | Any request with `Origin: chrome-extension://…` gets `403 Invalid CORS request`. The app's requests carry no Origin, and the extension never calls the platform API, so nothing needs working around |
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
app/                  the background app (Node 24, no dependencies)
  main.mjs            entry point: takes the port, opens the data, starts checks
  service.mjs         supervisor used by autostart: logs to app.log, restarts after a crash
  paths.mjs           data folder and port
  src/
    target.js         site origin, auth key, status constants
    adapter.js        API client (envelope, error type, upload retry)
    model.js          pure helpers over the assignment tree
    images.js         image rules (types, size, count)
    picker.js         node picker states and filter defaults
    thumbs.js         small thumbnails, made by the page; pages never draw original images (they can be ~100 MP)
    scheduler.js      pure: what to do this check, priority order, queue eligibility
    reconcile.js      pure: correct the local queue from platform data
    engine.js         one full check, all side effects injected
    withdraw.js       a confirmed withdrawal (the only DELETE), same injected deps
    db.js, store.js   SQLite: queue items and images
    kv.js             settings, session, activity log, check lock
    tokens.js, session.js, auto-login.js   the site session and automatic login
    app.js            wiring: check loop, notifications, API handlers
    server.js         local HTTP server: queue page and API (Host + key checks)
    windows.js        DPAPI and toast notifications through Windows PowerShell
    i18n.js           language selection on top of _locales
  ui/                 queue page
  _locales/, icons/
extension/            optional Chrome extension (load unpacked); never calls the platform
  src/background.js   relays the site page to the app, toolbar badge
  src/content/        on tenten.art: queue buttons, badge, session hand-over, timezone fix; pair.js on the queue page
test/                 node:test unit tests, incl. a fake platform for crashes, timeouts, 429, rejections
tools/                generators for strings and icons, autostart
docs/requirements.md  feature requirements beyond this README (several images, follow-ups, 完整作业, the app)
```

## Development

No dependencies; Node 24:

```
npm test           # run the tests
npm run locales    # regenerate _locales after editing tools/locales.src.mjs
npm run icons      # regenerate the icons
```

All UI strings live in `tools/locales.src.mjs`; nothing is hard-coded in components. `test/i18n.test.mjs` checks every key used in code exists in both languages.

For debugging, the queue page's **Activity log** shows the last entries, `app.log` in the data folder has the app's output, and `GET /api/probe` (with the page's `X-Chamber-Key`) summarises the current term.
