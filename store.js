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

/**
 * Remove the token AND everything it fetched. The cache holds the full food log, the
 * weight history and the workouts in plain text — leaving it behind means a button
 * labelled "remove the token" quietly leaves all the private data on the device, which
 * defeats the entire reason the data lives in a separate private repo.
 *
 * Returns what it deleted so the UI can say so honestly.
 */
export function clearToken() {
  // length/key() rather than Object.keys: it is the actual Storage API, so it behaves the
  // same everywhere and is testable outside a browser.
  const cacheKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS.cache)) cacheKeys.push(k);
  }
  const dropped = pendingCount();
  cacheKeys.forEach((k) => localStorage.removeItem(k));
  [LS.token, LS.queue, LS.lastSync].forEach((k) => localStorage.removeItem(k));
  return { cachedFiles: cacheKeys.length, unsyncedWrites: dropped };
}

/** Anything logged on this device that has not reached GitHub yet. */
export function unsyncedSummary() {
  return getQueue().map((j) => j.message || j.path);
}

export async function verifyToken(token) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.ok) return true;

  // Surface GitHub's own reason — a bare status code sends you hunting blind.
  let detail = '';
  try { detail = (await res.json())?.message || ''; } catch { /* body may be empty */ }

  if (res.status === 401) {
    throw new Error('Token rejected — check it pasted whole, with no trailing space, and has not expired.');
  }
  if (res.status === 404) {
    throw new Error(`Token works but cannot see ${OWNER}/${REPO}. Re-issue it with that repo selected under "Only select repositories".`);
  }
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      throw new Error(`GitHub rate limit hit. Try again after ${new Date(reset).toLocaleTimeString()}.`);
    }
    throw new Error(
      `GitHub refused the token (403). Usual cause: the token is missing "Metadata: Read-only", ` +
      `which fine-grained tokens need on top of Contents. Check it is a fine-grained token, ` +
      `scoped to ${REPO}, with Contents: Read and write.` + (detail ? ` GitHub said: ${detail}` : '')
    );
  }
  throw new Error(`GitHub returned ${res.status}.` + (detail ? ` ${detail}` : ''));
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
      // Only treat a 404 as "this file does not exist" the first time. Once there is a
      // cached copy, a 404 is far more likely to be a token that lost access than a file
      // that vanished — and caching the fallback over real data throws the log away.
      if (cached) return cached.value;
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

/**
 * Read straight from GitHub without touching the local cache, and without falling back
 * to it. The parse watcher needs this: `readJSON` caches what it reads, so an entry
 * logged while a read was in flight would be overwritten by the response, and the write
 * already queued for it would then push the clobbered file back to GitHub.
 *
 * The caller decides when it is safe to keep the result — see `adopt`.
 */
export async function peekJSON(path) {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const meta = await res.json();
  return { value: JSON.parse(b64decode(meta.content)), sha: meta.sha };
}

/** Accept a peeked copy into the cache. Only call this with no writes queued. */
export function adopt(path, value, sha) {
  cacheSet(path, value, sha);
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
  if (!getToken() || !navigator.onLine) {
    return { flushed: 0, failed: pendingCount(), error: navigator.onLine ? null : 'offline' };
  }
  let flushed = 0;
  let failed = 0;
  // A write that fails forever used to be indistinguishable from one that had simply not
  // been tried yet: both showed "waiting to sync". Keep the reason so the UI can tell him
  // his food log is not reaching GitHub, rather than implying it is merely in a queue.
  let error = null;

  for (const job of getQueue()) {
    const cached = cacheGet(job.path);
    if (!cached) continue;
    try {
      // What we actually sent. On a merge this stops being the local copy, and the cache
      // has to end up holding the merged result — caching the pre-merge copy against the
      // post-merge sha would look fine and then silently undo the merge on the next write.
      let sent = cached.value;
      let res = await putFile(job.path, sent, job.message, cached.sha);

      if (res.status === 409 || res.status === 422) {
        const fresh = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${job.path}`, {
          headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json' },
          cache: 'no-store',
        });
        if (fresh.ok) {
          const meta = await fresh.json();
          const remote = JSON.parse(b64decode(meta.content));
          sent = onMerge ? onMerge(job.path, remote, cached.value) : cached.value;
          cacheSet(job.path, sent, meta.sha);
          res = await putFile(job.path, sent, job.message + ' (merged)', meta.sha);
        }
      }

      if (!res.ok) {
        let why = `GitHub ${res.status}`;
        if (res.status === 403) why = 'GitHub refused the write (403) — the token is probably read-only or expired';
        if (res.status === 404) why = 'GitHub returned 404 — the token has lost access to fuel-data';
        if (res.status === 401) why = 'Token rejected (401) — it has expired or been revoked';
        throw new Error(why);
      }
      const out = await res.json();
      cacheSet(job.path, sent, out.content.sha);
      dequeue(job.path);
      flushed++;
    } catch (e) {
      failed++;
      error = error || e.message;
      markAttempt(job.path, e.message);
    }
  }

  if (flushed) localStorage.setItem(LS.lastSync, String(Date.now()));
  return { flushed, failed, error };
}

/** Record that a queued write was tried and failed, so the UI can stop calling it "waiting". */
function markAttempt(path, message) {
  const q = getQueue().map((j) =>
    j.path === path ? { ...j, attempts: (j.attempts || 0) + 1, lastError: message } : j
  );
  localStorage.setItem(LS.queue, JSON.stringify(q));
}

/** The oldest stuck write, if any write has now failed more than once. */
export function stuckWrite() {
  return getQueue().find((j) => (j.attempts || 0) >= 2) || null;
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
  status: 'sync/status.json',
  // One file per MONTH, not per day. Per-day files meant ~27 concurrent API calls on every
  // open, which trips GitHub's secondary (burst) rate limit and returns 403. A month per
  // file makes a full load 8 requests regardless of how long the log runs.
  month: (iso) => `log/${iso.slice(0, 7)}.json`,
};

/** An entry still waiting on the parser: free text, no macros yet, not given up on. */
function awaitingParse(e) {
  return e?.source === 'freetext' && e.parse_state !== 'failed';
}

/**
 * Pick between two copies of the same entry. Local wins by default — it is the newer
 * edit in every ordinary case — EXCEPT where the local copy is still awaiting the parser
 * and the remote one has been resolved.
 *
 * That exception is the whole point. The parser rewrites entries in place on GitHub, so a
 * phone holding the pre-parse copy is stale even though its copy is the "local" one.
 * Straight local-wins pushes zero macros back over resolved ones, silently understating
 * the day and making the parser re-bill for food it has already estimated.
 */
function preferEntry(remote, local) {
  if (!remote) return local;
  if (!local) return remote;
  if (awaitingParse(local) && !awaitingParse(remote)) return remote;
  return local;
}

/**
 * Merge rule for month files: union days, and within a shared day union entries by id.
 * Lets the phone and the desktop both write the same month without either losing work.
 *
 * Known gap: a deletion on one device is resurrected by the other device's copy, because
 * a union cannot tell "deleted here" from "not yet seen here". Fixing that needs
 * tombstones, which is a bigger change than this merge.
 */
export function mergeMonth(path, remote, local) {
  if (!path.startsWith('log/')) return local;
  const days = { ...(remote?.days || {}) };
  for (const [date, localDay] of Object.entries(local?.days || {})) {
    const remoteDay = days[date];
    if (!remoteDay) { days[date] = localDay; continue; }
    const byId = new Map();
    for (const e of remoteDay.entries || []) byId.set(e.id, e);
    for (const e of localDay.entries || []) byId.set(e.id, preferEntry(byId.get(e.id), e));
    days[date] = {
      ...remoteDay,
      ...localDay,
      entries: [...byId.values()].sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    };
  }
  return { ...remote, ...local, days };
}
