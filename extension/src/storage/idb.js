// IndexedDB `chamber`: images (Blob) and backlog (metadata).
// Shared by the service worker and extension pages (same extension origin).

const DB_NAME = 'chamber';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('backlog')) {
        const s = db.createObjectStore('backlog', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('createdAt', 'createdAt');
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

// Adds an image + backlog item atomically at the end of the queue.
// `roundsAtQueue` is how many rounds the node had on the server when this drawing was
// queued; reconcile uses it to notice a round submitted outside the extension.
export async function addItem({ blob, name, assignmentId, nodeId, title, roundsAtQueue = null }) {
  const db = await open();
  const now = new Date().toISOString();
  const imageId = uid();
  const existing = await listBacklog();
  const order = existing.reduce((m, i) => Math.max(m, i.order ?? 0), 0) + 1;
  const item = {
    id: uid(), imageId, assignmentId: String(assignmentId), nodeId: nodeId === null ? null : String(nodeId),
    title, status: 'queued', reason: null, objectName: null, submissionId: null, roundsBefore: null,
    serverStatus: null, queuePosition: null, estimatedWaitMinutes: null,
    teacherFeedback: null, reviewFileUrls: [], attempts: 0, nextAttemptAt: null, roundsAtQueue,
    order, createdAt: now, updatedAt: now,
  };
  const tx = db.transaction(['images', 'backlog'], 'readwrite');
  tx.objectStore('images').put({ id: imageId, blob, name, mime: blob.type, byteLength: blob.size, createdAt: now });
  tx.objectStore('backlog').put(item);
  await done(tx);
  return item;
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

// Replace the drawing on an item (needs_revision / blocked / failed / queued) and queue it again.
export async function replaceImage(id, blob, name, roundsAtQueue = null) {
  const db = await open();
  const tx = db.transaction(['images', 'backlog'], 'readwrite');
  const backlog = tx.objectStore('backlog');
  const cur = await reqP(backlog.get(id));
  if (!cur || ['uploading', 'submitting', 'pending'].includes(cur.status)) {
    tx.abort();
    return null;
  }
  const now = new Date().toISOString();
  const imageId = uid();
  tx.objectStore('images').delete(cur.imageId);
  tx.objectStore('images').put({ id: imageId, blob, name, mime: blob.type, byteLength: blob.size, createdAt: now });
  const next = {
    ...cur, imageId, status: 'queued', reason: null, objectName: null, submissionId: null, roundsBefore: null,
    serverStatus: null, queuePosition: null, estimatedWaitMinutes: null, attempts: 0, nextAttemptAt: null,
    reasonDetail: null, roundsAtQueue, updatedAt: now,
  };
  backlog.put(next);
  await done(tx);
  return next;
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
    tx.objectStore('images').delete(cur.imageId);
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

// Queue a drawing for a node. If that node already has an item that came back or got
// stuck, the new drawing replaces it instead of adding a stale duplicate.
export async function enqueue({ blob, name, assignmentId, nodeId, title, roundsAtQueue = null }) {
  const aid = String(assignmentId);
  const nid = nodeId === null ? null : String(nodeId);
  const stale = (await listBacklog()).find((i) => i.assignmentId === aid && i.nodeId === nid
    && ['needs_revision', 'blocked', 'failed'].includes(i.status));
  if (stale) return { item: await replaceImage(stale.id, blob, name, roundsAtQueue), replaced: true };
  return { item: await addItem({ blob, name, assignmentId: aid, nodeId: nid, title, roundsAtQueue }), replaced: false };
}
