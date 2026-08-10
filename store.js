// store.js — talks to the fuel Worker, which holds the data in D1.
//
// Reads are cached locally so the app opens instantly and works offline. Writes are queued
// locally first, so logging a meal never waits on the network. Both of those survive from
// the GitHub version and are the reason the app works on a ride with no signal.
//
// What changed is the unit of work. It used to read and write whole month FILES, and carry
// a sha, a merge rule, and a rule for preferring one copy of an entry over another. All of
// that existed to survive two devices editing one blob. The queue now holds OPERATIONS —
// put this entry, delete that one, close this day — and the server applies them to rows.
// Two devices logging into the same day touch different rows and cannot conflict, and a
// delete is finally a delete rather than something a union has to infer.

const LS = {
  key: 'fuel.key',
  cache: 'fuel.cache.',
  queue: 'fuel.queue',
  lastSync: 'fuel.lastSync',
  debug: 'fuel.debug',
  apiUrl: 'fuel.apiUrl',
};

const API = 'https://fuel-parse.shadesofjade.workers.dev';

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

// ---------- the key ----------
//
// One long random secret, held as a Worker secret and pasted once per device. It replaces
// the GitHub PAT in the same slot, with the same sign-out semantics.
//
// Worth being clear about what this is not: it is not a step up in security. The PAT was
// stronger and that was the problem — it also unlocked the GitHub account that runs a
// company, so a runaway client here could and did take that down. This key unlocks one
// Worker holding one food log. Rotating it is one command and one paste per device.

export function getKey() {
  return localStorage.getItem(LS.key) || '';
}

export function setKey(k) {
  localStorage.setItem(LS.key, (k || '').trim());
}

/**
 * Remove the key AND everything it fetched. The cache holds the full food log, the weight
 * history and the workouts in plain text — leaving it behind means a button labelled
 * "remove the key" quietly leaves all the private data on the device.
 *
 * Returns what it deleted so the UI can say so honestly.
 */
export function clearKey() {
  // length/key() rather than Object.keys: it is the actual Storage API, so it behaves the
  // same everywhere and is testable outside a browser.
  const cacheKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS.cache)) cacheKeys.push(k);
  }
  const dropped = pendingCount();
  cacheKeys.forEach((k) => localStorage.removeItem(k));
  [LS.key, LS.queue, LS.lastSync, LS.debug].forEach((k) => localStorage.removeItem(k));
  return { cachedFiles: cacheKeys.length, unsyncedWrites: dropped };
}

/** Anything logged on this device that has not reached the server yet. */
export function unsyncedSummary() {
  return getQueue().map((j) => j.label || j.key);
}

/** Where the Worker lives. The override exists so failure paths can be exercised for real. */
export function apiUrl() {
  const override = localStorage.getItem(LS.apiUrl);
  return (override != null ? override : API).trim().replace(/\/$/, '');
}

export function setApiUrl(url) {
  if (url == null) localStorage.removeItem(LS.apiUrl);
  else localStorage.setItem(LS.apiUrl, String(url).trim());
}

/**
 * One HTTP call to the Worker, with the key attached and errors turned into thrown
 * Errors carrying the server's own words.
 *
 * The server's reason is always surfaced. A bare status code sends you hunting blind —
 * that lesson cost three debugging sessions under the previous backend.
 */
async function call(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const key = getKey();
  if (!key) throw new Error('No key on this device.');

  const ctrl = new AbortController();
  // AbortSignal.timeout is not in older iOS Safari, and this runs on a phone.
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl() + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(payload.error || `server returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return payload;
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`timed out after ${timeoutMs}ms`);
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The gate screen's check. Throws with something readable if the key is no good. */
export async function verifyKey(key) {
  const res = await fetch(`${apiUrl()}/ping`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.ok) return true;
  let detail = '';
  try { detail = (await res.json())?.error || ''; } catch { /* body may be empty */ }
  if (res.status === 401) throw new Error(detail || 'Key rejected — check it pasted whole, with no trailing space.');
  if (res.status === 500) throw new Error(detail || 'The server is missing its own configuration.');
  throw new Error(`The server returned ${res.status}.${detail ? ` ${detail}` : ''}`);
}

// ---------- local cache ----------
//
// Keyed by month for the log and by name for everything else, mirroring how the app reads
// them. There is no sha and nothing to reconcile: the cache is a copy of what the server
// said last, plus whatever this device has queued on top.

function cacheGet(k) {
  try {
    const raw = localStorage.getItem(LS.cache + k);
    return raw ? JSON.parse(raw).value : null;
  } catch {
    return null;
  }
}

function cacheSet(k, value) {
  try {
    localStorage.setItem(LS.cache + k, JSON.stringify({ value, at: Date.now() }));
  } catch (e) {
    // A full quota must not lose the write that is already queued. Say so and carry on:
    // the op is durable in the queue, only the offline copy is degraded.
    dbg(`cache: could not store ${k} — ${e?.message || e}`);
  }
}

const monthKey = (m) => `days.${m}`;
const docKey = (name) => `doc.${name}`;

export function lastSync() {
  const v = localStorage.getItem(LS.lastSync);
  return v ? Number(v) : null;
}

function markSynced() {
  localStorage.setItem(LS.lastSync, String(Date.now()));
}

/** '2026-08-04' → '2026-08'. */
export const monthOf = (iso) => iso.slice(0, 7);

function monthBounds(months) {
  const sorted = [...months].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const [y, m] = last.split('-').map(Number);
  // Day 0 of the next month is the last day of this one, and gets February right.
  const end = new Date(Date.UTC(y, m, 0));
  return { from: `${first}-01`, to: end.toISOString().slice(0, 10) };
}

function splitByMonth(days) {
  const out = {};
  for (const [date, day] of Object.entries(days || {})) (out[monthOf(date)] ||= {})[date] = day;
  return out;
}

/** Write a fetched span into the per-month caches, including months that came back empty. */
function cacheMonths(months, days) {
  const byMonth = splitByMonth(days);
  for (const m of months) cacheSet(monthKey(m), byMonth[m] || {});
}

// ---------- reads ----------

/**
 * Everything the app needs at boot, in one request.
 *
 * Under GitHub this was six round trips before a single day could be drawn, plus one per
 * month of log. One call is not really an optimisation — it is the removal of a set of
 * half-loaded states where the profile had arrived and the log had not.
 *
 * Falls back to the cache whole. A dead connection degrades to stale data, never a blank
 * screen.
 */
export async function bootstrap(months) {
  const { from, to } = monthBounds(months);
  try {
    const res = await call(`/data/bootstrap?from=${from}&to=${to}`);
    cacheMonths(months, res.days);
    for (const name of ['athlete', 'templates', 'weight', 'workouts', 'planned', 'status']) {
      cacheSet(docKey(name), res[name]);
    }
    markSynced();
    dbg(`boot: loaded ${Object.keys(res.days || {}).length} days over ${months.length} month(s)`);
    return { ...res, days: res.days || {} };
  } catch (e) {
    dbg(`boot: ${e.message} — using the cached copy`);
    const cached = {
      athlete: cacheGet(docKey('athlete')),
      templates: cacheGet(docKey('templates')) || { meals: [], singles: [] },
      weight: cacheGet(docKey('weight')) || [],
      workouts: cacheGet(docKey('workouts')) || [],
      planned: cacheGet(docKey('planned')) || [],
      status: cacheGet(docKey('status')),
      days: cachedDays(months),
      offline: true,
    };
    // With no profile there is nothing to compute against and the app says so at the gate.
    // Rethrowing only when the cache is empty keeps a bad link from looking like a failure.
    if (!cached.athlete) throw e;
    return cached;
  }
}

function cachedDays(months) {
  const days = {};
  for (const m of months) Object.assign(days, cacheGet(monthKey(m)) || {});
  return days;
}

/**
 * Load whole months, from cache where we have them and the server for the rest.
 * Used when he pages back past what boot loaded.
 */
export async function loadMonths(months) {
  const missing = months.filter((m) => cacheGet(monthKey(m)) === null);
  if (missing.length) {
    const { from, to } = monthBounds(missing);
    try {
      const res = await call(`/data/days?from=${from}&to=${to}`);
      cacheMonths(missing, res.days);
      markSynced();
    } catch (e) {
      dbg(`load ${missing.join(',')}: ${e.message}`);
    }
  }
  return cachedDays(months);
}

/**
 * Read the server without touching the cache, so the caller decides whether to keep it.
 * Returns `{ days }`, or null if the read failed.
 *
 * Unlike the GitHub version this does NOT have to be paired with a merge. A refresh that
 * arrives while a write is queued is simply the server's current truth for rows this
 * device has not changed; the queued ops are applied on top when they flush.
 */
export async function peekMonths(months) {
  const { from, to } = monthBounds(months);
  try {
    const res = await call(`/data/days?from=${from}&to=${to}`);
    return { days: res.days || {} };
  } catch (e) {
    dbg(`peek ${months.join(',')}: ${e.message}`);
    return null;
  }
}

/** Accept a peeked span into the cache. */
export function adoptMonths(months, days) {
  cacheMonths(months, days);
  markSynced();
}

/**
 * Everything that is not the log: the profile, templates, weight, workouts, planned and
 * the sync status. One call, because they are small and always wanted together.
 */
export async function peekDocs() {
  try {
    return await call('/data/docs');
  } catch (e) {
    dbg(`peek docs: ${e.message}`);
    return null;
  }
}

export function adoptDoc(name, value) {
  cacheSet(docKey(name), value);
}

// ---------- writes ----------
//
// Everything below queues an operation and updates the local cache, so the UI is correct
// on tap and correct after a reload, whether or not the network was there.

/**
 * Queue one op. `key` is what makes a second write to the same thing replace the first
 * rather than pile up behind it — six edits to one entry while offline should flush as
 * one write, not six. Ordering between DIFFERENT keys is preserved, which is what makes
 * "add an entry, then delete it" land correctly.
 */
function enqueue(key, op, label) {
  const q = getQueue().filter((j) => j.key !== key);
  q.push({ key, op, label, at: Date.now() });
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

/**
 * Persist a day by working out what actually changed about it.
 *
 * The app still thinks in whole days — every screen hands one around, and asking each of
 * the seven call sites to say "I edited entry X" would spread the same bug across all of
 * them. So the day arrives whole and the diff happens here, against the last copy the
 * cache holds. What goes on the wire is entry-level either way.
 *
 * Diffing against the CACHE rather than what the app has in memory matters: a free-text
 * entry is shown on screen before it is committed, so the in-memory copy already contains
 * it and a diff against that would decide nothing had changed and never write it.
 */
export function saveDay(date, next) {
  const m = monthOf(date);
  const days = cacheGet(monthKey(m)) || {};
  const prev = days[date] || { entries: [], confounders: [], notes: '' };

  const before = new Map((prev.entries || []).map((e) => [e.id, e]));
  const after = new Map((next.entries || []).map((e) => [e.id, e]));

  for (const [id, entry] of after) {
    if (JSON.stringify(before.get(id)) !== JSON.stringify(entry)) putEntry(date, entry);
  }
  for (const [id, entry] of before) {
    if (!after.has(id)) deleteEntry(date, id, entry.label);
  }

  const dayLevel = (d) => JSON.stringify([!!d.closed, d.notes || '', d.confounders || []]);
  if (dayLevel(prev) !== dayLevel(next)) {
    putDay(date, { closed: !!next.closed, notes: next.notes || '', confounders: next.confounders || [] });
  }
}

/** Put an entry. Same call for a new entry and an edit — the id decides which it is. */
export function putEntry(date, entry) {
  const days = cacheGet(monthKey(monthOf(date))) || {};
  const day = days[date] || { entries: [], confounders: [], notes: '' };
  const entries = [...(day.entries || []).filter((e) => e.id !== entry.id), entry]
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  days[date] = { ...day, entries };
  cacheSet(monthKey(monthOf(date)), days);
  enqueue(`entry:${entry.id}`, { kind: 'entry', date, entry }, `log: ${date} ${entry.label}`);
}

/**
 * Delete an entry.
 *
 * This is the operation the old model could not express. A month file union could not tell
 * "deleted here" from "not seen here", so a delete on the phone was resurrected by the
 * desktop's copy on the next write. There is no ambiguity in a DELETE.
 */
export function deleteEntry(date, id, label = '') {
  const days = cacheGet(monthKey(monthOf(date))) || {};
  const day = days[date];
  if (day) {
    days[date] = { ...day, entries: (day.entries || []).filter((e) => e.id !== id) };
    cacheSet(monthKey(monthOf(date)), days);
  }
  enqueue(`entry:${id}`, { kind: 'entry.delete', id }, `delete: ${date} ${label}`.trim());
}

/** Day-level facts: closed, notes, confounders. */
export function putDay(date, { closed = false, notes = '', confounders = [] } = {}) {
  const days = cacheGet(monthKey(monthOf(date))) || {};
  const day = { ...(days[date] || { entries: [] }), notes, confounders };
  if (closed) day.closed = true; else delete day.closed;
  days[date] = day;
  cacheSet(monthKey(monthOf(date)), days);
  enqueue(`day:${date}`, { kind: 'day', date, closed, notes, confounders }, `day: ${date}`);
}

export function putWeight(date, kg) {
  const list = (cacheGet(docKey('weight')) || []).filter((w) => w.date !== date);
  if (kg != null) list.push({ date, kg });
  list.sort((a, b) => a.date.localeCompare(b.date));
  cacheSet(docKey('weight'), list);
  enqueue(`weight:${date}`, { kind: 'weight', date, kg }, `weight: ${date} ${kg}kg`);
}

/** Several weigh-ins at once, from a sync. One op each, so they dedupe per date. */
export function putWeights(rows) {
  for (const w of rows) putWeight(w.date, w.kg);
}

export function putWorkouts(rows) {
  cacheSet(docKey('workouts'), rows);
  enqueue('workouts', { kind: 'workouts', rows }, `sync: ${rows.length} workouts`);
}

export function putPlanned(rows) {
  cacheSet(docKey('planned'), rows);
  enqueue('planned', { kind: 'planned', rows }, `sync: ${rows.length} planned`);
}

export function putStatus(value) {
  cacheSet(docKey('status'), value);
  enqueue('config:status', { kind: 'config', key: 'status', value }, 'sync: status');
}

// Retry schedule for a failing flush, by attempt count. The queue survives reloads and
// closed tabs, so nothing is lost by waiting — and retrying hard is precisely how the
// previous backend got an entire account throttled.
const BACKOFF_MS = [0, 0, 30e3, 2 * 60e3, 5 * 60e3, 15 * 60e3];

function backoffRemaining(job) {
  const attempts = job.attempts || 0;
  if (!attempts || !job.lastTry) return 0;
  const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
  return Math.max(0, job.lastTry + wait - Date.now());
}

/** When the oldest stuck write will next be tried, or 0 if one is due now. */
export function nextRetryAt() {
  const q = getQueue();
  const waits = q.map((j) => backoffRemaining(j)).filter((ms) => ms > 0);
  return waits.length === q.length && waits.length ? Date.now() + Math.min(...waits) : 0;
}

/** The oldest stuck write, if any write has now failed more than once. */
export function stuckWrite() {
  return getQueue().find((j) => (j.attempts || 0) >= 2) || null;
}

/**
 * Flush the queue: one request carrying every pending op, in order.
 *
 * One request rather than one per file is what makes the whole day's worth of edits a
 * single round trip. It is also why there is no partial-success case to reason about —
 * the server applies the batch in a transaction, so this either all landed or none of it
 * did, and a retry of the whole batch is safe because every op is idempotent.
 */
export async function flushQueue() {
  const queue = getQueue();
  if (!queue.length) return { flushed: 0, failed: 0, error: null };
  if (!getKey()) return { flushed: 0, failed: queue.length, error: 'no key on this device' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { flushed: 0, failed: queue.length, error: 'offline' };
  }
  const wait = Math.min(...queue.map((j) => backoffRemaining(j)));
  if (wait > 0) return { flushed: 0, failed: queue.length, error: queue[0].lastError || null };

  // Which jobs this attempt speaks for. A tap during the round trip appends a new job,
  // and clearing the queue wholesale on success would throw it away unsent.
  const sending = queue.map((j) => `${j.key}@${j.at}`);

  try {
    await call('/data/ops', { method: 'POST', body: { ops: queue.map((j) => j.op) } });
    const remaining = getQueue().filter((j) => !sending.includes(`${j.key}@${j.at}`));
    localStorage.setItem(LS.queue, JSON.stringify(remaining));
    markSynced();
    dbg(`flush: ${queue.length} op(s) landed${remaining.length ? `, ${remaining.length} queued during the send` : ''}`);
    return { flushed: queue.length, failed: remaining.length, error: null };
  } catch (e) {
    const why = e.status === 401
      ? 'Key rejected — it has been rotated. Paste the new one.'
      : e.message;
    markAttempt(sending, why);
    dbg(`flush: FAILED — ${why}`);
    return { flushed: 0, failed: queue.length, error: why };
  }
}

/** Record that a batch was tried and failed, so the UI can stop calling it "waiting". */
function markAttempt(sending, message) {
  const q = getQueue().map((j) => (sending.includes(`${j.key}@${j.at}`)
    ? { ...j, attempts: (j.attempts || 0) + 1, lastError: message, lastTry: Date.now() }
    : j));
  localStorage.setItem(LS.queue, JSON.stringify(q));
}

// ---------- synchronous parsing ----------
//
// The Worker estimates macros in the HTTP response, so an entry is written once, already
// resolved. That deletes the "client must discover an out-of-band mutation" problem: the
// GitHub Action rewriting entries in place, and the client polling to notice, failed four
// separate ways in one day.
//
// The fallback is no longer a GitHub Action. It is the queue: the entry is written as free
// text awaiting a parse, and re-estimated on the next attempt. Nothing is out of band.

// Observed round trips: 5.2s, 7.3s, 8.0s, and one that ran past 10s and fell back. The
// original 10s was set from an assumed 1-2s and left almost no headroom, so an estimate
// that was on its way got thrown away.
const PARSE_TIMEOUT_MS = 20000;

/**
 * Estimate macros for free-text entries, synchronously.
 *
 * Returns an array of results, or **null** meaning "this did not work, keep it pending".
 * Never throws: the caller's fallback is the whole safety net, so an exception here would
 * be an outage rather than a degradation.
 */
export async function parseText(entries, timeoutMs = PARSE_TIMEOUT_MS) {
  if (!getKey() || !entries?.length) {
    dbg(`parse: skipped (${!getKey() ? 'no key' : 'nothing to parse'})`);
    return null;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    dbg('parse: offline, leaving the entry pending');
    return null;
  }

  const started = Date.now();
  try {
    const out = (await call('/parse', { method: 'POST', body: { entries }, timeoutMs }))?.entries;
    if (!Array.isArray(out) || !out.length) {
      dbg('parse: response had no estimates, leaving the entry pending');
      return null;
    }
    dbg(`parse: resolved ${out.length} in ${Date.now() - started}ms`);
    return out;
  } catch (e) {
    dbg(`parse: ${e.message} after ${Date.now() - started}ms, leaving the entry pending`);
    return null;
  }
}

/**
 * Pull training data from TrainingPeaks, now, through the Worker.
 *
 * `sync.py` runs hourly on the Mac and cannot be reached from a page on GitHub Pages, so
 * "sync now" used to be impossible. TrainingPeaks the Worker can reach directly.
 *
 * Returns `{ workouts, planned, weights, lifts }` or `{ error }` — this one reports its
 * failure rather than degrading silently, because he pressed a button and is waiting.
 */
export async function syncTraining(timeoutMs = 30000) {
  try {
    const body = await call('/sync', { method: 'POST', timeoutMs });
    if (!Array.isArray(body.workouts) || !Array.isArray(body.planned)) {
      dbg('sync: response was the wrong shape');
      return { error: 'TrainingPeaks returned nothing usable' };
    }
    dbg(`sync: ${body.workouts.length} workouts, ${body.planned.length} planned`);
    return body;
  } catch (e) {
    dbg(`sync: ${e.message}`);
    return { error: `Could not reach the sync service — ${e.message}.` };
  }
}
