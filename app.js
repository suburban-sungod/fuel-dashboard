import * as F from './fuel.js';
import * as S from './store.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
const signed = (n) => (n == null ? '—' : (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)).toLocaleString());

const state = {
  athlete: null, weights: [], templates: { meals: [], singles: [] },
  workouts: [], planned: [], logs: {},
  date: F.isoDate(new Date()), view: 'today', pendingTab: 'meals',
};

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
  wire();
  render();
  flush();
  setInterval(flush, 60000);
  window.addEventListener('online', flush);
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
  const [athlete, weights, templates, workouts, planned] = await Promise.all([
    S.readJSON(S.paths.athlete),
    S.readJSON(S.paths.weight, []),
    S.readJSON(S.paths.templates, { meals: [], singles: [] }),
    S.readJSON(S.paths.workouts, []),
    S.readJSON(S.paths.planned, []),
  ]);
  Object.assign(state, { athlete, weights, templates, workouts, planned });
  await loadDays(F.weekDates(state.date).concat(recentDates(21)));
}

function recentDates(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(F.addDays(state.date, -i));
  return out;
}

async function loadDays(dates) {
  const uniq = [...new Set(dates)];
  await Promise.all(uniq.map(async (d) => {
    if (state.logs[d]) return;
    state.logs[d] = (await S.readJSON(S.paths.day(d), null)) || { date: d, entries: [], confounders: [], notes: '' };
  }));
}

async function flush() {
  const before = S.pendingCount();
  if (before) {
    const { flushed } = await S.flushQueue(S.mergeDay);
    if (flushed) renderSyncBar();
  }
  renderSyncBar();
}

function ctx() {
  return { athlete: state.athlete, weights: state.weights, workouts: state.workouts, planned: state.planned };
}

function today() { return state.logs[state.date] || { date: state.date, entries: [], confounders: [] }; }

function saveDay(day) {
  state.logs[day.date] = day;
  S.queueWrite(S.paths.day(day.date), day, `log: ${day.date}`);
  render();
  flush();
}

// ============ wiring ============

function wire() {
  $('#day-prev').onclick = async () => { state.date = F.addDays(state.date, -1); await loadDays([state.date]); render(); };
  $('#day-next').onclick = async () => { state.date = F.addDays(state.date, 1); await loadDays([state.date]); render(); };
  $('#day-today').onclick = () => { state.date = F.isoDate(new Date()); render(); };

  $$('.tab').forEach((b) => b.onclick = () => { state.view = b.dataset.view; render(); });
  $('#add-entry').onclick = openSheet;
  $('#toggle-table').onclick = () => { const t = $('#day-table'); t.hidden = !t.hidden; };
  $('#weight-save').onclick = logWeight;

  $$('[data-close]').forEach((n) => n.onclick = closeSheet);
  $$('.seg-btn').forEach((b) => b.onclick = () => {
    state.pendingTab = b.dataset.tab;
    $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    ['meals', 'singles', 'custom'].forEach((t) => { $('#sheet-' + t).hidden = t !== b.dataset.tab; });
  });
  $('#c-save').onclick = addCustom;
}

// ============ render ============

function render() {
  const isToday = state.date === F.isoDate(new Date());
  $('#day-label').textContent = isToday ? 'Today' : new Date(state.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  $('#day-today').hidden = isToday;
  $('#day-next').disabled = state.date >= F.isoDate(new Date());

  ['today', 'trends', 'ref'].forEach((v) => { $('#view-' + v).hidden = state.view !== v; });
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));

  if (state.view === 'today') { renderHero(); renderToday(); renderEntries(); renderPlan(); renderConfounders(); }
  if (state.view === 'trends') { renderWeight(); renderCalChart(); renderProteinChart(); renderTable(); }
  if (state.view === 'ref') renderSettings();
  renderSyncBar();
}

function renderSyncBar() {
  const bar = $('#sync-bar');
  const p = S.pendingCount();
  if (p) {
    bar.hidden = false;
    bar.className = 'sync-bar pending';
    bar.textContent = `${p} ${p === 1 ? 'change' : 'changes'} saved on this phone, waiting to sync`;
  } else {
    const t = S.lastSync();
    bar.hidden = !t;
    bar.className = 'sync-bar';
    if (t) bar.textContent = `Synced ${timeAgo(t)}`;
  }
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------- hero: week-to-date deficit vs plan ----------

function renderHero() {
  const dates = F.weekDates(state.date);
  const realToday = F.isoDate(new Date());
  const wk = F.cumulativeDeficit(dates, ctx(), state.logs, realToday);

  const n = $('#hero-number');
  const cls = wk.loggedDays === 0 ? 'flat' : wk.variance >= 0 ? 'ahead' : 'behind';
  n.className = 'hero-number ' + cls;
  n.textContent = wk.loggedDays === 0 ? 'No closed days yet' : `${signed(wk.variance)} kcal`;

  $('#hero-week').textContent = `from Mon ${new Date(F.weekStart(state.date)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;

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
    b.appendChild(el('span', '', new Date(d.date).toLocaleDateString(undefined, { weekday: 'narrow' })));
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
  if (short.length) {
    add('warn', `<b>${short.length} ${short.length === 1 ? 'meal' : 'meals'} under ${state.athlete.protein_min_per_meal_g}g protein.</b> Distribution matters as much as the daily total — ${short.map((m) => hhmm(m.start)).join(', ')}.`);
  }

  const unparsed = today().entries.filter((e) => e.source === 'freetext');
  if (unparsed.length) {
    add('', `<b>${unparsed.length} unparsed ${unparsed.length === 1 ? 'entry' : 'entries'}.</b> Macros are missing until you run <code>/food-diary</code> at the Mac. Today's totals are understated.`);
  }

  if (t.activity_confidence === 'estimated' && t.activity_kcal) {
    add('', `<b>${num(t.activity_kcal)} kcal activity is estimated,</b> not measured — no power data for this session.`);
  }
}

function hhmm(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }

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
      const row = el('div', 'entry' + (e.source === 'freetext' ? ' unparsed' : ''));
      row.innerHTML = `<time>${e.time}</time>
        <div class="e-main">
          <div class="e-label">${escapeHtml(e.label)}</div>
          <div class="e-macros">${e.kcal ? `${num(e.kcal)} kcal · ${num(e.protein)}P · ${num(e.carbs)}C · ${num(e.fat)}F` : 'macros not parsed yet'}</div>
        </div>`;
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

// ---------- fuel plan ----------

function renderPlan() {
  const t = F.targetsFor(state.date, ctx());
  const box = $('#fuel-plan');
  box.innerHTML = '';
  const line = (h) => box.appendChild(el('div', 'flag', h));

  const src = t.workouts.filter((w) => !['strength', 'swim', 'other'].includes(w.type));
  const plan = t.planned.filter((p) => !['strength', 'swim', 'other'].includes(p.type));
  const ride = src[0] || plan[0];

  if (t.kcal_target) {
    line(`<span><b>${num(t.kcal_target)} kcal</b> target — ${num(t.base_tdee)} base + ${num(t.activity_kcal)} activity − ${num(t.planned_deficit)} deficit. BMR ${num(t.bmr)} at ${t.weight_kg}kg.</span>`);
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

function shortDate(iso) { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }

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
  const yMax = Math.max(3200, ...rows.map((r) => Math.max(r.intake, r.target || 0))) * 1.05;
  gridlines(svg, w, h, 0, yMax, (v) => (v / 1000).toFixed(1) + 'k');

  const bw = (w - PAD.l - PAD.r) / rows.length;
  rows.forEach((r, i) => {
    const x = PAD.l + i * bw;
    const H = (v) => ((v / yMax) * (h - PAD.t - PAD.b));
    if (r.logged) {
      const over = r.target && r.intake > r.target;
      const bar = node('rect', {
        x: x + 2, y: h - PAD.b - H(r.intake), width: Math.max(3, bw - 4), height: Math.max(1, H(r.intake)),
        rx: 4, fill: over ? 'var(--s2)' : 'var(--s3)',
      });
      bar.appendChild(node('title', {}, `${r.date}: ${num(r.intake)} kcal vs target ${num(r.target)}`));
      svg.appendChild(bar);
    }
    if (r.target) {
      svg.appendChild(node('line', {
        x1: x + 1, x2: x + bw - 1, y1: h - PAD.b - H(r.target), y2: h - PAD.b - H(r.target),
        stroke: 'var(--txt2)', 'stroke-width': 2, 'stroke-linecap': 'round',
      }));
    }
    if (i % 2 === 0) svg.appendChild(node('text', { x: x + bw / 2, y: h - 5, 'text-anchor': 'middle', fill: 'var(--txt3)', 'font-size': 9 }, new Date(r.date).getDate()));
  });

  box.appendChild(svg);
  $('#cal-legend').innerHTML = `
    <span><i style="background:var(--s3)"></i>At or under target</span>
    <span><i style="background:var(--s2)"></i>Over target</span>
    <span><i style="background:var(--txt2);height:2px;border-radius:1px"></i>Target</span>`;
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
    if (i % 2 === 0) svg.appendChild(node('text', { x: x + bw / 2, y: h - 5, 'text-anchor': 'middle', fill: 'var(--txt3)', 'font-size': 9 }, new Date(r.date).getDate()));
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
    <button id="signout" class="btn-primary" style="margin-top:14px;background:var(--bad)">Remove token from this device</button>`;
  $('#signout').onclick = () => { if (confirm('Remove the token from this phone? Your data stays in the repo.')) { S.clearToken(); location.reload(); } };
}

// ============ logging ============

function openSheet() {
  const now = new Date();
  $('#entry-time').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  renderTiles();
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }

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

function addCustom() {
  const label = $('#c-label').value.trim();
  if (!label) return;
  const kcal = Number($('#c-kcal').value) || 0;
  const day = today();
  const entry = {
    id: Math.random().toString(36).slice(2, 8),
    time: $('#entry-time').value || '12:00',
    label,
    kcal, protein: Number($('#c-protein').value) || 0,
    carbs: Number($('#c-carbs').value) || 0, fat: Number($('#c-fat').value) || 0,
    source: kcal ? 'manual' : 'freetext', note: '',
  };
  saveDay({ ...day, entries: [...day.entries, entry].sort((a, b) => a.time.localeCompare(b.time)) });
  ['#c-label', '#c-kcal', '#c-protein', '#c-carbs', '#c-fat'].forEach((s) => ($(s).value = ''));
  closeSheet();
}

function logWeight() {
  const kg = Number($('#weight-input').value);
  if (!kg || kg < 40 || kg > 200) return;
  const weights = [...state.weights.filter((w) => w.date !== state.date), { date: state.date, kg }]
    .sort((a, b) => a.date.localeCompare(b.date));
  state.weights = weights;
  S.queueWrite(S.paths.weight, weights, `weight: ${state.date} ${kg}kg`);
  $('#weight-input').value = '';
  render();
  flush();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

boot();
