// IndexedDB persistence for uploaded MIDI files (raw ArrayBuffers).
// Two object stores so the song list loads instantly without reading blobs:
//   songs : metadata {id, name, size, addedAt, noteCount, duration}
//   blobs : {id, data: ArrayBuffer}

const DB_NAME = 'pianoflow';
const DB_VERSION = 1;
let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('songs')) {
        const s = db.createObjectStore('songs', { keyPath: 'id' });
        s.createIndex('addedAt', 'addedAt');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Database is blocked by another tab'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function makeId(name, size) {
  // Same file uploaded twice overwrites the old entry instead of duplicating.
  let h = 2166136261;
  const s = name + ':' + size;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'song-' + (h >>> 0).toString(36) + '-' + size.toString(36);
}

/**
 * Stores the raw file bytes and metadata.
 * @param {string} name
 * @param {ArrayBuffer} buffer
 * @param {{noteCount:number, duration:number}} info
 */
export async function saveSong(name, buffer, info) {
  const db = await openDb();
  const id = makeId(name, buffer.byteLength);
  const tx = db.transaction(['songs', 'blobs'], 'readwrite');
  tx.objectStore('blobs').put({ id, data: buffer.slice(0) });
  tx.objectStore('songs').put({
    id,
    name,
    size: buffer.byteLength,
    addedAt: Date.now(),
    noteCount: info.noteCount,
    duration: info.duration,
  });
  await txDone(tx);
  if (globalThis.navigator && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  return id;
}

export async function listSongs() {
  const db = await openDb();
  const tx = db.transaction('songs', 'readonly');
  const all = await req(tx.objectStore('songs').getAll());
  all.sort((a, b) => b.addedAt - a.addedAt);
  return all;
}

/** @returns {Promise<{meta:object, data:ArrayBuffer}|null>} */
export async function loadSong(id) {
  const db = await openDb();
  const tx = db.transaction(['songs', 'blobs'], 'readonly');
  const [meta, blob] = await Promise.all([req(tx.objectStore('songs').get(id)), req(tx.objectStore('blobs').get(id))]);
  if (!meta || !blob) return null;
  return { meta, data: blob.data };
}

export async function deleteSong(id) {
  const db = await openDb();
  const tx = db.transaction(['songs', 'blobs'], 'readwrite');
  tx.objectStore('songs').delete(id);
  tx.objectStore('blobs').delete(id);
  await txDone(tx);
}

const PREFS_KEY = 'pianoflow.prefs';

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (_) {
    /* quota or disabled */
  }
}
