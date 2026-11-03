// IndexedDB `chamber`: images (Blob) and backlog (metadata).
// Shared by the service worker and extension pages (same extension origin).
//
// A backlog item holds an ordered list of 1-3 images (`imageIds`) that is sent as one
// round, and the object names uploaded so far (`objectNames`, same order).

const DB_NAME = 'chamber';
const DB_VERSION = 2;

// v1 items had a single `imageId` / `objectName`.
function migrateV1(store) {
  store.openCursor().onsuccess = (e) => {
    const cur = e.target.result;
    if (!cur) return;
    const { imageId, objectName, ...rest } = cur.value;
    if (!Array.isArray(rest.imageIds)) {
      cur.update({ ...rest, imageIds: imageId ? [imageId] : [], objectNames: objectName ? [objectName] : [] });
    }
    cur.continue();
  };
}

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('backlog')) {
        const s = db.createObjectStore('backlog', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('createdAt', 'createdAt');
      } else if (e.oldVersion < 2) {
        migrateV1(req.transaction.objectStore('backlog'));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const uid = () => crypto.randomUUID();

export async function listBacklog() {
  const db = await open();
  const all = await reqP(db.transaction('backlog').objectStore('backlog').getAll());
  return all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function getItem(id) {
  const db = await open();
  return reqP(db.transaction('backlog').objectStore('backlog').get(id));
}

export async function getImage(id) {
  const db = await open();
  return reqP(db.transaction('images').objectStore('images').get(id));
}

// Store the thumbnail made for an image (requirements R8), so it is made only once.
export async function setThumb(id, thumb) {
  const db = await open();
  const tx = db.transaction('images', 'readwrite');
  const store = tx.objectStore('images');
  const cur = await reqP(store.get(id));
  if (cur) store.put({ ...cur, thumb });
  await done(tx);
}

function putImages(tx, images, now) {
  const store = tx.objectStore('images');
  return images.map(({ blob, name }) => {
    const id = uid();
    store.put({ id, blob, name, mime: blob.type, byteLength: blob.size, createdAt: now });
    return id;
  });
}

function deleteImages(tx, ids) {
  for (const id of ids || []) tx.objectStore('images').delete(id);
}

// A fresh queued item. `roundsAtQueue` is how many rounds the node had on the server when
// this drawing was queued; reconcile uses it to notice a round submitted outside the
// extension.
function newItem({ assignmentId, nodeId, title, roundsAtQueue = null }, imageIds, order, now) {
  return {
    id: uid(), imageIds, assignmentId: String(assignmentId), nodeId: nodeId === null ? null : String(nodeId),
    title, status: 'queued', reason: null, objectNames: [], submissionId: null, roundsBefore: null,
    serverStatus: null, queuePosition: null, estimatedWaitMinutes: null,
    teacherFeedback: null, reviewFileUrls: [], attempts: 0, nextAttemptAt: null, roundsAtQueue,
    order, createdAt: now, updatedAt: now,
  };
}

// The same item, queued again with other images; it keeps its id and place in the order.
function requeued(cur, imageIds, roundsAtQueue, now) {
  return {
    ...cur, imageIds, status: 'queued', reason: null, objectNames: [], submissionId: null, roundsBefore: null,
    serverStatus: null, queuePosition: null, estimatedWaitMinutes: null, attempts: 0, nextAttemptAt: null,
    reasonDetail: null, roundsAtQueue, updatedAt: now,
  };
}

const lastOrder = (items) => items.reduce((m, i) => Math.max(m, i.order ?? 0), 0);

// Adds the images + one backlog item atomically at the end of the queue.
// `images` is [{ blob, name }] in submission order.
export async function addItem({ images, ...fields }) {
  const db = await open();
  const now = new Date().toISOString();
  const order = lastOrder(await listBacklog()) + 1;
  const tx = db.transaction(['images', 'backlog'], 'readwrite');
  const item = newItem(fields, putImages(tx, images, now), order, now);
  tx.objectStore('backlog').put(item);
  await done(tx);
  return item;
}

// Images stored ahead of a decision (e.g. a withdrawal's replacement, R6). They belong to
// no item until attached with addItemWithImages / requeueWithImages, or are discarded.
export async function stageImages(images) {
  const db = await open();
  const tx = db.transaction('images', 'readwrite');
  const ids = putImages(tx, images, new Date().toISOString());
  await done(tx);
  return ids;
}

export async function discardImages(ids) {
  const db = await open();
  const tx = db.transaction('images', 'readwrite');
  deleteImages(tx, ids);
  await done(tx);
}

// Queue already stored images as a new item, ahead of the queued items on the same node
// (so it goes before follow-ups there), or at the end if there are none.
export async function addItemWithImages({ imageIds, ...fields }) {
  const db = await open();
  const now = new Date().toISOString();
  const all = await listBacklog();
  const aid = String(fields.assignmentId);
  const nid = fields.nodeId === null ? null : String(fields.nodeId);
  const siblings = all.filter((i) => i.assignmentId === aid && i.nodeId === nid && i.status === 'queued');
  const order = siblings.length ? Math.min(...siblings.map((i) => i.order ?? 0)) - 0.5 : lastOrder(all) + 1;
  const item = newItem(fields, imageIds, order, now);
  const tx = db.transaction('backlog', 'readwrite');
  tx.objectStore('backlog').put(item);
  await done(tx);
  return item;
}

// Put already stored images on an item and queue it again (compare-and-set on status).
export async function requeueWithImages(id, imageIds, roundsAtQueue, expectStatus) {
  const db = await open();
  const tx = db.transaction(['images', 'backlog'], 'readwrite');
  const backlog = tx.objectStore('backlog');
  const cur = await reqP(backlog.get(id));
  if (!cur || ![].concat(expectStatus).includes(cur.status)) {
    tx.abort();
    return null;
  }
  const now = new Date().toISOString();
  deleteImages(tx, cur.imageIds);
  const next = requeued(cur, imageIds, roundsAtQueue, now);
  backlog.put(next);
  await done(tx);
  return next;
}

// Merge a patch into an item. `expectStatus` makes it a compare-and-set.
export async function patchItem(id, patch, expectStatus) {
  const db = await open();
  const tx = db.transaction('backlog', 'readwrite');
  const store = tx.objectStore('backlog');
  const cur = await reqP(store.get(id));
  let result = null;
  if (cur && (expectStatus === undefined || [].concat(expectStatus).includes(cur.status))) {
    result = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    store.put(result);
  }
  await done(tx);
  return result;
}

// Replace the images on an item (queued / needs_revision / blocked / failed) and queue it again.
export async function replaceImages(id, images, roundsAtQueue = null) {
  const db = await open();
  const tx = db.transaction(['images', 'backlog'], 'readwrite');
  const backlog = tx.objectStore('backlog');
  const cur = await reqP(backlog.get(id));
  if (!cur || !['queued', 'needs_revision', 'blocked', 'failed'].includes(cur.status)) {
    tx.abort();
    return null;
  }
  const now = new Date().toISOString();
  deleteImages(tx, cur.imageIds);
  backlog.put(requeued(cur, putImages(tx, images, now), roundsAtQueue, now));
  await done(tx);
  return reqP(db.transaction('backlog').objectStore('backlog').get(id));
}

export async function removeItem(id) {
  const db = await open();
  const tx = db.transaction(['images', 'backlog'], 'readwrite');
  const backlog = tx.objectStore('backlog');
  const cur = await reqP(backlog.get(id));
  if (cur && ['uploading', 'submitting'].includes(cur.status)) {
    tx.abort();
    return false;
  }
  if (cur) {
    backlog.delete(id);
    deleteImages(tx, cur.imageIds);
  }
  await done(tx);
  return true;
}

// ids in the desired order; only reorders, never changes status.
export async function reorder(ids) {
  const db = await open();
  const tx = db.transaction('backlog', 'readwrite');
  const store = tx.objectStore('backlog');
  const all = await reqP(store.getAll());
  const pos = new Map(ids.map((id, i) => [id, i + 1]));
  for (const item of all) {
    if (pos.has(item.id) && item.order !== pos.get(item.id)) store.put({ ...item, order: pos.get(item.id) });
  }
  await done(tx);
}

// Queue a drawing for a node. An item on that node that got stuck (blocked / failed) is
// replaced instead of leaving a stale duplicate. Anything else on the node stays: the new
// item is a follow-up, sent after the node's current round comes back (requirements R2).
export async function enqueue({ images, assignmentId, nodeId, title, roundsAtQueue = null }) {
  const aid = String(assignmentId);
  const nid = nodeId === null ? null : String(nodeId);
  const stale = (await listBacklog()).find((i) => i.assignmentId === aid && i.nodeId === nid
    && ['blocked', 'failed'].includes(i.status));
  if (stale) {
    const item = await replaceImages(stale.id, images, roundsAtQueue);
    if (item) return { item, replaced: true };
  }
  return { item: await addItem({ images, assignmentId: aid, nodeId: nid, title, roundsAtQueue }), replaced: false };
}
