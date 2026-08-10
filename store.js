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
  debug: 'fuel.debug',
  parseUrl: 'fuel.parseUrl',
};

// ---------- diagnostics ----------
//
// Three stuck-spinner incidents were diagnosed entirely from repo state and commit
// timestamps, because the client kept no record of what it had actually done. This is
// that record: a small ring buffer in localStorage, written at every point where the
// sync machinery makes a decision, readable from the Ref tab. It must never throw —
// a diagnostic that can break the thing it observes is worse than none.

const DEBUG_MAX_LINES = 300;

export function dbg(msg) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const buf = JSON.parse(localStorage.getItem(LS.debug) || '[]');
    buf.push(`${stamp} ${msg}`);
    localStorage.setItem(LS.debug, JSON.stringify(buf.slice(-DEBUG_MAX_LINES)));
  } catch { /* never let diagnostics take the app down */ }
}

export function dbgLines() {
  try {
    return JSON.parse(localStorage.getItem(LS.debug) || '[]');
  } catch {
    return [];
  }
}

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
  [LS.token, LS.queue, LS.lastSync, LS.debug].forEach((k) => localStorage.removeItem(k));
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

// ---------- synchronous parsing ----------
//
// The Worker (source in the private fuel-data repo, `worker/`) estimates macros in the
// HTTP response, so an entry can be written to GitHub once, already resolved. That deletes
// the entire "client must discover an out-of-band mutation" problem — the GitHub Action
// rewriting entries in place, and the client polling to notice, is what failed four
// separate ways in one day.
//
// The Action path is still there and still correct. Every failure here — a bad response, a
// timeout, no signal, no configured URL — falls back to it. Nothing in this file is a
// secret: the endpoint is public and useless without the GitHub token the caller presents.

const PARSE_URL = 'https://fuel-parse.shadesofjade.workers.dev/parse';
// Observed round trips: 5.2s, 7.3s, 8.0s, and one that ran past 10s and fell back. The
// original 10s was set from an assumed 1-2s and left almost no headroom, so an estimate
// that was on its way got thrown away and the entry went to the slow path instead.
// Giving up early costs more than waiting: the row sits there either way, but a timeout
// also spends a GitHub write, a workflow run and a second Anthropic call.
const PARSE_TIMEOUT_MS = 20000;

/**
 * The parse endpoint, or '' if there isn't one. The localStorage override exists so the
 * fallback path can be exercised for real — point it at a dead host and log something —
 * without deleting the Worker.
 */
export function parseUrl() {
  const override = localStorage.getItem(LS.parseUrl);
  if (override != null) return override.trim();
  return PARSE_URL.includes('__SUBDOMAIN__') ? '' : PARSE_URL;
}

export function setParseUrl(url) {
  if (url == null) localStorage.removeItem(LS.parseUrl);
  else localStorage.setItem(LS.parseUrl, String(url).trim());
}

/**
 * Estimate macros for free-text entries, synchronously.
 *
 * Returns an array of results, or **null** meaning "this did not work, use the async
 * path". Never throws and never rejects: the caller's fallback is the whole safety net,
 * so a thrown error here would be an outage rather than a degradation.
 */
export async function parseText(entries, timeoutMs = PARSE_TIMEOUT_MS) {
  const url = parseUrl();
  const token = getToken();
  if (!url || !token || !entries?.length) {
    dbg(`parse: skipped (${!url ? 'no endpoint' : !token ? 'no token' : 'nothing to parse'})`);
    return null;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    dbg('parse: offline, falling back to the async parser');
    return null;
  }

  const started = Date.now();
  // AbortSignal.timeout is not in older iOS Safari, and this runs on a phone. A manual
  // controller is two more lines and works everywhere.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let why = '';
      try { why = (await res.json())?.error || ''; } catch { /* body may be empty */ }
      dbg(`parse: HTTP ${res.status}${why ? ` (${why})` : ''} after ${Date.now() - started}ms, falling back`);
      return null;
    }
    const out = (await res.json())?.entries;
    if (!Array.isArray(out) || !out.length) {
      dbg('parse: response had no estimates, falling back');
      return null;
    }
    dbg(`parse: resolved ${out.length} in ${Date.now() - started}ms`);
    return out;
  } catch (e) {
    const reason = e?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e?.message || 'failed';
    dbg(`parse: ${reason}, falling back to the async parser`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull training data from TrainingPeaks, now, through the Worker.
 *
 * `sync.py` runs hourly on the Mac and cannot be reached from a page on GitHub Pages, so
 * "sync now" used to be impossible: an hour-old plan was an hour-old plan. TrainingPeaks
 * the Worker can reach directly, and it carries everything the app reads off a workout.
 *
 * Returns `{ workouts, planned }` on success, or `{ error }` — this one reports its
 * failure rather than degrading silently, because the whole point is that he pressed a
 * button and is waiting to see whether it worked.
 */
export async function syncTraining(timeoutMs = 30000) {
  const url = parseUrl().replace(/\/parse$/, '/sync');
  const token = getToken();
  if (!url || !token) return { error: 'no sync endpoint configured' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      dbg(`sync: HTTP ${res.status} (${body.error || 'no reason given'})`);
      return { error: body.error || `sync failed (${res.status})` };
    }
    if (!Array.isArray(body.workouts) || !Array.isArray(body.planned)) {
      dbg('sync: response was the wrong shape');
      return { error: 'TrainingPeaks returned nothing usable' };
    }
    dbg(`sync: ${body.workouts.length} workouts, ${body.planned.length} planned`);
    return { workouts: body.workouts, planned: body.planned };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'timed out' : e?.message || 'failed';
    dbg(`sync: ${reason}`);
    return { error: `Could not reach the sync service — ${reason}.` };
  } finally {
    clearTimeout(timer);
  }
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
  if (!res.ok) {
    // A null here is indistinguishable from "file missing" to the caller, and a 403 from
    // the secondary rate limiter looks exactly like a token problem. Record which it was.
    if (res.status === 403 && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0')) noteRateLimit(res);
    // `remaining 0` alone cannot tell the two possible causes apart, and they need
    // opposite fixes. A LIMIT of 60 means GitHub is treating these reads as anonymous —
    // the token is not arriving — and no amount of backing off will help. A limit of
    // 5000 means something really is making thousands of requests an hour on this token.
    // Log the limit and the resource so the next occurrence answers the question itself.
    const lim = res.headers.get('x-ratelimit-limit');
    const used = res.headers.get('x-ratelimit-used');
    const resource = res.headers.get('x-ratelimit-resource');
    dbg(`peek ${path}: HTTP ${res.status}${res.status === 403
      ? ` (used ${used}/${lim} of "${resource}", remaining ${res.headers.get('x-ratelimit-remaining')}, clears ~${new Date(rateLimitedUntil()).toLocaleTimeString()})`
      : ''}`);
    return null;
  }
  noteQuota(res, path);
  clearRateLimit();
  const meta = await res.json();
  return { value: JSON.parse(b64decode(meta.content)), sha: meta.sha };
}

// ---------- rate limiting ----------
//
// GitHub's SECONDARY (abuse) limiter is per account, shared by every device and script
// using it, and reports itself in the same words as the hourly quota while the hourly
// quota sits untouched. When it bites, every read 403s for ~10 minutes, and continuing
// to hammer it extends the ban. The app needs to know it is in that state so the
// watcher can back off and the sync bar can say what is actually happening.

let rateLimitUntil = 0;

// What the quota looked like on the last successful read. Logged when it first appears
// and whenever it gets low, because "remaining 0" on a 403 never said which quota was
// exhausted — and a LIMIT of 60 (anonymous) versus 5000 (this token) is the whole
// diagnosis. Cheap: it is reading headers off a response we already have.
let quotaSeen = null;

function noteQuota(res, path) {
  const limit = Number(res.headers.get('x-ratelimit-limit') || 0);
  const remaining = Number(res.headers.get('x-ratelimit-remaining') || 0);
  if (!limit) return;
  const first = quotaSeen?.limit !== limit;
  quotaSeen = { limit, remaining, at: Date.now() };
  if (first || remaining < 50 || remaining % 500 === 0) {
    dbg(`quota: ${remaining}/${limit} left on "${res.headers.get('x-ratelimit-resource')}" after reading ${path}`
      + (limit <= 60 ? ' — a limit this low means GitHub is treating these reads as ANONYMOUS' : ''));
  }
}

/** The last seen quota, for the Reference tab. */
export function quota() {
  return quotaSeen;
}

function noteRateLimit(res) {
  const retryAfter = Number(res.headers.get('retry-after') || 0);
  const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
  // Secondary limits send retry-after; the hourly quota sends a reset stamp. With
  // neither visible (CORS can hide them), assume the ~10 minutes observed in practice.
  rateLimitUntil = retryAfter ? Date.now() + retryAfter * 1000
    : reset > Date.now() ? reset
    : Date.now() + 10 * 60 * 1000;
}

function clearRateLimit() {
  rateLimitUntil = 0;
}

/** Epoch ms until which GitHub is refusing this account's reads, or 0 if it isn't. */
export function rateLimitedUntil() {
  return rateLimitUntil > Date.now() ? rateLimitUntil : 0;
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

// Retry schedule for a failing write, by attempt count. The queue survives reloads and
// closed tabs, so nothing is lost by waiting — whereas retrying hard costs the hourly
// quota, and once that is gone every READ 403s as well and the app cannot even discover
// that the work it is queuing has already been done by someone else.
const BACKOFF_MS = [0, 0, 30e3, 2 * 60e3, 5 * 60e3, 15 * 60e3];

function backoffRemaining(job) {
  const attempts = job.attempts || 0;
  if (!attempts || !job.lastTry) return 0;
  const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
  return Math.max(0, job.lastTry + wait - Date.now());
}

/** When the oldest stuck write will next be tried, or 0 if one is due now. */
export function nextRetryAt() {
  const waits = getQueue().map((j) => backoffRemaining(j)).filter((ms) => ms > 0);
  return waits.length === getQueue().length && waits.length ? Date.now() + Math.min(...waits) : 0;
}

/**
 * Flush the queue. On a sha conflict the remote file is re-read and the local copy
 * re-applied on top, so a write from another device is never silently clobbered.
 */
export async function flushQueue(onMerge) {
  if (!getToken() || !navigator.onLine) {
    return { flushed: 0, failed: pendingCount(), error: navigator.onLine ? null : 'offline' };
  }
  // GitHub is already refusing this account. Spending the attempt anyway extends the ban
  // and teaches the backoff nothing.
  if (rateLimitedUntil()) {
    return { flushed: 0, failed: pendingCount(), error: 'GitHub is rate-limiting this account — the write is safe on this device and will retry' };
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
    // A write that has failed repeatedly gets retried more slowly. Retrying every 60s,
    // plus on every focus and every visibilitychange, from however many tabs are open,
    // is how a single stuck write burned an entire hourly quota to zero — after which
    // every read 403s too and nothing can recover. The queue is durable; it can wait.
    if (backoffRemaining(job) > 0) { failed++; continue; }
    try {
      // What we actually sent. On a merge this stops being the local copy, and the cache
      // has to end up holding the merged result — caching the pre-merge copy against the
      // post-merge sha would look fine and then silently undo the merge on the next write.
      let sent = cached.value;
      let res = await putFile(job.path, sent, job.message, cached.sha);

      if (res.status === 409 || res.status === 422) {
        dbg(`write ${job.path}: sha conflict (${res.status}), re-reading and merging`);
        const fresh = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${job.path}`, {
          headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json' },
          cache: 'no-store',
        });
        if (fresh.ok) {
          const meta = await fresh.json();
          const remote = JSON.parse(b64decode(meta.content));
          sent = onMerge ? onMerge(job.path, remote, cached.value) : cached.value;

          // The merge changed nothing, so this write has nothing left to say. Almost
          // always it is a phone holding pending copies of entries the parser has already
          // resolved on GitHub: the queued write is fighting for the right to publish
          // worse data, and losing, forever. Take the remote copy and drop the job.
          if (JSON.stringify(sent) === JSON.stringify(remote)) {
            cacheSet(job.path, remote, meta.sha);
            dequeue(job.path);
            flushed++;
            dbg(`write ${job.path}: already on GitHub, nothing left to send — dropped`);
            continue;
          }

          cacheSet(job.path, sent, meta.sha);
          res = await putFile(job.path, sent, job.message + ' (merged)', meta.sha);
        } else {
          // Without this the caller sees the ORIGINAL 409 and is told the write conflicted,
          // when in fact the app never managed to read the file it was conflicting with.
          // Those need opposite responses and looked identical for three debugging sessions.
          if (fresh.status === 403 && (fresh.headers.get('retry-after') || fresh.headers.get('x-ratelimit-remaining') === '0')) noteRateLimit(fresh);
          throw new Error(`conflict, and the re-read failed too (GitHub ${fresh.status})`);
        }
      }

      if (!res.ok) {
        // GitHub says exactly what is wrong in the body and we were throwing it away, so
        // every write failure arrived as a bare status code and three separate debugging
        // sessions had to guess. Never again.
        let detail = '';
        try { detail = (await res.json())?.message || ''; } catch { /* body may be empty */ }
        let why = `GitHub ${res.status}${detail ? ` — ${detail}` : ''}`;
        if (res.status === 403) {
          // A rate-limited 403 and a dead-token 403 need opposite advice: one says wait,
          // the other says go re-issue the token. Don't send him to GitHub settings for
          // a limiter that clears itself in ten minutes.
          if (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0') {
            noteRateLimit(res);
            why = 'GitHub is rate-limiting this account — the write is safe on this device and will retry';
          } else {
            why = 'GitHub refused the write (403) — the token is probably read-only or expired';
          }
        }
        if (res.status === 404) why = 'GitHub returned 404 — the token has lost access to fuel-data';
        if (res.status === 401) why = 'Token rejected (401) — it has expired or been revoked';
        throw new Error(why);
      }
      const out = await res.json();
      cacheSet(job.path, sent, out.content.sha);
      dequeue(job.path);
      flushed++;
      dbg(`write ${job.path}: flushed ok (queued ${Math.round((Date.now() - job.at) / 1000)}s ago)`);
    } catch (e) {
      failed++;
      error = error || e.message;
      markAttempt(job.path, e.message);
      dbg(`write ${job.path}: FAILED — ${e.message}`);
    }
  }

  if (flushed) localStorage.setItem(LS.lastSync, String(Date.now()));
  return { flushed, failed, error };
}

/** Record that a queued write was tried and failed, so the UI can stop calling it "waiting". */
function markAttempt(path, message) {
  const q = getQueue().map((j) =>
    j.path === path ? { ...j, attempts: (j.attempts || 0) + 1, lastError: message, lastTry: Date.now() } : j
  );
  localStorage.setItem(LS.queue, JSON.stringify(q));
}

/** The oldest stuck write, if any write has now failed more than once. */
export function stuckWrite() {
  return getQueue().find((j) => (j.attempts || 0) >= 2) || null;
}

/**
 * Abandon a queued write. Only for the case where the remote copy already contains
 * everything the queued one was trying to say — see the merge check in `flushQueue`.
 */
export function discardWrite(path) {
  dequeue(path);
  dbg(`write ${path}: discarded, GitHub already has this content`);
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
