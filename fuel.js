// fuel.js — pure calculation. No DOM, no network, no globals.
// Everything the dashboard asserts about deficits, targets and trends is derived here.

export const KCAL_PER_KG_FAT = 7700;
export const MEAL_GAP_MIN = 45;
export const ROLLING_WINDOW_DAYS = 7;
export const ROLLING_MIN_POINTS = 3;

// ---------- dates ----------

export function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

/** Monday-start week containing `iso`. */
export function weekStart(iso) {
  const d = parseISO(iso);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(iso, -dow);
}

export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ---------- energy ----------

/** Mifflin-St Jeor, male. Returns BMR — resting only, NOT maintenance. */
export function bmr(kg, heightCm, age) {
  return 10 * kg + 6.25 * heightCm - 5 * age + 5;
}

/**
 * Sedentary base TDEE: BMR x activity factor. Exercise is added per-day on top,
 * never folded in here — folding it in is what makes a deficit look real when it isn't.
 */
export function baseTDEE(kg, athlete) {
  return bmr(kg, athlete.height_cm, athlete.age) * (athlete.activity_factor ?? 1.2);
}

/** Cycling kcal from average power. W x h x 3.6 = kJ, and kJ ~= kcal at ~25% gross efficiency. */
export function rideKcal(avgWatts, minutes) {
  if (!avgWatts || !minutes) return 0;
  return avgWatts * (minutes / 60) * 3.6;
}

/**
 * Exercise kcal for a date. Prefers measured power; falls back to the device's own
 * calorie figure, then to a flat estimate for strength work.
 */
export function activityKcal(workouts, athlete) {
  let total = 0;
  for (const w of workouts || []) {
    if (w.type === 'strength') {
      total += athlete.strength_kcal ?? 200;
    } else if (w.avg_watts && w.duration_min) {
      total += rideKcal(w.avg_watts, w.duration_min);
    } else if (w.calories) {
      total += w.calories;
    }
  }
  return Math.round(total);
}

/** How much of an activity figure is a real measurement vs a fallback guess. */
export function activityConfidence(workouts) {
  if (!workouts || !workouts.length) return 'none';
  if (workouts.every((w) => w.type === 'strength')) return 'estimated';
  return workouts.some((w) => w.avg_watts) ? 'measured' : 'estimated';
}

// ---------- day classification ----------

/** rest | moderate | high, from measured ride data where available, else the plan. */
export function dayType(workouts, planned) {
  const rides = (workouts || []).filter((w) => w.type !== 'strength');
  const src = rides.length ? rides : (planned || []).filter((p) => p.type !== 'strength');
  if (!src.length) return { type: 'rest', basis: workouts?.length ? 'strength only' : 'no activity' };

  const dur = src.reduce((s, w) => s + (w.duration_min || 0), 0);
  const tss = src.reduce((s, w) => s + (w.tss || 0), 0);
  const intensity = Math.max(...src.map((w) => w.if || 0));
  const basis = rides.length ? 'measured' : 'planned';

  if (dur < 30) return { type: 'rest', basis };
  if (tss >= 60 || intensity >= 0.8 || dur >= 150) return { type: 'high', basis, dur, tss, if: intensity };
  return { type: 'moderate', basis, dur, tss, if: intensity };
}

// ---------- targets ----------

/** Most recent weigh-in on or before `iso`; falls back to the earliest known. */
export function weightOn(iso, weights) {
  const sorted = [...(weights || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return null;
  let out = null;
  for (const w of sorted) {
    if (w.date <= iso) out = w;
  }
  return out || sorted[0];
}

export function targetsFor(iso, { athlete, weights, workouts, planned }) {
  const w = weightOn(iso, weights);
  const kg = w ? w.kg : null;
  const dayWorkouts = (workouts || []).filter((x) => x.date === iso);
  const dayPlanned = (planned || []).filter((x) => x.date === iso);

  const base = kg ? baseTDEE(kg, athlete) : null;
  const act = activityKcal(dayWorkouts, athlete);
  const tdee = base == null ? null : Math.round(base + act);
  const deficit = athlete.planned_deficit_kcal ?? 0;

  const gPerKg = athlete.protein_g_per_kg ?? 2.0;
  const [lo, hi] = athlete.protein_range_g_per_kg ?? [1.8, 2.2];

  return {
    date: iso,
    weight_kg: kg,
    weight_date: w ? w.date : null,
    weight_stale_days: w ? daysBetween(w.date, iso) : null,
    bmr: kg ? Math.round(bmr(kg, athlete.height_cm, athlete.age)) : null,
    base_tdee: base == null ? null : Math.round(base),
    activity_kcal: act,
    activity_confidence: activityConfidence(dayWorkouts),
    tdee,
    kcal_target: tdee == null ? null : tdee - deficit,
    planned_deficit: deficit,
    protein_target: kg ? Math.round(gPerKg * kg) : null,
    protein_min: kg ? Math.round(lo * kg) : null,
    protein_max: kg ? Math.round(hi * kg) : null,
    day: dayType(dayWorkouts, dayPlanned),
    workouts: dayWorkouts,
    planned: dayPlanned,
  };
}

// ---------- intake ----------

export function dayTotals(entries) {
  return (entries || []).reduce(
    (t, e) => ({
      kcal: t.kcal + (e.kcal || 0),
      protein: t.protein + (e.protein || 0),
      carbs: t.carbs + (e.carbs || 0),
      fat: t.fat + (e.fat || 0),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

/**
 * Group entries into meals: consecutive entries less than MEAL_GAP_MIN apart.
 * Only clusters clearing `meal_min_kcal` are treated as meals for the protein check,
 * so a black coffee never gets flagged for being under 30g.
 */
export function mealClusters(entries, athlete) {
  const timed = (entries || [])
    .map((e) => ({ ...e, _min: minutesOf(e.time) }))
    .filter((e) => e._min != null)
    .sort((a, b) => a._min - b._min);

  const clusters = [];
  for (const e of timed) {
    const last = clusters[clusters.length - 1];
    if (last && e._min - last.end <= MEAL_GAP_MIN) {
      last.entries.push(e);
      last.end = e._min;
    } else {
      clusters.push({ start: e._min, end: e._min, entries: [e] });
    }
  }

  const minKcal = athlete.meal_min_kcal ?? 250;
  const minProtein = athlete.protein_min_per_meal_g ?? 30;

  return clusters.map((c) => {
    const t = dayTotals(c.entries);
    const isMeal = t.kcal >= minKcal;
    return {
      start: c.start,
      end: c.end,
      entries: c.entries,
      ...t,
      isMeal,
      proteinShort: isMeal && t.protein < minProtein,
      proteinGap: isMeal ? Math.max(0, minProtein - t.protein) : 0,
    };
  });
}

// ---------- the headline: cumulative deficit ----------

/**
 * Week-to-date deficit vs plan. This is the number the whole rebuild exists for.
 *
 * actual   = sum(TDEE - intake) over days with any intake logged
 * planned  = sum(planned_deficit) over those same days
 * variance = actual - planned. Positive means ahead of plan.
 *
 * Days with nothing logged are excluded from both sides rather than counted as
 * zero intake, which would read as a huge phantom deficit.
 */
export function cumulativeDeficit(dates, ctx, logs, openDate = null) {
  let actual = 0;
  let planned = 0;
  const days = [];
  let open = null;

  for (const iso of dates) {
    const log = logs[iso];
    const entries = log?.entries || [];
    const t = targetsFor(iso, ctx);
    const intake = dayTotals(entries).kcal;
    const logged = entries.length > 0;
    const isOpen = iso === openDate;

    // The in-progress day is reported separately, never added to the totals. A day that is
    // only half eaten looks like a huge deficit, and that is exactly the flattering error
    // this dashboard exists to stop.
    let dayActual = null;
    if (logged && t.tdee != null) {
      dayActual = t.tdee - intake;
      if (!isOpen) {
        actual += dayActual;
        planned += t.planned_deficit;
      }
    }
    if (isOpen) {
      open = { date: iso, logged, intake, tdee: t.tdee, target: t.kcal_target, deficit: dayActual };
    }

    days.push({
      date: iso,
      logged,
      open: isOpen,
      intake,
      tdee: t.tdee,
      target: t.kcal_target,
      deficit: dayActual,
      variance: dayActual == null ? null : dayActual - t.planned_deficit,
      dayType: t.day.type,
      confounders: log?.confounders || [],
      protein: dayTotals(entries).protein,
      protein_target: t.protein_target,
    });
  }

  const loggedDays = days.filter((d) => d.logged && !d.open).length;
  return {
    days,
    open,
    loggedDays,
    actual: Math.round(actual),
    planned: Math.round(planned),
    variance: Math.round(actual - planned),
    projectedKg: actual / KCAL_PER_KG_FAT,
  };
}

export function weekDates(iso) {
  const start = weekStart(iso);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (d <= iso) out.push(d);
  }
  return out;
}

// ---------- weight trend ----------

/**
 * Trailing N-day mean over raw weigh-ins. A point is only emitted where the window
 * holds at least ROLLING_MIN_POINTS readings — with sparse weighing a 7-day mean over
 * one reading is just the raw point wearing a trend line's clothes.
 */
export function rollingWeight(weights, windowDays = ROLLING_WINDOW_DAYS) {
  const sorted = [...(weights || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return [];
  const out = [];
  const first = sorted[0].date;
  const last = sorted[sorted.length - 1].date;

  for (let i = 0; i <= daysBetween(first, last); i++) {
    const d = addDays(first, i);
    const from = addDays(d, -(windowDays - 1));
    const win = sorted.filter((w) => w.date >= from && w.date <= d);
    if (win.length >= ROLLING_MIN_POINTS) {
      out.push({ date: d, kg: win.reduce((s, w) => s + w.kg, 0) / win.length, n: win.length });
    }
  }
  return out;
}

/** kg/week from the rolling series over its trailing `days`. Null if not enough signal. */
export function weightTrendRate(rolling, days = 28) {
  if (rolling.length < 2) return null;
  const last = rolling[rolling.length - 1];
  const from = addDays(last.date, -days);
  const win = rolling.filter((r) => r.date >= from);
  if (win.length < 2) return null;
  const span = daysBetween(win[0].date, last.date);
  if (span < 7) return null;
  return ((last.kg - win[0].kg) / span) * 7;
}

// ---------- on-bike carbs ----------

/** Carb rate band for a ride, plus the glucose:fructose flag above the absorption ceiling. */
export function carbRate(durationMin, intensityFactor, athlete) {
  const hours = (durationMin || 0) / 60;
  if (hours < 1) return null;
  const rules = athlete.carb_rate_rules || [];
  const rule =
    rules.find((r) => hours <= r.max_hours && (intensityFactor || 0) < r.max_if) ||
    rules[rules.length - 1];
  const [lo, hi] = rule.g_per_hr;
  const threshold = athlete.carb_blend_threshold_g_per_hr ?? 60;
  return {
    hours,
    low: lo,
    high: hi,
    total_low: Math.round(lo * hours),
    total_high: Math.round(hi * hours),
    needsBlend: hi > threshold,
    blendNote: hi > threshold
      ? `Above ${threshold} g/hr use roughly 2:1 glucose:fructose — a single carb source saturates gut absorption at this rate.`
      : null,
  };
}
