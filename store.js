// store.js — talks to the private fuel-data repo through the GitHub API.
// Reads are cached locally so the app opens instantly and works offline.
// Writes are queued locally first, so logging a meal never waits on the network.

const OWNER = 'suburban-sungod';
const REPO = 'fuel-data';
const API = 'https://api.github.com';

const LS = {
  token: 'fuel.token',
  cache: 'fuel.cache.',
  queue: 'fuel.queue',
  lastSync: 'fuel.lastSync',
};

// ---------- base64 that survives non-ASCII ----------

function b64decode(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// ---------- token ----------

export function getToken() {
  return localStorage.getItem(LS.token) || '';
}

export function setToken(t) {
  localStorage.setItem(LS.token, (t || '').trim());
}

export function clearToken() {
  localStorage.removeItem(LS.token);
}

export async function verifyToken(token) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 401) throw new Error('Token rejected. Check it was copied whole.');
  if (res.status === 404) {
    throw new Error(`Token is valid but cannot see ${OWNER}/${REPO}. Re-issue it with that repo selected and Contents: read and write.`);
  }
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);
  return true;
}

// ---------- local cache ----------

function cacheGet(path) {
  try {
    const raw = localStorage.getItem(LS.cache + path);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheSet(path, value, sha) {
  localStorage.setItem(LS.cache + path, JSON.stringify({ value, sha, at: Date.now() }));
}

export function lastSync() {
  const v = localStorage.getItem(LS.lastSync);
  return v ? Number(v) : null;
}

// ---------- reads ----------

/**
 * Read a JSON file. Returns the cached copy immediately if the network fails,
 * so a dead connection degrades to stale data rather than a blank screen.
 */
export async function readJSON(path, fallback = null) {
  const token = getToken();
  const cached = cacheGet(path);
  if (!token) return cached ? cached.value : fallback;

  try {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (res.status === 404) {
      cacheSet(path, fallback, null);
      return fallback;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const meta = await res.json();
    const value = JSON.parse(b64decode(meta.content));
    cacheSet(path, value, meta.sha);
    localStorage.setItem(LS.lastSync, String(Date.now()));
    return value;
  } catch (err) {
    if (cached) return cached.value;
    throw err;
  }
}

export function cachedSha(path) {
  return cacheGet(path)?.sha ?? null;
}

// ---------- writes ----------

/**
 * Writes go to the local cache first and the queue second, so the UI updates on tap.
 * The queue is flushed opportunistically and survives a reload, a closed tab, or a
 * ride spent out of signal.
 */
export function queueWrite(path, value, message) {
  cacheSet(path, value, cachedSha(path));
  const q = getQueue().filter((j) => j.path !== path); // one pending write per file, last wins
  q.push({ path, message, at: Date.now() });
  localStorage.setItem(LS.queue, JSON.stringify(q));
}

export function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(LS.queue) || '[]');
  } catch {
    return [];
  }
}

export function pendingCount() {
  return getQueue().length;
}

async function putFile(path, value, message, sha) {
  const token = getToken();
  const body = {
    message,
    content: b64encode(JSON.stringify(value, null, 2) + '\n'),
    ...(sha ? { sha } : {}),
  };
  return fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Flush the queue. On a sha conflict the remote file is re-read and the local copy
 * re-applied on top, so a write from another device is never silently clobbered.
 */
export async function flushQueue(onMerge) {
  if (!getToken() || !navigator.onLine) return { flushed: 0, failed: pendingCount() };
  let flushed = 0;
  let failed = 0;

  for (const job of getQueue()) {
    const cached = cacheGet(job.path);
    if (!cached) continue;
    try {
      let res = await putFile(job.path, cached.value, job.message, cached.sha);

      if (res.status === 409 || res.status === 422) {
        const fresh = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${job.path}`, {
          headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json' },
          cache: 'no-store',
        });
        if (fresh.ok) {
          const meta = await fresh.json();
          const remote = JSON.parse(b64decode(meta.content));
          const merged = onMerge ? onMerge(job.path, remote, cached.value) : cached.value;
          cacheSet(job.path, merged, meta.sha);
          res = await putFile(job.path, merged, job.message + ' (merged)', meta.sha);
        }
      }

      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const out = await res.json();
      cacheSet(job.path, cached.value, out.content.sha);
      dequeue(job.path);
      flushed++;
    } catch {
      failed++;
    }
  }

  if (flushed) localStorage.setItem(LS.lastSync, String(Date.now()));
  return { flushed, failed };
}

function dequeue(path) {
  localStorage.setItem(LS.queue, JSON.stringify(getQueue().filter((j) => j.path !== path)));
}

// ---------- paths ----------

export const paths = {
  athlete: 'athlete.json',
  weight: 'weight.json',
  templates: 'templates.json',
  workouts: 'sync/workouts.json',
  planned: 'sync/planned.json',
  day: (iso) => `log/${iso}.json`,
};

/** Merge rule for day files: union of entries by id, remote confounders lose to local. */
export function mergeDay(path, remote, local) {
  if (!path.startsWith('log/')) return local;
  const byId = new Map();
  for (const e of remote?.entries || []) byId.set(e.id, e);
  for (const e of local?.entries || []) byId.set(e.id, e);
  return {
    ...remote,
    ...local,
    entries: [...byId.values()].sort((a, b) => (a.time || '').localeCompare(b.time || '')),
  };
}
