import * as F from './fuel.js';
import * as S from './store.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
// `new Date('2026-08-09')` is parsed as UTC midnight and then displayed in local time, so
// every date label silently shifts a day in any negative UTC offset. Harmless in Sydney,
// wrong the moment he opens this in the US. Append a time and it parses as local.
const localDate = (iso) => new Date(iso + 'T00:00:00');
const signed = (n) => (n == null ? '—' : (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)).toLocaleString());

const state = {
  athlete: null, weights: [], templates: { meals: [], singles: [] },
  workouts: [], planned: [], logs: {}, months: {}, status: null,
  date: F.isoDate(new Date()), view: 'today', pendingTab: 'meals',
};

// The real calendar date as of the last check, so a midnight rollover can be detected.
let rolloverDate = F.isoDate(new Date());

// ============ boot ============

async function boot() {
  if (!S.getToken()) return showGate();
  $('#app').hidden = false;
  try {
    await loadAll();
  } catch (err) {
    $('#sync-bar').hidden = false;
    $('#sync-bar').textContent = `Offline — showing last synced data. (${err.message})`;
  }

  // Without a profile there is nothing to compute a single number from, and every render
  // path dereferences it. Say so plainly instead of throwing behind a bar that claims to
  // be showing last synced data — the failure case is a newly paired phone on bad signal,
  // where an empty cache plus a failed fetch otherwise leaves a blank screen and no clue.
  if (!state.athlete) return showLoadFailure();
  wire();
  render();
  flush();
  watchForParse();
  setInterval(flush, 60000);
  window.addEventListener('online', flush);

  // iOS suspends timers in a backgrounded tab, so the 60s flush stops dead the moment the
  // phone is locked. Without these two listeners a logged entry can sit unsent for as long
  // as the app is away — which is exactly how the first free-text entry appeared to hang
  // for eleven minutes.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  window.addEventListener('focus', resume);

  // A desktop tab can sit focused for hours without a single visibilitychange, so focus
  // alone is not enough — poll gently while the window is actually being looked at.
  readBuildTag().then((t) => { buildTag = t; S.dbg(`boot: build ${t || 'unknown'}, ${S.pendingCount()} queued`); });
  setInterval(async () => {
    if (document.hidden) return;
    if (await checkForNewBuild()) return;
    refreshData();
  }, 5 * 60 * 1000);

  // Midnight crossed with the app still open otherwise leaves it logging into yesterday.
  // Only follow the clock if he was actually sitting on today; never yank him off a day
  // he deliberately paged back to.
  setInterval(async () => {
    const now = F.isoDate(new Date());
    if (now === rolloverDate) return;
    const wasOnToday = state.date === rolloverDate;
    rolloverDate = now;
    if (!wasOnToday) return render();
    state.date = now;
    await loadMonths([now]);
    render();
  }, 60000);
}

function showLoadFailure() {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gate').innerHTML = `<div class="gate-card">
    <h1>Can't load your profile</h1>
    <p class="muted">The app reached this device but couldn't read <code>athlete.json</code> from
    the private repo, and there is no cached copy here yet. Nothing is lost — this device just
    has nothing to work from.</p>
    <p class="muted">Usually one of: no signal right now, the token has expired, or the token
    was issued without <strong>Contents: Read and write</strong> on <code>fuel-data</code>.</p>
    <button id="retry" class="btn-primary">Try again</button>
    <button id="reset-token" class="link-btn" style="margin-top:10px">Use a different token</button>
  </div>`;
  $('#retry').onclick = () => location.reload();
  $('#reset-token').onclick = () => { S.clearToken(); location.reload(); };
}

function showGate() {
  $('#gate').hidden = false;
  $('#token-save').onclick = async () => {
    const t = $('#token-input').value.trim();
    const errBox = $('#token-error');
    errBox.hidden = true;
    if (!t) return;
    try {
      await S.verifyToken(t);
      S.setToken(t);
      location.reload();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.hidden = false;
    }
  };
  $('#token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#token-save').click(); });
}

async function loadAll() {
  const [athlete, weights, templates, workouts, planned, status] = await Promise.all([
    S.readJSON(S.paths.athlete),
    S.readJSON(S.paths.weight, []),
    S.readJSON(S.paths.templates, { meals: [], singles: [] }),
    S.readJSON(S.paths.workouts, []),
    S.readJSON(S.paths.planned, []),
    S.readJSON(S.paths.status, null),
  ]);
  Object.assign(state, { athlete, weights, templates, workouts, planned, status });
  await loadMonths(F.weekDates(state.date, F.isoDate(new Date())).concat(recentDates(21)));
}

function recentDates(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(F.addDays(state.date, -i));
  return out;
}

/**
 * Load whole months and unpack them into per-day state. Sequential on purpose: three
 * requests in a row is well inside GitHub's burst allowance, where a fan-out of one
 * request per day was not.
 */
async function loadMonths(dates) {
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  for (const m of months) {
    if (state.months[m]) continue;
    const file = (await S.readJSON(S.paths.month(m + '-01'), null)) || { month: m, days: {} };
    state.months[m] = file;
    for (const [date, day] of Object.entries(file.days || {})) {
      state.logs[date] = { date, entries: [], confounders: [], notes: '', ...day };
    }
  }
  for (const d of new Set(dates)) {
    if (!state.logs[d]) state.logs[d] = { date: d, entries: [], confounders: [], notes: '' };
  }
}

async function flush() {
  const before = S.pendingCount();
  if (before) {
    const { flushed } = await S.flushQueue(S.mergeMonth);
    if (flushed) renderSyncBar();
  }
  renderSyncBar();
}

function ctx() {
  return { athlete: state.athlete, weights: state.weights, workouts: state.workouts, planned: state.planned };
}

function today() { return state.logs[state.date] || { date: state.date, entries: [], confounders: [] }; }

/**
 * Persist a day. `commit: false` updates state and the screen but queues nothing —
 * used for the second or two while a free-text entry is being estimated synchronously.
 * Writing a `pending` entry to GitHub in that window would fire the parse Action and
 * re-create the out-of-band race the Worker exists to remove.
 */
async function saveDay(day, { commit = true } = {}) {
  const key = day.date.slice(0, 7);
  // Never write a month file this device has not read. Building one from scratch queues a
  // file holding a single day, and only the conflict handler stops that flattening the
  // rest of the month on GitHub — far too much to rest on a path that runs this rarely.
  if (!state.months[key]) await loadMonths([day.date]);

  state.logs[day.date] = day;
  const month = state.months[key] || { month: key, days: {} };
  const { date, ...rest } = day;
  month.days = { ...month.days, [day.date]: rest };
  state.months[key] = month;
  if (!commit) { render(); return; }
  S.queueWrite(S.paths.month(day.date), month, `log: ${day.date}`);
  render();
  flush();
}

// ============ wiring ============

function wire() {
  $('#day-prev').onclick = async () => { state.date = F.addDays(state.date, -1); await loadMonths([state.date]); render(); };
  $('#day-next').onclick = async () => { state.date = F.addDays(state.date, 1); await loadMonths([state.date]); render(); };
  $('#day-today').onclick = () => { state.date = F.isoDate(new Date()); render(); };

  $$('.tab').forEach((b) => b.onclick = () => { state.view = b.dataset.view; render(); });
  $('#toggle-table').onclick = () => { const t = $('#day-table'); t.hidden = !t.hidden; };
  $('#weight-save').onclick = logWeight;

  $$('[data-close]').forEach((n) => n.onclick = closeSheet);
  $$('.seg-btn').forEach((b) => b.onclick = () => selectTab(b.dataset.tab));
  $('#c-save').onclick = addCustom;
  $('#add-entry').onclick = () => openSheet();
  $('#add-entry-bottom').onclick = () => openSheet();
  $('#weight-save-today').onclick = logWeight;
}

// ============ render ============

function render() {
  const isToday = state.date === F.isoDate(new Date());
  $('#day-label').textContent = isToday ? 'Today' : localDate(state.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  $('#day-today').hidden = isToday;
  $('#day-next').disabled = state.date >= F.isoDate(new Date());

  ['today', 'trends', 'ref'].forEach((v) => { $('#view-' + v).hidden = state.view !== v; });
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));

  if (state.view === 'today') {
    renderHero(); renderToday(); renderEntries(); renderDayClose();
    // A closed day is a decision, and the app should stop arguing with it. Advice about
    // what to eat next, on a day he has just declared finished, is noise at best and an
    // invitation to undo it at worst.
    const quiet = dayIsClosed();
    $('#card-suggest').hidden = quiet;
    $('#card-plan').hidden = quiet;
    if (!quiet) { renderSuggestions(); renderPlan(); }
    renderConfounders();
  }
  if (state.view === 'trends') { renderWeight(); renderCalChart(); renderProteinChart(); renderTable(); }
  if (state.view === 'ref') renderSettings();
  renderSyncBar();
}

function renderSyncBar() {
  const bar = $('#sync-bar');
  const p = S.pendingCount();
  const stuck = S.stuckWrite();
  if (stuck) {
    // "Waiting to sync" reads as patience. After two failed attempts it is not waiting,
    // it is stuck, and he needs to know his food log is only on this phone.
    bar.hidden = false;
    bar.className = 'sync-bar failed';
    bar.textContent = `${p} ${p === 1 ? 'change is' : 'changes are'} stuck on this phone and not reaching GitHub — ${stuck.lastError}`;
  } else if (S.rateLimitedUntil()) {
    // The one state where a spinner genuinely has to wait. Say so, with a clock — the
    // alternative is him watching "estimating" while GitHub refuses every read and the
    // app looks broken. Everything is safe: writes retry, and parsed macros land when
    // the limiter lifts.
    bar.hidden = false;
    bar.className = 'sync-bar pending';
    bar.textContent = `GitHub is rate-limiting this account (all devices share it) — retrying until ~${new Date(S.rateLimitedUntil()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Everything logged is safe.`;
  } else if (p) {
    bar.hidden = false;
    bar.className = 'sync-bar pending';
    bar.textContent = `${p} ${p === 1 ? 'change' : 'changes'} saved on this phone, waiting to sync`;
  } else {
    const t = S.lastSync();
    bar.hidden = !t;
    bar.className = 'sync-bar';
    if (t) bar.textContent = `Synced ${timeAgo(t)} · tap to refresh`;
  }
  // Always give him a way to force a read. Waiting on a timer to prove the app is not
  // broken is a bad place to leave someone who has just watched an entry not appear.
  bar.onclick = async () => {
    bar.textContent = 'Checking GitHub…';
    const changed = await refreshData({ force: true });
    if (!changed) { bar.textContent = 'Up to date'; setTimeout(renderSyncBar, 1500); }
  };
  bar.style.cursor = 'pointer';
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------- closing the day ----------
//
// The week number holds the current day out of its totals on purpose: half a day of eating
// always looks like a huge deficit, and that is the flattering error this page exists to
// kill. But he stops eating around eight, not at midnight, so for the last few hours of
// every evening the headline is stale by design and there is nothing he can do about it.
//
// Closing the day is him saying "that was the last of the food". It folds the day into the
// week immediately and stops the app suggesting more.

function dayIsClosed(date = state.date) {
  return !!state.logs[date]?.closed;
}

function renderDayClose() {
  const btn = $('#close-day');
  // Only the current day is ever held open, so only the current day has anything to close.
  const isToday = state.date === F.isoDate(new Date());
  btn.hidden = !isToday;
  if (!isToday) return;

  const closed = dayIsClosed();
  btn.textContent = closed ? 'Day closed · reopen' : 'Close the day';
  btn.classList.toggle('is-closed', closed);
  btn.onclick = async () => {
    // Reopening deletes the flag rather than writing `closed: false`, so the log keeps
    // saying only what happened.
    const { closed: _prev, ...day } = today();
    await saveDay(closed ? { ...day, date: state.date } : { ...day, date: state.date, closed: true });
    S.dbg(`day ${state.date} ${closed ? 'reopened' : 'closed'}`);
  };
}

// ---------- hero: week-to-date deficit vs plan ----------

function renderHero() {
  const realToday = F.isoDate(new Date());
  // Cap the week at the real today, never at the day being viewed — otherwise paging back
  // to a Wednesday reports a finished week as a three-day one.
  const dates = F.weekDates(state.date, realToday);
  const wk = F.cumulativeDeficit(dates, ctx(), state.logs, realToday);

  const n = $('#hero-number');
  const cls = wk.loggedDays === 0 ? 'flat' : wk.variance >= 0 ? 'ahead' : 'behind';
  n.className = 'hero-number ' + cls;
  n.textContent = wk.loggedDays === 0 ? 'No closed days yet' : `${signed(wk.variance)} kcal`;

  $('#hero-week').textContent = `from Mon ${localDate(F.weekStart(state.date)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;

  // Today is shown live but never folded into the total — half a day of eating always
  // looks like a deficit, and that is the flattering error this page exists to kill.
  const openBit = wk.open?.logged && wk.open.target
    ? ` Today so far: ${num(wk.open.intake)} of ${num(wk.open.target)}, not counted until the day closes.`
    : wk.open ? ' Today is still open and not counted yet.' : '';

  $('#hero-sub').textContent = (wk.loggedDays === 0
    ? 'Nothing complete this week yet.'
    : `${wk.variance >= 0 ? 'Ahead of' : 'Behind'} plan across ${wk.loggedDays} closed ${wk.loggedDays === 1 ? 'day' : 'days'}.`) + openBit;

  // per-day bars, scaled to the largest absolute variance in the week
  const bars = $('#hero-bars');
  bars.innerHTML = '';
  const max = Math.max(400, ...wk.days.map((d) => Math.abs(d.variance || 0)));
  for (const d of wk.days) {
    const b = el('div', 'hb ' + (d.variance == null ? '' : d.variance >= 0 ? 'under' : 'over') + (d.open ? ' open' : ''));
    if (d.variance != null) {
      const h = Math.max(4, (Math.abs(d.variance) / max) * 34);
      b.appendChild(el('i')).style.height = h + 'px';
    }
    b.appendChild(el('span', '', localDate(d.date).toLocaleDateString(undefined, { weekday: 'narrow' })));
    b.title = d.open
      ? `${d.date}: still open, ate ${num(d.intake)} of ${num(d.target)} so far`
      : d.logged
        ? `${d.date}: ${signed(d.variance)} vs plan (ate ${num(d.intake)}, target ${num(d.target)})`
        : `${d.date}: nothing logged`;
    bars.appendChild(b);
  }

  $('#hero-detail').innerHTML = `
    <div><b>${num(wk.actual)}</b><span>actual deficit</span></div>
    <div><b>${num(wk.planned)}</b><span>planned</span></div>
    <div><b>${wk.projectedKg >= 0 ? '−' : '+'}${Math.abs(wk.projectedKg).toFixed(2)} kg</b><span>implied so far</span></div>`;
}

// ---------- today ----------

function renderToday() {
  const t = F.targetsFor(state.date, ctx());
  const tot = F.dayTotals(today().entries);
  const a = state.athlete;

  $('#day-badge').className = 'badge ' + t.day.type;
  $('#day-badge').textContent = `${t.day.type}${t.day.basis === 'planned' ? ' (planned)' : ''}`;

  const left = t.kcal_target == null ? null : t.kcal_target - tot.kcal;
  $('#today-stats').innerHTML = `
    <div class="stat"><b>${num(tot.kcal)}</b><span>kcal</span><em>${t.kcal_target ? 'of ' + num(t.kcal_target) : ''}</em></div>
    <div class="stat"><b>${num(tot.protein)}</b><span>protein</span><em>${t.protein_target ? 'of ' + t.protein_target + 'g' : ''}</em></div>
    <div class="stat"><b>${num(tot.carbs)}</b><span>carbs</span><em>g</em></div>
    <div class="stat"><b>${num(tot.fat)}</b><span>fat</span><em>${tot.kcal ? Math.round((tot.fat * 9 / tot.kcal) * 100) + '%' : 'g'}</em></div>`;

  const bars = $('#today-bars');
  bars.innerHTML = '';
  if (t.kcal_target) {
    bars.appendChild(barRow('Calories', tot.kcal, t.kcal_target,
      left >= 0 ? `${num(left)} left` : `${num(-left)} over`,
      left >= 0 ? 'var(--s3)' : 'var(--s2)'));
  }
  if (t.protein_target) {
    bars.appendChild(barRow('Protein', tot.protein, t.protein_max,
      `${num(tot.protein)} / ${t.protein_target}g`, 'var(--s1)',
      { zoneFrom: t.protein_min / t.protein_max, zoneTo: 1, mark: t.protein_target / t.protein_max }));
  }

  renderFlags(t, tot);
}

function barRow(label, value, max, right, color, opts = {}) {
  const row = el('div', 'bar-row');
  row.appendChild(el('div', 'bar-head', `<span>${label}</span><span class="muted">${right}</span>`));
  const track = el('div', 'bar-track');
  if (opts.zoneFrom != null) {
    const z = el('div', 'bar-zone');
    z.style.left = opts.zoneFrom * 100 + '%';
    z.style.width = (opts.zoneTo - opts.zoneFrom) * 100 + '%';
    track.appendChild(z);
  }
  const fill = el('div', 'bar-fill');
  fill.style.width = Math.min(100, (value / max) * 100) + '%';
  fill.style.background = color;
  track.appendChild(fill);
  if (opts.mark != null) {
    const m = el('div', 'bar-mark');
    m.style.left = opts.mark * 100 + '%';
    track.appendChild(m);
  }
  row.appendChild(track);
  return row;
}

function renderFlags(t, tot) {
  const box = $('#today-flags');
  box.innerHTML = '';
  const add = (cls, html) => box.appendChild(el('div', 'flag ' + cls, html));

  if (t.weight_stale_days != null && t.weight_stale_days > 14) {
    add('warn', `<b>Weight is ${t.weight_stale_days} days old.</b> Every target on this page is computed from ${t.weight_kg}kg on ${t.weight_date}. Weigh in to make them real.`);
  }
  if (!t.weight_kg) {
    add('bad', `<b>No weigh-in on record.</b> Targets can't be computed without one.`);
  }

  const meals = F.mealClusters(today().entries, state.athlete);
  const short = meals.filter((m) => m.proteinShort);
  // Same reason the suggester goes quiet: on a closed day this is a complaint about a
  // meal he can no longer do anything about.
  if (short.length && !dayIsClosed()) {
    add('warn', `<b>${short.length} ${short.length === 1 ? 'meal' : 'meals'} under ${state.athlete.protein_min_per_meal_g}g protein.</b> Distribution matters as much as the daily total — ${short.map((m) => hhmm(m.start)).join(', ')}.`);
  }

  const pendingEntries = today().entries.filter((e) => e.source === 'freetext' && e.parse_state !== 'failed');
  if (pendingEntries.length) {
    add('', `<b>${pendingEntries.length} ${pendingEntries.length === 1 ? 'entry' : 'entries'} still estimating.</b> Usually about 20 seconds. Today's totals are understated until ${pendingEntries.length === 1 ? 'it lands' : 'they land'}.`);
  }

  const failedEntries = today().entries.filter((e) => e.parse_state === 'failed');
  if (failedEntries.length) {
    add('bad', `<b>${failedEntries.length} ${failedEntries.length === 1 ? 'entry' : 'entries'} couldn't be estimated.</b> Delete and re-enter with macros, or fix at the Mac. Today's totals are understated.`);
  }

  // A sync that quietly died looks exactly like a rest week, so say so out loud.
  const st = state.status;
  if (st?.last_run) {
    const ageDays = (Date.now() - new Date(st.last_run).getTime()) / 86400000;
    if (ageDays > 2) {
      add('warn', `<b>Training data is ${Math.floor(ageDays)} days stale.</b> The Mac sync last ran ${new Date(st.last_run).toLocaleDateString()}. Day types and ride calories below that date are missing, not zero.`);
    } else if (st.strava_ok === false || st.trainingpeaks_ok === false) {
      const dead = [st.strava_ok === false && 'Strava', st.trainingpeaks_ok === false && 'TrainingPeaks'].filter(Boolean).join(' and ');
      add('warn', `<b>${dead} failed on the last sync.</b> Ride calories may be understated, which makes the deficit look bigger than it is.`);
    }
  }

  // Say where the activity number came from. A planned session standing in for one Strava
  // has not synced yet is the difference between a 3,100 target and an 1,875 one, and he
  // should never have to guess which he is looking at.
  if (t.activity_planned_kcal) {
    const names = t.activity_planned_sessions.map((p) => p.title).filter(Boolean).join(', ');
    add('warn', `<b>${num(t.activity_planned_kcal)} kcal of today's activity is from the plan, not measured.</b>
      ${names ? escapeHtml(names) + ' — n' : 'N'}ot in Strava yet. The Mac syncs at 06:15 and 21:00, so a morning
      session shows as planned until tonight. The number will firm up on its own.`);
  } else if (t.activity_confidence === 'estimated' && t.activity_kcal) {
    add('', `<b>${num(t.activity_kcal)} kcal activity is estimated,</b> not measured — no power data for this session.`);
  }
}

function hhmm(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }

/**
 * Seconds since an entry was logged. Prefers the stamp written at log time; falls back to
 * its clock time for entries logged before that stamp existed. Null for any other day,
 * where "how long has this been spinning" is not a meaningful question.
 */
function entryAgeSec(e) {
  if (e.logged_at) return (Date.now() - e.logged_at) / 1000;
  if (state.date !== F.isoDate(new Date())) return null;
  const m = F.minutesOf(e.time);
  if (m == null) return null;
  const now = new Date();
  return (now.getHours() * 60 + now.getMinutes() - m) * 60;
}

// ---------- entries, grouped into meals ----------

function renderEntries() {
  const box = $('#entries');
  box.innerHTML = '';
  const meals = F.mealClusters(today().entries, state.athlete);
  if (!meals.length) { box.appendChild(el('p', 'muted small', 'Nothing logged yet.')); return; }

  for (const m of meals) {
    const head = el('div', 'meal-head' + (m.proteinShort ? ' short' : ''));
    head.innerHTML = `<span>${hhmm(m.start)}${m.end !== m.start ? '–' + hhmm(m.end) : ''}</span>
      <span>${num(m.kcal)} kcal · ${num(m.protein)}g P${m.proteinShort ? ` · ${Math.round(m.proteinGap)}g short` : ''}</span>`;
    box.appendChild(head);

    for (const e of m.entries) {
      const failed = e.parse_state === 'failed';
      const pending = e.source === 'freetext' && !failed;
      const row = el('div', 'entry' + (pending ? ' pending' : '') + (failed ? ' failed' : ''));

      let macros;
      if (pending) {
        // A spinner that spins forever is worse than no spinner. Past a minute — four times
        // the round trip actually observed — say so and give him a button, rather than
        // implying the app is still working on it when it may simply not have looked.
        const age = entryAgeSec(e);
        macros = age != null && age > 60
          ? `<span class="spin"></span>still estimating after ${Math.round(age)}s · <b class="recheck">check now</b>`
          : '<span class="spin"></span>estimating macros…';
      }
      else if (failed) macros = `couldn't estimate — ${escapeHtml(e.parse_error || 'unknown error')}`;
      else {
        macros = `${num(e.kcal)} kcal · ${num(e.protein)}P · ${num(e.carbs)}C · ${num(e.fat)}F`;
        if (e.source === 'parsed') macros += ` · <em class="tag">est${e.confidence === 'low' ? ' (rough)' : ''}</em>`;
        if (e.source === 'matched') macros += ' · <em class="tag">matched</em>';
      }

      row.innerHTML = `<time>${e.time}</time>
        <div class="e-main">
          <div class="e-label">${escapeHtml(e.label)}</div>
          <div class="e-macros">${macros}</div>
          ${e.note ? `<div class="e-note">${escapeHtml(e.note)}</div>` : ''}
        </div>`;

      // Tap the row to edit. Delete-and-retype was the only way to change a portion or
      // fix a time, and on a failed parse it meant retyping the food itself.
      const main = row.querySelector('.e-main');
      main.onclick = (ev) => {
        if (ev.target.classList.contains('recheck')) { recheckNow(); return; }
        openSheet(e);
      };
      main.style.cursor = 'pointer';

      const del = el('button', 'e-del', '×');
      del.onclick = () => {
        const day = { ...today(), entries: today().entries.filter((x) => x.id !== e.id) };
        saveDay(day);
      };
      row.appendChild(del);
      box.appendChild(row);
    }
  }
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- what should I eat ----------

function renderSuggestions() {
  const box = $('#suggestions');
  box.innerHTML = '';
  const t = F.targetsFor(state.date, ctx());
  const tot = F.dayTotals(today().entries);

  if (t.kcal_target == null) {
    $('#suggest-headline').textContent = 'Needs a weigh-in before it can suggest anything.';
    $('#suggest-mode').textContent = '';
    return;
  }

  const now = new Date();
  const s = F.suggestSnacks({
    targets: t, totals: tot, entries: today().entries, templates: state.templates,
    workouts: t.workouts, planned: t.planned,
    nowMin: now.getHours() * 60 + now.getMinutes(),
  });

  $('#suggest-mode').textContent = { over: 'over target', recovery: 'recovery window',
    prefuel: 'pre-ride', 'protein-tight': 'protein, tight', protein: 'protein',
    topup: 'top up' }[s.mode] || '';
  $('#suggest-headline').textContent = s.headline;

  if (!s.picks.length) {
    box.appendChild(el('p', 'muted small', 'Nothing in your usual foods fits what is left. Log something custom.'));
    return;
  }

  for (const p of s.picks) {
    const row = el('button', 'suggestion' + (p.repeated ? ' repeated' : ''));
    row.innerHTML = `<div class="s-main">
        <div class="s-label">${escapeHtml(p.label)}${p.repeated ? ' <em class="tag">again</em>' : ''}${p.source === 'estimate' ? ' <em class="tag">est</em>' : ''}</div>
        <div class="s-why">${escapeHtml(p.why)}</div>
      </div>
      <div class="s-macros"><b>${num(p.kcal)}</b><span>${Math.round(p.protein)}P · ${Math.round(p.carbs)}C</span></div>`;
    // Suggest then log in one tap. A suggestion you have to go and re-enter by hand is
    // just advice, and advice is the part he already has.
    row.onclick = () => logSuggestion(p);
    box.appendChild(row);
  }
}

/** Log a suggestion straight in — as its component items if it was a pair. */
function logSuggestion(pick) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const parts = pick.parts || [pick];
  const day = today();
  const added = parts.map((item, i) => ({
    id: Math.random().toString(36).slice(2, 8) + i,
    time,
    label: item.label,
    kcal: item.kcal, protein: item.protein, carbs: item.carbs, fat: item.fat,
    source: 'template', note: item.detail || '',
  }));
  saveDay({ ...day, entries: [...day.entries, ...added].sort((a, b) => a.time.localeCompare(b.time)) });
}

// ---------- fuel plan ----------

function renderPlan() {
  const t = F.targetsFor(state.date, ctx());
  const box = $('#fuel-plan');
  box.innerHTML = '';
  const line = (h) => box.appendChild(el('div', 'flag', h));

  const src = t.workouts.filter((w) => !['strength', 'swim', 'other'].includes(w.type));
  const plan = t.planned.filter((p) => !['strength', 'swim', 'other'].includes(p.type));
  const ride = src[0] || plan[0];

  // Today's sessions by name. Without this the TrainingPeaks and Strava data drove the
  // numbers invisibly, so a synced plan was indistinguishable from nothing having synced.
  const sessions = [
    ...t.workouts.map((w) => ({ name: w.name, min: w.duration_min, tag: w.avg_watts ? `${Math.round(w.avg_watts)}W avg` : 'no power', done: true })),
    ...t.activity_planned_sessions.map((p) => ({ name: p.title, min: p.duration_min, tag: p.tss ? `TSS ${p.tss} planned` : 'planned', done: false })),
  ];
  if (sessions.length) {
    line(`<span><b>Today:</b> ${sessions.map((s) =>
      `${escapeHtml(s.name || 'Session')} · ${s.min}min · ${s.tag}${s.done ? '' : ' <em class="tag">not yet done</em>'}`
    ).join('<br>')}</span>`);
  }

  if (t.kcal_target) {
    const split = t.activity_planned_kcal
      ? `${num(t.activity_measured_kcal)} measured + ${num(t.activity_planned_kcal)} planned`
      : `${num(t.activity_kcal)}`;
    line(`<span><b>${num(t.kcal_target)} kcal</b> target — ${num(t.base_tdee)} base + ${split} activity − ${num(t.planned_deficit)} deficit. BMR ${num(t.bmr)} at ${t.weight_kg}kg.</span>`);
  }
  if (t.protein_target) {
    line(`<span><b>${t.protein_target}g protein</b> (${state.athlete.protein_g_per_kg}g/kg) across 4–5 doses of ${state.athlete.protein_min_per_meal_g}g+.</span>`);
  }

  if (ride) {
    const rate = F.carbRate(ride.duration_min, F.rideIntensity(ride, state.athlete), state.athlete);
    if (rate) {
      line(`<span><b>On the bike: ${rate.low}–${rate.high}g carbs/hr</b> over ${rate.hours.toFixed(1)}h — ${rate.total_low}–${rate.total_high}g total.</span>`);
      if (rate.needsBlend) line(`<span>⚠️ ${rate.blendNote}</span>`);
    }
    line(`<span><b>Pre:</b> ${t.day.type === 'high' ? '120–170g' : '80–120g'} carbs in the 3h before. <b>Post:</b> 30–40g protein within an hour.</span>`);
  } else if (t.day.type === 'rest') {
    line(`<span><b>Rest day.</b> Carbs moderate (~200–250g), spread evenly. Hold protein at target.</span>`);
  }
}

// ---------- confounders ----------

function renderConfounders() {
  const box = $('#confounders');
  box.innerHTML = '';
  const day = today();
  for (const c of state.athlete.confounders) {
    const on = (day.confounders || []).includes(c.id);
    const chip = el('button', 'chip' + (on ? ' on' : ''), c.label);
    chip.onclick = () => {
      const set = new Set(day.confounders || []);
      set.has(c.id) ? set.delete(c.id) : set.add(c.id);
      saveDay({ ...day, confounders: [...set] });
    };
    box.appendChild(chip);
  }
}

// ============ charts (hand-rolled SVG, no dependencies) ============

const PAD = { l: 34, r: 12, t: 10, b: 22 };

function svgFrame(w, h) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('role', 'img');
  return s;
}
function node(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
function gridlines(svg, w, h, yMin, yMax, fmt, steps = 4) {
  for (let i = 0; i <= steps; i++) {
    const v = yMin + ((yMax - yMin) * i) / steps;
    const y = h - PAD.b - ((v - yMin) / (yMax - yMin)) * (h - PAD.t - PAD.b);
    svg.appendChild(node('line', { x1: PAD.l, x2: w - PAD.r, y1: y, y2: y, stroke: 'var(--border)', 'stroke-width': 1 }));
    svg.appendChild(node('text', { x: PAD.l - 6, y: y + 3.5, 'text-anchor': 'end', fill: 'var(--txt3)', 'font-size': 9 }, fmt(v)));
  }
}

function renderWeight() {
  const box = $('#weight-chart');
  box.innerHTML = '';
  const raw = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
  if (raw.length < 2) { box.appendChild(el('p', 'muted small', 'Need at least two weigh-ins to draw a trend.')); return; }

  const roll = F.rollingWeight(state.weights);
  const rate = F.weightTrendRate(roll);
  $('#weight-rate').textContent = rate == null ? 'trend needs denser weighing' : `${rate >= 0 ? '+' : '−'}${Math.abs(rate).toFixed(2)} kg/wk`;

  const w = 640, h = 250;
  const BOT = 40; // room for the date row and the confounder rug beneath it
  const svg = svgFrame(w, h);
  const goal = state.athlete.goal_weight_kg;

  // Scale to the weight data only. Pinning the goal into the domain squashes months of
  // real movement into the top centimetre of the chart when the goal is still 5kg away.
  const all = raw.map((r) => r.kg).concat(roll.map((r) => r.kg));
  let yMin = Math.floor((Math.min(...all) - 0.6) * 2) / 2;
  let yMax = Math.ceil((Math.max(...all) + 0.6) * 2) / 2;
  const goalInView = goal >= yMin && goal <= yMax;
  if (goalInView) { yMin = Math.min(yMin, goal - 0.4); }

  const t0 = F.parseISO(raw[0].date).getTime(), t1 = F.parseISO(raw[raw.length - 1].date).getTime();
  const X = (d) => PAD.l + ((F.parseISO(d).getTime() - t0) / Math.max(1, t1 - t0)) * (w - PAD.l - PAD.r);
  const Y = (kg) => h - BOT - ((kg - yMin) / (yMax - yMin)) * (h - PAD.t - BOT);

  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    svg.appendChild(node('line', { x1: PAD.l, x2: w - PAD.r, y1: Y(v), y2: Y(v), stroke: 'var(--border)', 'stroke-width': 1 }));
    svg.appendChild(node('text', { x: PAD.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', fill: 'var(--txt3)', 'font-size': 9 }, v.toFixed(1)));
  }

  if (goalInView) {
    svg.appendChild(node('line', { x1: PAD.l, x2: w - PAD.r, y1: Y(goal), y2: Y(goal), stroke: 'var(--s3)', 'stroke-width': 2, 'stroke-dasharray': '5 4', opacity: .85 }));
    svg.appendChild(node('text', { x: w - PAD.r, y: Y(goal) - 5, 'text-anchor': 'end', fill: 'var(--s3)', 'font-size': 10, 'font-weight': 600 }, `goal ${goal}kg`));
  } else {
    // goal is off-scale — say so at the axis foot rather than distorting the chart
    const gap = (Math.min(...all) - goal).toFixed(1);
    svg.appendChild(node('text', { x: w - PAD.r, y: h - BOT + 12, 'text-anchor': 'end', fill: 'var(--s3)', 'font-size': 10, 'font-weight': 600 }, `goal ${goal}kg — ${gap}kg below this scale`));
  }

  // rolling average — the primary read
  if (roll.length >= 2) {
    const d = roll.map((r, i) => `${i ? 'L' : 'M'}${X(r.date).toFixed(1)},${Y(r.kg).toFixed(1)}`).join(' ');
    svg.appendChild(node('path', { d, fill: 'none', stroke: 'var(--s1)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }

  // raw points, secondary
  for (const r of raw) {
    const c = node('circle', { cx: X(r.date), cy: Y(r.kg), r: 4, fill: 'var(--surface)', stroke: 'var(--s1)', 'stroke-width': 2 });
    c.appendChild(node('title', {}, `${r.date}: ${r.kg}kg`));
    svg.appendChild(c);
    // confounder marker
    const flags = state.logs[r.date]?.confounders || [];
    if (flags.length) {
      const m = node('rect', { x: X(r.date) - 3, y: h - 12, width: 6, height: 6, rx: 1.5, fill: 'var(--s2)' });
      m.appendChild(node('title', {}, `${r.date}: ${flags.join(', ')}`));
      svg.appendChild(m);
    }
  }

  // date ends, sitting above the confounder rug
  svg.appendChild(node('text', { x: PAD.l, y: h - BOT + 26, fill: 'var(--txt3)', 'font-size': 9 }, shortDate(raw[0].date)));
  svg.appendChild(node('text', { x: w - PAD.r, y: h - BOT + 26, 'text-anchor': 'end', fill: 'var(--txt3)', 'font-size': 9 }, shortDate(raw[raw.length - 1].date)));

  box.appendChild(svg);
  box.appendChild(el('div', 'legend', `
    <span><i style="background:var(--s1);height:2px;border-radius:1px"></i>7-day average</span>
    <span><i style="background:transparent;border:2px solid var(--s1);border-radius:50%"></i>Weigh-in</span>
    <span><i style="background:var(--s2)"></i>Confounder flagged</span>`));

  const note = $('#weight-note');
  if (roll.length < 2) {
    note.hidden = false;
    note.innerHTML = `<b>No rolling average line yet.</b> A 7-day average needs at least ${F.ROLLING_MIN_POINTS} weigh-ins inside a 7-day window. You have ${raw.length} readings spread over ${F.daysBetween(raw[0].date, raw[raw.length - 1].date)} days, so only the raw points are drawn. Weigh most mornings for a fortnight and the trend line appears.`;
  } else { note.hidden = true; }
}

function shortDate(iso) { return localDate(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }

function renderCalChart() {
  const box = $('#cal-chart');
  box.innerHTML = '';
  const dates = recentDates(14).reverse();
  const rows = dates.map((d) => {
    const t = F.targetsFor(d, ctx());
    return { date: d, intake: F.dayTotals(state.logs[d]?.entries || []).kcal, target: t.kcal_target, logged: (state.logs[d]?.entries || []).length > 0 };
  });
  if (!rows.some((r) => r.logged)) { box.appendChild(el('p', 'muted small', 'No days logged in the last fortnight.')); return; }

  const w = 640, h = 220;
  const svg = svgFrame(w, h);

  // Scale to the bulk of the fortnight, not to its single biggest day. A five-hour ride
  // can carry a 5,000 kcal target, and pinning the axis to that squashes the other
  // thirteen days into the bottom third — losing the only thing the chart is for, which
  // is how each day sat against its own target. Anything above the top is drawn clipped
  // with a caret, so the outlier is still visible and obviously off-scale.
  const spread = rows.flatMap((r) => [r.logged ? r.intake : 0, r.target || 0]).filter((v) => v > 0);
  const yMax = Math.max(3200, F.percentile(spread, 0.9)) * 1.1;
  gridlines(svg, w, h, 0, yMax, (v) => (v / 1000).toFixed(1) + 'k');

  const bw = (w - PAD.l - PAD.r) / rows.length;
  let clipped = 0;
  rows.forEach((r, i) => {
    const x = PAD.l + i * bw;
    const H = (v) => Math.min(1, v / yMax) * (h - PAD.t - PAD.b);
    const caret = (cx, over) => {
      if (!over) return;
      clipped++;
      svg.appendChild(node('path', {
        d: `M${cx - 4},${PAD.t + 4} L${cx},${PAD.t - 1} L${cx + 4},${PAD.t + 4}`,
        fill: 'none', stroke: 'var(--txt3)', 'stroke-width': 1.5, 'stroke-linecap': 'round',
      }));
    };
    if (r.logged) {
      const over = r.target && r.intake > r.target;
      const bar = node('rect', {
        x: x + 2, y: h - PAD.b - H(r.intake), width: Math.max(3, bw - 4), height: Math.max(1, H(r.intake)),
        rx: 4, fill: over ? 'var(--s2)' : 'var(--s3)',
      });
      bar.appendChild(node('title', {}, `${r.date}: ${num(r.intake)} kcal vs target ${num(r.target)}`));
      svg.appendChild(bar);
      caret(x + bw / 2, r.intake > yMax);
    }
    if (r.target) {
      const line = node('line', {
        x1: x + 1, x2: x + bw - 1, y1: h - PAD.b - H(r.target), y2: h - PAD.b - H(r.target),
        stroke: 'var(--txt2)', 'stroke-width': 2, 'stroke-linecap': 'round',
        ...(r.target > yMax ? { 'stroke-dasharray': '3 3' } : {}),
      });
      line.appendChild(node('title', {}, `${r.date}: target ${num(r.target)} kcal`));
      svg.appendChild(line);
      caret(x + bw / 2, r.target > yMax);
    }
    if (i % 2 === 0) svg.appendChild(node('text', { x: x + bw / 2, y: h - 5, 'text-anchor': 'middle', fill: 'var(--txt3)', 'font-size': 9 }, localDate(r.date).getDate()));
  });

  box.appendChild(svg);
  $('#cal-legend').innerHTML = `
    <span><i style="background:var(--s3)"></i>At or under target</span>
    <span><i style="background:var(--s2)"></i>Over target</span>
    <span><i style="background:var(--txt2);height:2px;border-radius:1px"></i>Target</span>
    ${clipped ? '<span><i style="background:transparent">↑</i>Above the scale — big day, hover for the number</span>' : ''}`;
}

function renderProteinChart() {
  const box = $('#protein-chart');
  box.innerHTML = '';
  const dates = recentDates(14).reverse();
  const rows = dates.map((d) => ({
    date: d,
    p: F.dayTotals(state.logs[d]?.entries || []).protein,
    target: F.targetsFor(d, ctx()).protein_target,
    logged: (state.logs[d]?.entries || []).length > 0,
  }));
  if (!rows.some((r) => r.logged)) { box.appendChild(el('p', 'muted small', 'No days logged in the last fortnight.')); return; }

  const w = 640, h = 180;
  const svg = svgFrame(w, h);
  const yMax = Math.max(200, ...rows.map((r) => Math.max(r.p, r.target || 0))) * 1.1;
  gridlines(svg, w, h, 0, yMax, (v) => Math.round(v) + 'g', 3);

  const bw = (w - PAD.l - PAD.r) / rows.length;
  rows.forEach((r, i) => {
    const x = PAD.l + i * bw;
    const H = (v) => (v / yMax) * (h - PAD.t - PAD.b);
    if (r.logged) {
      const bar = node('rect', {
        x: x + 2, y: h - PAD.b - H(r.p), width: Math.max(3, bw - 4), height: Math.max(1, H(r.p)),
        rx: 4, fill: r.target && r.p >= r.target ? 'var(--s1)' : 'var(--txt3)',
      });
      bar.appendChild(node('title', {}, `${r.date}: ${num(r.p)}g of ${r.target}g`));
      svg.appendChild(bar);
    }
    if (r.target) svg.appendChild(node('line', { x1: x + 1, x2: x + bw - 1, y1: h - PAD.b - H(r.target), y2: h - PAD.b - H(r.target), stroke: 'var(--txt2)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    if (i % 2 === 0) svg.appendChild(node('text', { x: x + bw / 2, y: h - 5, 'text-anchor': 'middle', fill: 'var(--txt3)', 'font-size': 9 }, localDate(r.date).getDate()));
  });
  box.appendChild(svg);
}

function renderTable() {
  const dates = recentDates(14);
  const rows = dates.map((d) => {
    const t = F.targetsFor(d, ctx());
    const tot = F.dayTotals(state.logs[d]?.entries || []);
    const logged = (state.logs[d]?.entries || []).length > 0;
    return { d, t, tot, logged, deficit: logged && t.tdee ? t.tdee - tot.kcal : null };
  });
  $('#day-table').innerHTML = `<table>
    <thead><tr><th>Day</th><th>Type</th><th>In</th><th>Target</th><th>TDEE</th><th>Deficit</th><th>P</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${shortDate(r.d)}</td>
      <td>${r.t.day.type}</td>
      <td>${r.logged ? num(r.tot.kcal) : '—'}</td>
      <td>${num(r.t.kcal_target)}</td>
      <td>${num(r.t.tdee)}</td>
      <td>${r.deficit == null ? '—' : signed(r.deficit)}</td>
      <td>${r.logged ? num(r.tot.protein) : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------- settings ----------

function renderSettings() {
  const a = state.athlete;
  const w = F.weightOn(state.date, state.weights);
  $('#settings').innerHTML = `
    <div class="ref">
      <li>Weight <span>${w ? `${w.kg}kg (${w.date})` : '—'}</span></li>
      <li>BMR (Mifflin-St Jeor) <span>${w ? num(F.bmr(w.kg, a.height_cm, a.age)) : '—'} kcal</span></li>
      <li>Base TDEE (×${a.activity_factor}) <span>${w ? num(F.baseTDEE(w.kg, a)) : '—'} kcal</span></li>
      <li>Planned deficit <span>${a.planned_deficit_kcal} kcal/day</span></li>
      <li>Protein <span>${a.protein_g_per_kg}g/kg → ${w ? Math.round(a.protein_g_per_kg * w.kg) : '—'}g</span></li>
      <li>Goal <span>${a.goal_weight_kg}kg</span></li>
      <li>Pending writes <span>${S.pendingCount()}</span></li>
    </div>
    <h3 style="margin-top:18px">Diagnostics</h3>
    <p class="muted small">What the sync machinery has actually done on this device — writes, reads,
    the parse watcher, errors. Newest first. If an entry ever gets stuck estimating again, this is
    the evidence: copy it before reloading.</p>
    <pre id="debug-log" class="small" style="max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:var(--card,rgba(128,128,128,.08));border-radius:8px;padding:10px;font-size:11px;line-height:1.5">${escapeHtml([...S.dbgLines()].reverse().join('\n') || 'Nothing recorded yet.')}</pre>
    <button id="copy-debug" class="link-btn">Copy diagnostics</button>
    <button id="signout" class="btn-primary" style="margin-top:14px;background:var(--bad)">Remove token from this device</button>`;
  $('#copy-debug').onclick = async () => {
    try {
      await navigator.clipboard.writeText(S.dbgLines().join('\n'));
      $('#copy-debug').textContent = 'Copied';
      setTimeout(() => { const b = $('#copy-debug'); if (b) b.textContent = 'Copy diagnostics'; }, 1500);
    } catch {
      // Clipboard needs a secure context and a user gesture; if it refuses, the text is
      // right there in the box to select by hand.
      $('#copy-debug').textContent = 'Copy failed — select the text above';
    }
  };
  $('#signout').onclick = () => {
    // Say what actually goes. This wipes the local copy of the log, not just the token.
    const unsynced = S.unsyncedSummary();
    const warn = unsynced.length
      ? `\n\n⚠️ ${unsynced.length} change${unsynced.length === 1 ? '' : 's'} on this phone ${unsynced.length === 1 ? 'has' : 'have'} NOT reached GitHub yet and will be lost:\n${unsynced.map((m) => '• ' + m).join('\n')}`
      : '';
    const msg =
      'Sign out of this device?\n\nThis deletes the token AND the local copy of your food log, ' +
      'weight history and workouts from this phone. Everything already synced stays safe in ' +
      'the private repo and comes back when you paste the token again.' + warn;
    if (!confirm(msg)) return;
    const { cachedFiles } = S.clearToken();
    console.info(`Cleared token, ${cachedFiles} cached files and the write queue.`);
    location.reload();
  };
}

// ============ logging ============

/**
 * Open the log sheet. Pass an entry to edit it in place instead of adding a new one —
 * without this the only way to fix a portion, a time, or a food the parser choked on was
 * to delete it and type the whole thing again.
 */
function openSheet(entry = null) {
  state.editing = entry ? entry.id : null;
  const now = new Date();
  $('#entry-time').value = entry
    ? entry.time
    : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  renderTiles();

  const custom = { '#c-label': entry?.label ?? '', '#c-kcal': entry?.kcal || '',
    '#c-protein': entry?.protein || '', '#c-carbs': entry?.carbs || '', '#c-fat': entry?.fat || '' };
  for (const [sel, v] of Object.entries(custom)) $(sel).value = v;

  $('#sheet-title').textContent = entry ? 'Edit' : 'Log';
  $('#c-save').textContent = entry ? 'Save changes' : 'Add';
  // Editing always uses the custom pane — the tile grids only make sense for adding. Show
  // it without recording it as his choice, or one edit silently changes which tab the Log
  // button opens on from then on.
  showTab(entry ? 'custom' : state.pendingTab);
  $$('.seg').forEach((s) => (s.hidden = !!entry));

  $('#sheet').hidden = false;
}

function showTab(tab) {
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  ['meals', 'singles', 'custom'].forEach((t) => { $('#sheet-' + t).hidden = t !== tab; });
}

/** He picked this one, so remember it for next time. */
function selectTab(tab) {
  state.pendingTab = tab;
  showTab(tab);
}

function closeSheet() { $('#sheet').hidden = true; state.editing = null; }

function renderTiles() {
  const grid = $('#sheet-meals');
  grid.innerHTML = '';
  for (const m of state.templates.meals) {
    const t = el('button', 'tile');
    t.innerHTML = `<span class="t-emoji">${m.emoji || '🍽'}</span>
      <span class="t-label">${escapeHtml(m.label)}</span>
      <span class="t-macros">${m.kcal} · ${m.protein}P</span>
      ${m.source === 'estimate' ? '<span class="t-est">est</span>' : ''}`;
    t.onclick = () => addEntry(m, 'template');
    grid.appendChild(t);
  }

  const list = $('#sheet-singles');
  list.innerHTML = '';
  for (const s of state.templates.singles) {
    const b = el('button');
    b.innerHTML = `<span>${escapeHtml(s.label)}${s.source === 'estimate' ? ' <em style="color:var(--warn);font-style:normal">est</em>' : ''}</span>
      <span>${s.kcal} kcal · ${s.protein}P · ${s.carbs}C · ${s.fat}F</span>`;
    b.onclick = () => addEntry(s, 'single');
    list.appendChild(b);
  }
}

function addEntry(item, source) {
  const day = today();
  const entry = {
    id: Math.random().toString(36).slice(2, 8),
    time: $('#entry-time').value || '12:00',
    label: item.label,
    kcal: item.kcal, protein: item.protein, carbs: item.carbs, fat: item.fat,
    source, note: item.detail || '',
  };
  saveDay({ ...day, entries: [...day.entries, entry].sort((a, b) => a.time.localeCompare(b.time)) });
  closeSheet();
}

/**
 * Fold a synchronous estimate into the entry it was made for. Mirrors `apply()` in
 * parse.py — same fields, same precedence — so an entry looks identical whichever path
 * resolved it. Returns null if the estimate is not usable, which sends it to the fallback.
 */
function applyEstimate(entry, r) {
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  if (!r || n(r.kcal) == null || n(r.protein) == null || n(r.carbs) == null || n(r.fat) == null) return null;
  const { parse_state, parse_error, parse_attempts, logged_at, ...rest } = entry;
  return {
    ...rest,
    label: r.label || entry.label,
    kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat,
    source: 'parsed',
    confidence: r.confidence || 'medium',
    note: r.assumption || '',
  };
}

async function addCustom() {
  const label = $('#c-label').value.trim();
  if (!label) return;
  const kcal = Number($('#c-kcal').value) || 0;
  const day = today();
  const time = $('#entry-time').value || '12:00';
  const editingId = state.editing;
  const id = editingId || Math.random().toString(36).slice(2, 8);

  let entry;
  if (kcal) {
    // Macros typed in by hand — take them as given.
    entry = {
      id, time, label, kcal,
      protein: Number($('#c-protein').value) || 0,
      carbs: Number($('#c-carbs').value) || 0,
      fat: Number($('#c-fat').value) || 0,
      source: 'manual', note: '',
    };
  } else {
    // No macros: try Matt's own food list on-device first. Instant, free, offline, and it
    // resolves most of what he actually types because his eating is repetitive.
    const hit = F.matchEntry(label, state.templates);
    entry = hit
      ? { id, time, label: hit.label, kcal: hit.kcal, protein: hit.protein, carbs: hit.carbs,
          fat: hit.fat, source: 'matched', note: hit.anyEstimate ? 'includes an estimated item' : '' }
      : { id, time, label, kcal: 0, protein: 0, carbs: 0, fat: 0,
          // Stamped so the UI can tell a spinner that is 5 seconds old from one that is
          // three minutes old. The clock time alone cannot: he backdates entries.
          source: 'freetext', parse_state: 'pending', note: '', logged_at: Date.now() };
  }

  // Editing replaces in place and keeps the id, so the parser and the merge both still
  // recognise it as the same entry rather than resurrecting the old one alongside it.
  const rest = editingId ? day.entries.filter((x) => x.id !== editingId) : day.entries;
  const withEntry = (e) => [...rest, e].sort((a, b) => a.time.localeCompare(b.time));

  ['#c-label', '#c-kcal', '#c-protein', '#c-carbs', '#c-fat'].forEach((s) => ($(s).value = ''));
  closeSheet();

  if (entry.source !== 'freetext') {
    await saveDay({ ...day, entries: withEntry(entry) });
    return;
  }

  // Free text: try to resolve it here and now, and commit once, already parsed.
  //
  // The row goes on screen immediately so the tap feels instant, but nothing is queued for
  // GitHub until the estimate lands. Cost of that: an entry logged and then killed inside
  // the ~2 second window is lost. It is also never half-written, which the alternative
  // (queue now, rewrite later) cannot promise — and that half-written state, discovered by
  // polling, is the bug this whole change exists to delete.
  await saveDay({ ...day, entries: withEntry(entry) }, { commit: false });

  const results = await S.parseText([{ id, date: day.date, time, text: label }]);
  const resolved = applyEstimate(entry, results?.find((r) => r.id === id));

  // Re-read the day: a refresh or another edit may have moved underneath us while waiting.
  const current = state.logs[day.date] || { ...day, entries: withEntry(entry) };
  const entries = (current.entries || []).map((e) => (e.id === id ? (resolved || entry) : e));
  await saveDay({ ...current, date: day.date, entries });

  if (resolved) {
    S.dbg(`entry ${id} parsed synchronously (${resolved.kcal} kcal, ${resolved.confidence})`);
  } else {
    // Committed as pending, exactly as before the Worker existed: the push fires
    // parse.yml, and the watcher picks the result up.
    S.dbg(`entry ${id} fell back to the async parser`);
    watchForParse();
  }
}

// ---------- waiting on the parser ----------
//
// One watcher for the whole app, not one per tap. An entry routinely outlives the tap that
// created it: iOS suspends timers the moment the phone is locked, so a write can sit unsent
// for minutes. The first real free-text entry took eleven minutes to leave the phone and
// twenty-two seconds to parse — a per-tap poll counting from the tap had long since expired
// and left both entries spinning forever.

const PARSE_WINDOW_MS = 90000;
const PARSE_TICK_MS = 5000;
let parseTimer = null;
let parseDeadline = 0;
let tickInFlight = false;
let lastTickAt = 0;

/** Every loaded day still holding an entry the parser hasn't resolved. */
function datesAwaitingParse() {
  return Object.entries(state.logs)
    .filter(([, day]) => (day.entries || []).some((e) => e.source === 'freetext' && e.parse_state !== 'failed'))
    .map(([date]) => date);
}

/**
 * Start or extend the watch. The window is measured from the moment the write actually
 * leaves the phone, never from the tap — see the note above.
 */
function watchForParse(restart = true) {
  if (!datesAwaitingParse().length) return stopWatch();
  if (restart) parseDeadline = Date.now() + PARSE_WINDOW_MS;
  // A tick that is mid-await holds no timer, so without the in-flight check a restart
  // here would fork a second tick chain that then polls alongside the first forever.
  // The running tick always reschedules itself; extending the deadline is enough.
  if (!parseTimer && !tickInFlight) {
    lastTickAt = Date.now();
    parseTimer = setTimeout(parseTick, PARSE_TICK_MS);
  }
}

function stopWatch() {
  if (parseTimer) clearTimeout(parseTimer);
  parseTimer = null;
}

function reschedule(ms = PARSE_TICK_MS) {
  parseTimer = setTimeout(parseTick, ms);
}

// The tick must be impossible to kill. It used to have try/catch only around the fetch;
// anything else throwing — adopt, render, a data shape the UI chokes on — ended the
// chain with no reschedule, no error anywhere, and a spinner that spins until the app is
// reloaded. That is exactly the reported symptom, so now the whole body is guarded and
// every exit is recorded.
async function parseTick() {
  parseTimer = null;
  tickInFlight = true;
  try {
    // Direct evidence for the timer-throttling theory: a browser clamping this timer to
    // once a minute shows up here as a gap, where a dead watcher shows up as nothing.
    const gap = Date.now() - lastTickAt;
    if (gap > PARSE_TICK_MS * 3) S.dbg(`parse tick: ran ${Math.round(gap / 1000)}s after the last one — timer throttled?`);
    lastTickAt = Date.now();

    if (!datesAwaitingParse().length) return;

    // A queued write means the entry has not reached GitHub yet, so there is nothing to
    // find. Hold the deadline open rather than spending the window waiting on ourselves.
    if (S.pendingCount()) {
      S.dbg(`parse tick: ${S.pendingCount()} write(s) still queued, holding window open`);
      parseDeadline = Date.now() + PARSE_WINDOW_MS;
      return reschedule();
    }

    let changed = false;
    for (const m of new Set(datesAwaitingParse().map((d) => d.slice(0, 7)))) {
      const path = S.paths.month(m + '-01');
      let got;
      try { got = await S.peekJSON(path); } catch (e) { S.dbg(`parse tick: peek ${path} threw — ${e?.message || e}`); continue; }
      if (!got) continue;

      // A write queued while that fetch was in flight makes the response stale the instant
      // it arrives. Adopting it would overwrite the entry just logged, and the queued job
      // would then push the overwritten file. Drop it and come back next tick.
      if (S.pendingCount()) return reschedule();

      // Only worth a log line when the file actually moved — that one line separates
      // "the watcher polled and GitHub kept serving the pre-parse copy" from "the
      // watcher never looked at all", which no amount of repo archaeology could do.
      const before = S.cachedSha(path);
      if (got.sha !== before) S.dbg(`parse tick: ${path} changed ${String(before).slice(0, 7)} → ${got.sha.slice(0, 7)}, adopting`);

      S.adopt(path, got.value, got.sha);
      state.months[m] = got.value;
      for (const [d, day] of Object.entries(got.value.days || {})) {
        state.logs[d] = { date: d, entries: [], confounders: [], notes: '', ...day };
      }
      changed = true;
    }
    if (!datesAwaitingParse().length) {
      S.dbg('parse tick: resolved, stopping watch');
      if (changed) render();
      return stopWatch();
    }

    // A rate-limited GitHub refuses reads for ~10 minutes, which is longer than the
    // whole watch window — the first real incident burned all 18 ticks on 403s and then
    // expired, leaving a spinner over an entry that had been parsed for ages. Refused
    // reads must not count against the window: hold it open until the limiter clears,
    // and poll gently, because hammering a secondary limit extends the ban.
    const limitedUntil = S.rateLimitedUntil();
    if (limitedUntil) {
      if (parseDeadline < limitedUntil) {
        S.dbg(`parse tick: rate-limited, backing off to 60s ticks until ~${new Date(limitedUntil).toLocaleTimeString()}`);
        parseDeadline = limitedUntil + PARSE_WINDOW_MS;
      }
      render();
      return reschedule(60000);
    }

    // Re-render even when nothing arrived, so the "still estimating after Ns" counter is
    // honest about how long he has actually been waiting.
    render();
    if (Date.now() < parseDeadline) reschedule();
    else S.dbg('parse tick: window expired with entries still pending');
  } catch (e) {
    S.dbg(`parse tick: THREW — ${e?.message || e}`);
    if (datesAwaitingParse().length && Date.now() < parseDeadline) reschedule();
  } finally {
    tickInFlight = false;
  }
}

// ---------- staying current with the deployed build ----------
//
// Every fix so far has landed with "reload the tab" attached to it, and an installed PWA
// is resumed rather than reloaded, so it can run week-old code indefinitely while looking
// perfectly healthy. The app should not need a human to notice it is out of date.
//
// GitHub Pages serves an ETag on app.js. A HEAD against it is a few bytes, does not touch
// the GitHub API and so cannot affect the rate limit. If the tag has moved, a new build is
// live and this one is stale.

let buildTag = null;

async function readBuildTag() {
  try {
    const res = await fetch('./app.js', { method: 'HEAD', cache: 'no-store' });
    return res.headers.get('etag') || res.headers.get('last-modified') || null;
  } catch {
    return null;
  }
}

async function checkForNewBuild() {
  const tag = await readBuildTag();
  if (!tag || !buildTag || tag === buildTag) return false;
  // Never reload out from under an unsent write or a half-typed entry. The queue survives
  // a reload, but losing what he is mid-way through typing would be its own bug.
  if (S.pendingCount() || !$('#sheet').hidden) {
    S.dbg(`new build ${tag} seen but not reloading (queue or sheet open)`);
    return false;
  }
  S.dbg(`new build ${tag} (was ${buildTag}), reloading`);
  location.reload();
  return true;
}

// ---------- staying current with the repo ----------
//
// The app used to read the log exactly once, at boot, and never again. A desktop tab left
// open all day therefore showed a snapshot from whenever it was opened: entries logged on
// the phone simply never appeared, and it looked like the phone had failed to save them.
// Worse, writing from that stale tab pushed a month file missing everything the phone had
// added, and only the conflict merge stopped it being a real data loss.
//
// Refresh is deliberately narrow — the log and the weight log, the two things that change
// from another device. The profile, templates and sync files change rarely and are not
// worth spending a request on every time a window regains focus.

const REFRESH_MIN_GAP_MS = 60000;
let lastRefresh = 0;

/**
 * The "check now" tap on a stuck row. `refreshData` alone refuses to read while a write
 * is queued — correct in general, but it made the one button offered to an anxious user
 * a silent no-op exactly when a stuck write was the problem. Flush first, then read.
 */
async function recheckNow() {
  S.dbg(`recheck tapped (${S.pendingCount()} queued)`);
  await flush();
  await refreshData({ force: true });
  watchForParse(true);
}

async function refreshData({ force = false } = {}) {
  if (!force && Date.now() - lastRefresh < REFRESH_MIN_GAP_MS) return false;
  // Never read over the top of a write that has not been sent yet.
  if (S.pendingCount()) {
    if (force) S.dbg(`refresh skipped: ${S.pendingCount()} write(s) still queued`);
    return false;
  }
  lastRefresh = Date.now();

  const monthKeys = new Set([state.date.slice(0, 7), F.isoDate(new Date()).slice(0, 7)]);
  let changed = false;

  for (const m of monthKeys) {
    const path = S.paths.month(m + '-01');
    let got;
    try { got = await S.peekJSON(path); } catch { continue; }
    if (!got || S.pendingCount()) continue;      // a write landed mid-fetch — leave it alone
    if (JSON.stringify(state.months[m]) === JSON.stringify(got.value)) continue;
    S.adopt(path, got.value, got.sha);
    state.months[m] = got.value;
    for (const [d, day] of Object.entries(got.value.days || {})) {
      state.logs[d] = { date: d, entries: [], confounders: [], notes: '', ...day };
    }
    changed = true;
  }

  try {
    const w = await S.peekJSON(S.paths.weight);
    if (w && !S.pendingCount() && JSON.stringify(w.value) !== JSON.stringify(state.weights)) {
      S.adopt(S.paths.weight, w.value, w.sha);
      state.weights = w.value;
      changed = true;
    }
  } catch { /* the log matters more; a stale weight is visible in the UI anyway */ }

  if (changed) { S.dbg(`refresh: remote changes adopted${force ? ' (forced)' : ''}`); render(); }
  return changed;
}

/**
 * Called when the app comes back to the foreground. Flushes anything the suspended timer
 * failed to send, pulls in whatever another device logged while this one was away, then
 * reopens the parse window.
 *
 * `visibilitychange` and `focus` both fire on the same foregrounding, a few ms apart.
 * Unguarded, that ran two flushes over the same queue concurrently: the second PUT hit a
 * sha conflict with the first, triggered a pointless merge round-trip, and on a slow
 * link could keep the queue non-empty long enough to stall the parse watcher.
 */
let resuming = false;
async function resume() {
  if (resuming) return;
  resuming = true;
  try {
    S.dbg(`resume (${document.visibilityState}, ${S.pendingCount()} queued)`);
    if (await checkForNewBuild()) return;   // reloading; nothing else is worth starting
    await flush();
    await refreshData();
    watchForParse(true);
  } catch (e) {
    S.dbg(`resume: THREW — ${e?.message || e}`);
  } finally {
    resuming = false;
  }
}

/** Reads whichever weigh-in box has a value — Today and Trends both have one. */
function logWeight() {
  const boxes = ['#weight-input-today', '#weight-input'].map((s) => $(s)).filter(Boolean);
  const box = boxes.find((b) => b.value !== '');
  const kg = Number(box?.value);
  if (!kg || kg < 40 || kg > 200) return;
  const weights = [...state.weights.filter((w) => w.date !== state.date), { date: state.date, kg }]
    .sort((a, b) => a.date.localeCompare(b.date));
  state.weights = weights;
  S.queueWrite(S.paths.weight, weights, `weight: ${state.date} ${kg}kg`);
  boxes.forEach((b) => (b.value = ''));
  render();
  flush();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

boot();
