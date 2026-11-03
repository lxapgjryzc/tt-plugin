# Requirements

Feature requirements that go beyond what the README describes. Each section states what the
user sees, the rules the code must follow, and the edge cases tests must cover. Platform facts
are in the README's *Platform notes*; facts not yet verified against a real submission are
marked **unverified**.

---

## R1. Several images per submission

### Background

On the course learning page (`/student/learning/:termId`) the site lets a student submit up to
**3 images** in one round. Each image is uploaded separately (`POST /api/files/upload`); the
resulting `objectName`s are joined with `,` and sent as the single `fileUrl` of the normal
`POST`/`PUT .../submissions` call. Accepted types there: PNG, JPEG, WebP, GIF; each at most
10 MB. (The single-assignment page `/student/assignment/:id` only takes one PNG/JPEG/WebP.)
Rounds expose their files as `fileUrls` / `fileObjectNames` arrays.

### Requirements

- **R1.1** A queued item holds an ordered list of 1–3 images. The list is sent as one round,
  in that order.
- **R1.2** Every image is checked when it is added, with no network call: type one of PNG,
  JPEG, WebP, GIF; not empty; at most 10 MB. More than 3 images is refused with a message
  (extra images are not silently dropped).
- **R1.3** Upload is resumable: object names are stored on the item as each image finishes,
  so an interrupted or failed upload continues with the next image instead of uploading
  earlier ones again. Replacing the images discards stored object names.
- **R1.4** Recognising our own round on the server (duplicate guard, in-doubt resolution)
  matches **any** of the item's object names against the round's file keys. File keys that
  contain `,` are split. (Verified 2026-11-03: a multi-image round lists every image in
  `fileObjectNames` / `fileUrls`, and `fileObjectName` / `fileUrl` hold the first one.)
- **R1.5** Queue page: drop, paste or pick adds images to the pending set up to 3 (paste
  appends, like the site's dialog). The set is shown as thumbnails, each removable. *Replace
  images* on an item replaces the whole set (1–3 images).
- **R1.6** Queue rows show the first image with a count when there are more.
- **R1.7** On the site:
  - The single-assignment page keeps its one-image **加入 Chamber 队列** button.
  - The learning page's 确认提交作业 dialog gets a **加入 Chamber 队列** button below the image
    list. It queues all images in the dialog, in order, for the node the dialog names.
    The dialog shows only chapter title · type label · node title, so the extension resolves
    the node through `GET /student/courses/terms/{termId}/catalog` (chapter `groupTitle` →
    assignment whose label matches → node by title). If this is ambiguous or not found it
    refuses with a message and queues nothing. The 完整作业 dialog is refused (R3).
  - The site's own controls are not changed; after queuing, the dialog stays open with a note.
- **R1.8** Existing queued items (one image, one object name) keep working after the update
  (stored data is migrated).

---

## R2. Follow-up submissions on a node that is not approved yet

### Background

Some nodes hand out four or more references, and a TA reviews about two per round. The
student writes on the drawing that more is coming; the TA then **returns** the node instead
of approving it, and the student submits the next part. But:

- a TA sometimes approves directly, skipping the remaining parts;
- the student may decide not to do the rest and leave it approved.

There is no API field for a student note, and nothing in the data marks such a node (only
titles like 【6个】). So the extension does not try to detect them. Instead, **any node that is
submitted but not approved accepts further queued items**, and each goes out after the
previous round comes back returned.

### Requirements

- **R2.1 Queuing.** A node can be queued when its latest round is in review
  (SUBMITTED/REVIEWING) or came back (REVIEWED/RETURNED/SHELVED), and also when it already
  has items of ours (queued, in flight, in review). New items go after the existing ones. The
  picker and the site button say that such an item is a **follow-up**: it is sent once the
  current round is returned. Approved nodes still cannot be queued.
- **R2.2 Sending.** At most one item per node is in review at a time. A follow-up waits while
  the node's latest round is in review, and is sent (as `PUT`) once that round is
  returned, subject to slots and the usual priority (it ranks as a revision). Several
  follow-ups on one node go out one per review cycle, in queue order.
- **R2.3 Approved before all follow-ups were sent.** When the node becomes approved, every
  item of ours on it that was not sent yet becomes **Skipped** (*not sent: node approved*).
  Skipped is final: it is never sent, never blocks anything, does not count as needing
  attention, and is cleared with *Clear finished*. One notification per skipped item. Later
  nodes queued behind this node proceed as usual. This also applies to an item that was
  already uploading when the approval arrived (the final preflight sees the approval).
- **R2.4 Returned item followed by a follow-up.** A returned item keeps its feedback and
  review images. Once a later item of ours on the same node is submitted, the returned item
  becomes **Continued** (final, keeps feedback). While a follow-up for it is waiting, the
  returned item does not count as needing attention.
- **R2.5 Own rounds are not "submitted elsewhere".** The check that stops an item when a
  round was submitted for its node outside the extension ignores rounds made by our own
  items (recognised by uploaded object names, or a sibling still in doubt). The baseline
  moves past our own rounds; a round that is not ours still blocks the item.
- **R2.6 Behaviour kept.** Queuing on a node whose item is *blocked* or *failed* still
  replaces that item. A *returned* item is no longer replaced by a new queue entry: the new
  entry is a follow-up (R2.4), so the TA's feedback stays visible.
- **R2.7 Never stuck.** No combination of approve / return / site submission leaves an item
  waiting forever or blocks other items: queued items on approved nodes are skipped;
  follow-ups on returned nodes go out; foreign rounds block only the affected item.

### Scenarios that tests must cover

1. A pending, B queued on the same node → B waits; node returned → B sent once (PUT); A
   becomes Continued.
2. A pending, B and C queued → returned → B sent; returned again → C sent; approved → A and B
   Continued, C Approved, three writes in total.
3. A pending, B queued → TA approves → A done, B skipped, no write; a later locked node
   queued behind it is sent.
4. A pending, B queued → student submits on the site → B blocked (submitted elsewhere).
5. B queued while A is still queued (neither sent) → A sent, B not blocked by A's round,
   waits; returned → B sent.
6. Approval arrives while B is uploading → B skipped at preflight, no write.

---

## R3. 完整作业 (final submission) reminder

### Background

After every node of a non-graduation assignment is approved, the site shows an extra
完整作业 step (`/student/assignments/{id}/final-submission`, 1–3 images, can be updated or
withdrawn). It takes no review slot, so queuing it has no value.

### Requirements

- **R3.1** The queue page lists assignments where every node is approved, the assignment is
  not a graduation project, not closed, and `finalSubmission` is empty, under *完整作业 not
  submitted*, with a link to the site's learning page. Hidden when empty.
- **R3.2** The extension never submits, updates or withdraws final submissions.

---

## R4. Open the node on the site

### Background

The site's assignment page is `/student/assignment/{assignmentId}`; it has no URL
parameter for the node. Which node is shown is page state, set by clicking a step in
`.node-steps` (any step can be clicked, locked ones too). The learning page accepts
`/student/learning/{termId}?assignmentId=…` and opens on that assignment.

### Requirements

- **R4.1** Everywhere the queue page names a node (backlog rows, *In review* rows), the name
  is a link that opens that node on the site in a new tab.
- **R4.2** The link is `/student/assignment/{assignmentId}#chamber-node={nodeId}`. On such a
  page the content script waits for the step bar (up to 10 s), clicks the step whose title
  matches the node (falling back to its position), then removes the fragment from the
  address without adding a history entry. If the node cannot be found it does nothing; the
  page still shows the assignment.
- **R4.3** *完整作业 not submitted* rows link to the learning page opened on that assignment.
- **R4.4** Only the extension's own links carry the fragment; the site's navigation is
  never changed.

---

## R5. Queue page sections

### Background

Items stay in storage after they are sent: they follow the round to its result (feedback,
notifications), anchor follow-ups (R2) and the duplicate guard. Showing them in the backlog
made sent work look unsent, and listed it twice next to *In review*. This is display only;
stored items and scheduling do not change.

### Requirements

- **R5.1 Backlog** lists items not sent yet or needing the user: queued, uploading,
  submitting, blocked, failed, and returned (Revision). Reordering acts on this list.
- **R5.2 In review** lists every pending round on the platform (also those submitted on the
  site). A round sent by the extension shows the item's thumbnail and image count, how many
  follow-ups are queued behind it, and *Stop tracking* (never withdraws). Items of ours in
  review that the last check has not reported yet are listed too.
- **R5.3 Finished** (approved, followed up, not sent) is a collapsed section with its count
  and *Clear finished*; hidden when empty.

---

## R6. Withdrawing a submission

### Background

`DELETE /api/student/assignments/{assignmentId}/submissions?nodeId={nodeId}` deletes the
**latest round** of that node (no `nodeId` for node-less work). The site offers it only
while that round is SUBMITTED; once a TA starts (REVIEWING) it cannot be withdrawn. The
round disappears, the node falls back to its previous round's status, and the review slot
frees up. Submitting again creates a new round at the back of the review queue (the queue
is ordered by submission time), so a withdrawal always costs the queue position. There is
no way to replace a round's images in place.

A withdrawal deletes data on the platform, so it is the one write besides submitting, and
it must be at least as guarded as submitting.

### Requirements

- **R6.1 Where.** *In review* rows whose round is SUBMITTED offer **Withdraw** and
  **Withdraw and replace images**. This includes rounds submitted on the site. REVIEWING
  rounds show neither.
- **R6.2 Only on explicit confirmation.** Each action opens a confirmation that names the
  node and says: the round is deleted from the platform; its queue position (shown) is
  lost; for a plain withdraw, follow-ups queued behind it move up and may be sent next; for
  a replacement, the new images (shown) are queued ahead of those follow-ups. Replacement
  images are chosen and checked (R1.2) *before* the confirmation, so cancelling the file
  dialog never withdraws anything. Nothing else in the extension ever withdraws: no
  automatic path, no retry.
- **R6.3 Guarded write.** The app performs it while holding the tick lock (so no
  check can submit to the node meanwhile), re-reads the platform right before the request,
  and sends the `DELETE` only if the node's latest round is still exactly the confirmed one
  (same `submissionId`) and still SUBMITTED. Otherwise it refuses with the reason (review
  started / the round changed). After the request it re-reads and confirms the round is
  gone. Dry run refuses (it never writes to the platform). Every attempt and its outcome
  is in the activity log.
- **R6.4 Outcome.**
  - Plain withdraw: our item for that round becomes **Withdrawn** (finished, R5.3).
  - Replace: our item for that round goes back to *queued* with the new images and keeps
    its place in the order, so it goes before follow-ups on the node. If the round was not
    ours, a new item is queued ahead of any follow-ups on the node.
  - The check runs right away, so the freed slot is used.
- **R6.5 In doubt.** If the `DELETE` response is lost, nothing is assumed: the user is told
  to check, replacement images are discarded, and the next check settles the item from the
  platform (R6.6).
- **R6.6 Withdrawn elsewhere.** A sent item whose round no longer exists (withdrawn on the
  site, or an in-doubt withdrawal that landed) becomes **Withdrawn** instead of waiting
  forever.
- **R6.7 Baseline after a withdrawal.** When rounds disappear, queued items on the node
  lower their submitted-elsewhere baseline (R2.5) to the current round count, so a later
  round from outside the extension is still noticed.

### Scenarios that tests must cover

1. Withdraw our SUBMITTED round → one `DELETE`; item Withdrawn; slot freed; a follow-up on
   the node is sent next.
2. Withdraw and replace → item queued with the new images and sent before the follow-up.
3. Round is REVIEWING, or a different round is latest → refused, no `DELETE`.
4. Dry run → refused, no `DELETE`.
5. `DELETE` lost in transit but applied → item Withdrawn on the next check; not applied →
   item stays in review.
6. Round withdrawn on the site → item Withdrawn; follow-up baseline lowered; a later round
   submitted on the site still blocks the follow-up.

---

## R7. Node picker filters

### Background

The node picker on the queue page had one switch, *Show all*: off hid approved nodes and
assignments where nothing could be queued; on showed everything. With follow-ups (R2) and
returned nodes, more node states matter, and finding e.g. "everything returned" or "only
graduation work" took scrolling.

### Requirements

- **R7.1 Status filter.** Every node falls into exactly one state, checked in this order:
  1. *Approved*: latest round approved.
  2. *In review*: latest round SUBMITTED or REVIEWING (can take a follow-up).
  3. *Returned*: latest round REVIEWED / RETURNED / SHELVED.
  4. *Queued*: not submitted yet, but has items of ours waiting.
  5. *Can queue*: not submitted yet and can be queued now (including after the previous node).
  6. *Unavailable*: cannot be queued (locked with nothing before it queued or in review,
     closed, past deadline, prerequisite missing, term inactive).
  Each state is a toggle chip showing how many nodes are in it (after the type filter and
  search). Default: everything except *Approved* and *Unavailable*, which matches the old
  default view.
- **R7.2 Type filter.** One toggle chip per assignment type present in the term (basic,
  advanced, bi-weekly, graduation, …), all on by default.
- **R7.3** Search still applies on top. An assignment is shown when at least one of its
  nodes passes all filters; only those nodes are listed. *Reset* restores the defaults.
- **R7.4** The choice is remembered in this browser (convenience only; losing it just
  restores the defaults).
- **R7.5** Opening the queue page for an assignment from the site shows that assignment
  even if the remembered filter would hide it, without changing the remembered filter.
- **R7.6 Responsive.** Toggling a chip or typing in search never rebuilds the list: rows and
  chips are built once per data change (a check, a queue change), and filtering only shows
  or hides them and updates counts. The chip keeps focus and hover, the selected node stays
  selected, and the list keeps its scroll position across data refreshes.

---

## R8. Thumbnails

### Background

The queue page showed the original images scaled down by CSS. Drawings can be huge (one
queued image measured 12721 × 8000, about 400 MB decoded), more than the browser's decoded
image cache keeps, so every repaint decoded and resampled it again: each frame after a click
took about 300 ms while the page's own script took 0 ms (measured on 2026-11-03).

### Requirements

- **R8.1** Extension pages never display an original image. They show a thumbnail at most
  240 px wide, made once per image and stored with it, so it is never made again.
- **R8.2** Images queued from the site or stored before this change get their thumbnail the
  first time the queue page shows them.
- **R8.3** Images just chosen (the add area, *Replace images*, *Withdraw and replace*) are
  previewed through the same thumbnails.
- **R8.4** Uploads always send the original file, unchanged.
- **R8.5** If a thumbnail cannot be made (e.g. a format the browser cannot decode), a
  placeholder icon is shown; nothing else is affected.

---

## R9. Background app instead of the extension

### Background

Everything ran in the extension's service worker, so Chrome had to stay open (with a window)
for queued drawings to go out. The user wants to close the browser while a batch waits for
review slots. The scheduling core (`engine`, `scheduler`, `reconcile`, `withdraw`, `adapter`,
`model`, …) never touched `chrome.*` and already runs in Node tests; only storage, the alarm,
the token bridge, the CORS workaround, notifications and the queue page's plumbing are tied
to Chrome.

Decided with the user on 2026-11-03: a Node background app with a local web page, login by
saved password, the extension kept as an optional thin shell that also restores the site's
login, and no migration of the old extension's queue.

### Requirements

**The app**

- **R9.1** `app/` is a Node 24 program with no dependencies (`npm start`). It does every check
  and submission the extension did, with the same rules (README *Never submitting twice*,
  R1–R8). It needs no browser to run.
- **R9.2 Storage.** Queue items, images (originals and thumbnails), settings, the last term
  summary and the activity log live in one SQLite file (`node:sqlite`) under
  `%LOCALAPPDATA%\Chamber\` (`CHAMBER_HOME` overrides it). Every write is a transaction, so a
  crash or power loss leaves either the old or the new state, never half of one.
- **R9.3 One instance.** The app listens on `127.0.0.1:47815` (`CHAMBER_PORT` overrides it).
  A second start finds the port taken, says so and exits without touching the data. Within
  the process one check runs at a time (the same lock interface as before, held in memory).
- **R9.4 Restarts.** Killing the app at any point is the same as the old service-worker
  eviction: an item left in *Uploading* or *Submitting* is resolved from platform data on
  the next check and is never sent blindly again.
- **R9.5 Timing.** Periodic checks run every `tickSeconds` (default 60, minimum 30) with the
  review-hours pause, and right after start. After the computer wakes from sleep the next
  check runs at once (a timer that fired late by more than one period counts as a wake-up).
  Nothing runs while the computer sleeps.
- **R9.6 Autostart.** `npm run autostart:on` registers a Windows scheduled task that starts
  the app at the user's logon with no console window and restarts it if it crashes;
  `npm run autostart:off` removes it. The queue page has **Quit app**; quitting is not a
  crash and is not restarted until the next logon.
- **R9.7 No CORS workaround.** The app's requests carry no `Origin` header, so the
  declarativeNetRequest rule is gone.

**Login**

- **R9.8** Automatic login works as before (password login when the session is missing,
  expired or within an hour of expiry; a refused password stops it and notifies, network
  errors retry at most every 10 minutes), with the queue page's **Automatic login** section.
- **R9.9** The password is encrypted with Windows DPAPI for the current user before it is
  stored, so the database file alone does not reveal it. If encryption is unavailable the
  password is not saved and the page says why; there is no plain-text fallback. It is never
  logged, never returned by the API, and only sent to `tenten.art/api/auth/password/login`.
- **R9.10** Without automatic login the app uses a token handed over by the extension (R9.18).
  The 24 h reminders work as before, as Windows notifications.

**Queue page and local API**

- **R9.11** The app serves the queue page at `http://127.0.0.1:47815/`. It looks and behaves
  as before; every read and write goes through the app's API (the page holds no data of its
  own besides per-browser conveniences such as the picker filter, R7.4). Closing the page
  never affects checks. Several open pages stay in sync (server-sent events).
- **R9.12 Local API safety.** The API only answers requests whose `Host` is
  `127.0.0.1:<port>` or `localhost:<port>` (defeats DNS rebinding) and that carry the app's
  secret key in a header (forces a CORS preflight, which is refused, so other web pages can
  neither read nor blindly post). The key is random, made on first start and kept in the data
  folder; the page served by the app embeds it. `Access-Control-Allow-*` headers are never
  sent.
- **R9.13 Thumbnails** (R8) are made by the page, which can decode images, and stored by the
  app. Images queued from the site get theirs the first time a page shows them (R8.2).
- **R9.14 Language.** *Auto* follows the browser showing the page; notifications follow the
  Windows display language.
- **R9.15 Notifications** (approved, revision, not sent, login expiring / expired / automatic
  login failed) are Windows toast notifications; clicking one opens the queue page in the
  default browser. If a toast cannot be shown the event is still in the activity log.

**The extension (optional thin shell)**

- **R9.16** The extension keeps only what needs the site page: the timezone fix, the
  **加入 Chamber 队列** buttons, the floating badge, and the session hand-over (R9.18). It
  has no queue, no storage of drawings and never calls the platform API. Without it the app
  still works fully (images are then queued on the queue page).
- **R9.17 Pairing.** The extension finds the app at `127.0.0.1:47815` and learns the key by
  reading it from the app's own page (a content script on that origin), so opening the queue
  page once in Chrome pairs them. Until paired, or while the app is not running, the site
  buttons say the app is not reachable and queue nothing; nothing is kept for later.
- **R9.18 Session hand-over.** On tenten.art the extension sends the page's token to the app
  (the app keeps whichever token lasts longer, as before); if the page has no usable session
  and automatic login is on, it asks the app for the session it logged in with and restores
  the site's own login with it, as before.
- **R9.19** The toolbar icon opens the queue page; its badge shows the app's state (slots,
  attention count, `||`, `!`), or a grey `off` when the app is not reachable.
- **R9.20 No migration.** Updating the extension deletes its old queue, images, settings
  and saved password from Chrome. Nothing is carried over; the README tells the user to
  switch over while no item is *Uploading* or *Submitting*. Rounds already submitted by the
  old extension show up in the app under *In review* as rounds submitted elsewhere (R5).

### Scenarios that tests must cover

1. The engine tests pass unchanged against the SQLite store (same store contract).
2. Store: enqueue, follow-up order, replace, compare-and-set patch, remove refused while
   in flight, reorder, staged images; all survive closing and reopening the database.
3. Crash between upload and submit, and after submit before the response: on restart the
   item is resolved from the platform (submitted once, or back to the queue), never sent twice.
4. A second app instance exits and leaves the data untouched.
5. API: wrong `Host` → refused; missing or wrong key → refused; an `OPTIONS` preflight gets
   no CORS headers; the password never appears in any response or the activity log.
6. Token hand-over keeps the longer-lasting token; site session is only given out while
   automatic login is on.
7. Wake-up: a timer firing two periods late triggers an immediate check.

---

## Out of scope

- Withdrawing or replacing a 完整作业 (R3.2).
- Grouping the node picker by chapter.
- Waking the computer from sleep to submit (R9.5).
- macOS / Linux autostart (the app itself is plain Node; only R9.6, R9.9 and R9.15 use Windows).
