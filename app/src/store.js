// Queue items and their images, on SQLite (requirements R9.2). Same contract as the old
// IndexedDB store, which engine.js and withdraw.js are written against.
//
// A backlog item holds an ordered list of 1-3 images (`imageIds`) that is sent as one
// round, and the object names uploaded so far (`objectNames`, same order).
// Images going in are { data: Uint8Array, name, mime }; getImage() hands them out as a
// Blob, which is what the API client uploads.

import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

export const uid = () => randomUUID();

const EDITABLE = ['queued', 'needs_revision', 'blocked', 'failed'];

// A fresh queued item. `roundsAtQueue` is how many rounds the node had on the server when
// this drawing was queued; reconcile uses it to notice a round submitted elsewhere.
function newItem({ assignmentId, nodeId, title, roundsAtQueue = null }, imageIds, order, now) {
  return {
    id: uid(), imageIds, assignmentId: String(assignmentId), nodeId: nodeId == null ? null : String(nodeId),
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

const sortItems = (all) => all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
const lastOrder = (items) => items.reduce((m, i) => Math.max(m, i.order ?? 0), 0);
const statuses = (expect) => [].concat(expect);

export function makeStore(db) {
  const q = {
    all: db.prepare('SELECT data FROM items'),
    get: db.prepare('SELECT data FROM items WHERE id = ?'),
    put: db.prepare('INSERT INTO items (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
    del: db.prepare('DELETE FROM items WHERE id = ?'),
    image: db.prepare('SELECT id, name, mime, size, created_at, data, thumb FROM images WHERE id = ?'),
    imageMeta: db.prepare('SELECT id FROM images WHERE id = ?'),
    putImage: db.prepare('INSERT INTO images (id, name, mime, size, created_at, data) VALUES (?, ?, ?, ?, ?, ?)'),
    delImage: db.prepare('DELETE FROM images WHERE id = ?'),
    setThumb: db.prepare('UPDATE images SET thumb = ? WHERE id = ?'),
    imageIds: db.prepare('SELECT id, created_at FROM images'),
  };

  const all = () => sortItems(q.all.all().map((r) => JSON.parse(r.data)));
  const get = (id) => {
    const r = q.get.get(String(id));
    return r ? JSON.parse(r.data) : null;
  };
  const put = (item) => q.put.run(item.id, JSON.stringify(item));

  function putImages(images, now) {
    return images.map(({ data, name, mime }) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const id = uid();
      q.putImage.run(id, name || null, mime || '', bytes.byteLength, now, bytes);
      return id;
    });
  }
  const deleteImages = (ids) => { for (const id of ids || []) q.delImage.run(String(id)); };

  // Images given either as new data ({ images }) or as ids already stored ({ imageIds }).
  const imagesFor = ({ images, imageIds }, now) => (imageIds ? [...imageIds] : putImages(images || [], now));

  const store = {
    async listBacklog() { return all(); },
    async getItem(id) { return get(id); },

    async getImage(id) {
      const r = q.image.get(String(id));
      if (!r) return null;
      return {
        id: r.id, name: r.name, mime: r.mime, byteLength: r.size, createdAt: r.created_at,
        blob: new Blob([r.data], { type: r.mime }),
        thumb: r.thumb ? new Blob([r.thumb], { type: 'image/webp' }) : null,
      };
    },
    // Raw bytes for the HTTP API (no Blob round trip).
    imageBytes(id, which = 'data') {
      const r = q.image.get(String(id));
      if (!r) return null;
      return which === 'thumb' ? (r.thumb ? { bytes: r.thumb, mime: 'image/webp' } : null) : { bytes: r.data, mime: r.mime, name: r.name };
    },
    async hasImage(id) { return !!q.imageMeta.get(String(id)); },

    // Store the thumbnail made for an image (requirements R8), so it is made only once.
    async setThumb(id, bytes) { q.setThumb.run(bytes, String(id)); },

    // Images stored ahead of a decision (a withdrawal's replacement, R6, or images the page
    // uploads before queuing them). They belong to no item until attached, or discarded;
    // gcImages() removes leftovers.
    async stageImages(images) { return transaction(db, () => putImages(images, new Date().toISOString())); },
    async discardImages(ids) { transaction(db, () => deleteImages(ids)); },

    // Adds the images + one item atomically at the end of the queue.
    async addItem({ images, imageIds, ...fields }) {
      return transaction(db, () => {
        const now = new Date().toISOString();
        const item = newItem(fields, imagesFor({ images, imageIds }, now), lastOrder(all()) + 1, now);
        put(item);
        return item;
      });
    },

    // Queue already stored images as a new item, ahead of the queued items on the same node
    // (so it goes before follow-ups there), or at the end if there are none.
    async addItemWithImages({ imageIds, ...fields }) {
      return transaction(db, () => {
        const now = new Date().toISOString();
        const items = all();
        const aid = String(fields.assignmentId);
        const nid = fields.nodeId == null ? null : String(fields.nodeId);
        const siblings = items.filter((i) => i.assignmentId === aid && i.nodeId === nid && i.status === 'queued');
        const order = siblings.length ? Math.min(...siblings.map((i) => i.order ?? 0)) - 0.5 : lastOrder(items) + 1;
        const item = newItem(fields, [...imageIds], order, now);
        put(item);
        return item;
      });
    },

    // Put already stored images on an item and queue it again (compare-and-set on status).
    async requeueWithImages(id, imageIds, roundsAtQueue, expectStatus) {
      return transaction(db, () => {
        const cur = get(id);
        if (!cur || !statuses(expectStatus).includes(cur.status)) return null;
        deleteImages(cur.imageIds);
        const next = requeued(cur, [...imageIds], roundsAtQueue, new Date().toISOString());
        put(next);
        return next;
      });
    },

    // Merge a patch into an item. `expectStatus` makes it a compare-and-set.
    async patchItem(id, patch, expectStatus) {
      return transaction(db, () => {
        const cur = get(id);
        if (!cur || (expectStatus !== undefined && !statuses(expectStatus).includes(cur.status))) return null;
        const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
        put(next);
        return next;
      });
    },

    // Replace the images on an item (queued / needs_revision / blocked / failed) and queue
    // it again. `images` is new image data, or { imageIds } of staged images.
    async replaceImages(id, images, roundsAtQueue = null) {
      return transaction(db, () => {
        const cur = get(id);
        if (!cur || !EDITABLE.includes(cur.status)) return null;
        const now = new Date().toISOString();
        const ids = Array.isArray(images) ? putImages(images, now) : [...images.imageIds];
        deleteImages(cur.imageIds);
        const next = requeued(cur, ids, roundsAtQueue, now);
        put(next);
        return next;
      });
    },

    async removeItem(id) {
      return transaction(db, () => {
        const cur = get(id);
        if (cur && ['uploading', 'submitting'].includes(cur.status)) return false;
        if (cur) {
          q.del.run(cur.id);
          deleteImages(cur.imageIds);
        }
        return true;
      });
    },

    // ids in the desired order; only reorders, never changes status.
    async reorder(ids) {
      transaction(db, () => {
        const pos = new Map(ids.map((id, i) => [String(id), i + 1]));
        for (const item of all()) {
          if (pos.has(item.id) && item.order !== pos.get(item.id)) put({ ...item, order: pos.get(item.id) });
        }
      });
    },

    // Queue a drawing for a node. An item on that node that got stuck (blocked / failed) is
    // replaced instead of leaving a stale duplicate. Anything else on the node stays: the new
    // item is a follow-up, sent after the node's current round comes back (requirements R2).
    async enqueue({ images, imageIds, assignmentId, nodeId, title, roundsAtQueue = null }) {
      const aid = String(assignmentId);
      const nid = nodeId == null ? null : String(nodeId);
      const stale = all().find((i) => i.assignmentId === aid && i.nodeId === nid && ['blocked', 'failed'].includes(i.status));
      if (stale) {
        const item = await store.replaceImages(stale.id, imageIds ? { imageIds } : images, roundsAtQueue);
        if (item) return { item, replaced: true };
      }
      return { item: await store.addItem({ images, imageIds, assignmentId: aid, nodeId: nid, title, roundsAtQueue }), replaced: false };
    },

    // Delete images no item refers to that are older than `olderThanMs` (staged images
    // whose page went away before using them).
    async gcImages(olderThanMs, now = Date.now()) {
      return transaction(db, () => {
        const used = new Set(all().flatMap((i) => i.imageIds || []));
        let n = 0;
        for (const { id, created_at: at } of q.imageIds.all()) {
          if (!used.has(id) && now - Date.parse(at) > olderThanMs) {
            q.delImage.run(id);
            n++;
          }
        }
        return n;
      });
    },
  };
  return store;
}
