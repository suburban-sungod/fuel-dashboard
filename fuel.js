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

/** Resting burn per minute, from BMR. */
export function restingKcalPerMin(kg, athlete) {
  return bmr(kg, athlete.height_cm, athlete.age) / 1440;
}

/**
 * Exercise kcal for a date, NET of the resting burn already counted in base TDEE.
 *
 * Two corrections over the naive version:
 *
 * 1. Base TDEE covers all twenty-four hours, so adding the gross cost of a session on top
 *    counts the resting burn for those hours twice — about 230 kcal on a three-hour ride.
 *    That inflates TDEE, which inflates the apparent deficit. Subtracting it is the
 *    conservative direction and this page exists to refuse the flattering error.
 *
 * 2. Strength work was a flat 200 kcal whatever its length, so a 25-minute session and a
 *    75-minute one scored identically. Now it scales with duration off a MET value. The
 *    default 4.0 is the low end of the resistance-training range because a Speediance
 *    session is a lot of rest between sets — it lands near the old 200 for a typical
 *    session and only diverges at the extremes, which is exactly the point.
 *
 * `kg` is optional: without it the resting correction is skipped and strength falls back
 * to the flat figure, so callers with no weigh-in still get a usable number.
 */
export function activityKcal(workouts, athlete, kg = null) {
  const restPerMin = kg ? restingKcalPerMin(kg, athlete) : 0;
  let total = 0;
  for (const w of workouts || []) {
    const min = w.duration_min || 0;
    let gross = 0;
    if (w.type === 'strength') {
      // The Speediance measures the work done, so its figure beats anything modelled here
      // — the same reason a ride prefers power over the watch's calorie guess. Only a
      // number marked as measured qualifies: TrainingPeaks also reports calories for a
      // lift, but derives them from heart rate, which resistance work makes meaningless.
      gross = w.source === 'speediance' && w.calories
        ? w.calories
        : min && kg
          ? ((athlete.strength_met ?? 4.0) * 3.5 * kg / 200) * min
          : (athlete.strength_kcal ?? 200);
    } else if (w.avg_watts && min) {
      gross = rideKcal(w.avg_watts, min);
    } else if (w.calories) {
      gross = w.calories;
    }
    if (!gross) continue;
    total += Math.max(0, gross - restPerMin * min);
  }
  return Math.round(total);
}

/**
 * Estimated kcal for a PLANNED session, used only where nothing measured exists yet.
 *
 * Without this, a day is credited zero activity until Strava syncs — so a three-hour ride
 * finished at 10am reads as a rest day until 21:00, handing back a rest-day calorie target
 * and an enormous phantom deficit. The plan is worse than a measurement and better than
 * pretending the session never happened.
 *
 * Deliberately conservative: overstating the plan tells him to eat more than he earned.
 */
export function plannedKcal(planned, athlete, kg = null) {
  const restPerMin = kg ? restingKcalPerMin(kg, athlete) : 0;
  let total = 0;
  for (const p of planned || []) {
    const min = p.duration_min || 0;
    if (!min) continue;
    let gross = 0;
    if (p.type === 'strength') {
      gross = kg ? ((athlete.strength_met ?? 4.0) * 3.5 * kg / 200) * min : (athlete.strength_kcal ?? 200);
    } else if (p.type === 'swim') {
      gross = kg ? ((athlete.swim_met ?? 7.0) * 3.5 * kg / 200) * min : 0;
    } else if (p.type === 'cycling' && athlete.ftp) {
      // Prefer the coach's own number: TSS 100 is an hour at FTP, so kcal ≈ TSS/100 × FTP × 3.6.
      // Untargeted rides ("Gravel or road ride") carry no IF or TSS, so fall back to a low
      // endurance intensity rather than assuming he rides them hard.
      gross = p.tss
        ? (p.tss / 100) * athlete.ftp * 3.6
        : rideKcal((p.if || athlete.planned_default_if || 0.6) * athlete.ftp, min);
    }
    if (!gross) continue;
    total += Math.max(0, gross - restPerMin * min);
  }
  return Math.round(total);
}

/**
 * Planned sessions of a type he has no measured session for that day. A planned ride with
 * a completed ride against it is assumed to BE that ride, not a second one.
 */
export function unmatchedPlanned(workouts, planned) {
  const done = new Set((workouts || []).map((w) => w.type));
  return (planned || []).filter((p) => !done.has(p.type));
}

/** How much of an activity figure is a real measurement vs a plan vs a fallback guess. */
export function activityConfidence(workouts, plannedKcalValue = 0) {
  if (!workouts || !workouts.length) return plannedKcalValue ? 'planned' : 'none';
  if (plannedKcalValue) return 'part-planned';
  if (workouts.every((w) => w.type === 'strength')) return 'estimated';
  return workouts.some((w) => w.avg_watts) ? 'measured' : 'estimated';
}

// ---------- day classification ----------

/**
 * Intensity factor. TrainingPeaks supplies one for structured plans; Strava never does,
 * so derive it from normalised power (falling back to average) over FTP.
 */
export function rideIntensity(w, athlete) {
  if (w.if) return w.if;
  const watts = w.np_watts || w.avg_watts;
  if (watts && athlete?.ftp) return watts / athlete.ftp;
  return 0;
}

/**
 * Training Stress Score. Strava's `suffer_score` is Relative Effort — a heart-rate
 * derived number on a completely different scale — so it must never be treated as TSS.
 * A 142-minute gravel ride reported Relative Effort 32 where the real TSS was near 70;
 * trusting it meant the "high day" gate could essentially never fire.
 */
export function rideTSS(w, athlete) {
  const inten = rideIntensity(w, athlete);
  if (!inten || !w.duration_min) return 0;
  return (w.duration_min / 60) * inten * inten * 100;
}

const NON_FUELLED = new Set(['strength', 'swim', 'other']);

/** rest | moderate | high, from measured ride data where available, else the plan. */
export function dayType(workouts, planned, athlete) {
  const rides = (workouts || []).filter((w) => !NON_FUELLED.has(w.type));
  const src = rides.length ? rides : (planned || []).filter((p) => !NON_FUELLED.has(p.type));
  if (!src.length) return { type: 'rest', basis: workouts?.length ? 'non-ride session only' : 'no activity' };

  const dur = src.reduce((s, w) => s + (w.duration_min || 0), 0);
  const tss = src.reduce((s, w) => s + (w.tss || rideTSS(w, athlete)), 0);
  const intensity = Math.max(...src.map((w) => rideIntensity(w, athlete)));
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
  const measuredKcal = activityKcal(dayWorkouts, athlete, kg);
  const stillPlanned = unmatchedPlanned(dayWorkouts, dayPlanned);
  const plannedOnly = plannedKcal(stillPlanned, athlete, kg);
  const act = measuredKcal + plannedOnly;
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
    activity_measured_kcal: measuredKcal,
    activity_planned_kcal: plannedOnly,
    activity_planned_sessions: stillPlanned,
    activity_confidence: activityConfidence(dayWorkouts, plannedOnly),
    tdee,
    kcal_target: tdee == null ? null : tdee - deficit,
    planned_deficit: deficit,
    protein_target: kg ? Math.round(gPerKg * kg) : null,
    protein_min: kg ? Math.round(lo * kg) : null,
    protein_max: kg ? Math.round(hi * kg) : null,
    day: dayType(dayWorkouts, dayPlanned, athlete),
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
 *
 * `openDate` is the in-progress day, held out of the totals. A day carrying `closed: true`
 * is never open, whatever the clock says: he finishes eating hours before midnight, and
 * making him wait for the date to roll to see the number he has already earned is the
 * difference between a dashboard he checks after dinner and one he checks tomorrow.
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
    const isOpen = iso === openDate && !log?.closed;

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

/**
 * The days of the week containing `iso`, up to and including `upTo`.
 *
 * `upTo` must be the real today, not the day being viewed. Capping at the viewed day turns
 * a finished week into a three-day week whenever he pages back, which silently understates
 * the headline deficit for every historical date.
 */
export function weekDates(iso, upTo = iso) {
  const start = weekStart(iso);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (d <= upTo) out.push(d);
  }
  return out;
}

/**
 * Value at `p` through a series, linearly interpolated. Used to scale charts to the bulk
 * of the data rather than to its single largest point.
 */
export function percentile(values, p) {
  const v = [...values].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
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

// ---------- the diary, by category ----------
//
// Seven slots, in the order the day actually happens. He picks the slot by tapping the Add
// button in it, so nothing here has to guess — `categoryOf` exists only for entries logged
// before this existed, and for the Siri Shortcut, which has no way to say.
//
// The targets are NOT new doctrine. Every number below already appears somewhere on the
// page: the carb-rate rules drive the bike, the 3h-before and 1h-after guidance drive
// pre and post, and the protein-per-meal minimum drives the three meals. This just puts
// each number next to the food it is about, instead of in a paragraph underneath.

// The three session slots keep the ids they were born with — `prebike`, `bike`, `postbike`
// — because entries already carry them. Only the labels move with the day, so a lift is
// never called a bike ride and nothing has to be migrated.
export const CATEGORIES = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'prebike', label: 'Pre-bike', session: true },
  { id: 'bike', label: 'On the bike', session: true },
  { id: 'postbike', label: 'Post-bike', session: true },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snack', label: 'Snacks' },
];

const SESSION_LABELS = {
  cycling: ['Pre-bike', 'On the bike', 'Post-bike'],
  strength: ['Pre-lift', 'During the lift', 'Post-lift'],
  swim: ['Pre-swim', 'During the swim', 'Post-swim'],
  none: ['Pre-session', 'During', 'Post-session'],
};

/**
 * The session the day's fuelling hangs off, and what kind it is.
 *
 * A ride wins when there is one: it is the only session long enough to need feeding while
 * it happens. Otherwise a lift or a swim, which for him is 45 minutes of instruction and
 * strength work rather than a fuelling problem. Completed beats planned in every case.
 */
export function daySession(workouts, planned) {
  const pick = (list, match) => (list || []).filter(match)[0] || null;
  const isRide = (w) => !NON_FUELLED.has(w.type);
  const isStrengthish = (w) => w.type === 'strength' || w.type === 'swim';

  const ride = pick(workouts, isRide) || pick(planned, isRide);
  if (ride) return { kind: 'cycling', session: ride, fuelled: true };

  const other = pick(workouts, isStrengthish) || pick(planned, isStrengthish);
  if (other) return { kind: other.type, session: other, fuelled: false };

  return { kind: 'none', session: null, fuelled: false };
}

// How the day's non-ride calories divide across the three meals. Snacks deliberately get
// no calorie target: they are the remainder, and giving a remainder a target invites
// eating up to it.
const MEAL_SPLIT = { breakfast: 0.3, lunch: 0.35, dinner: 0.35 };

/**
 * Which slot an entry belongs to when it does not say.
 *
 * Only for legacy entries and Shortcut drops. Ride-relative slots need the ride, so
 * without one this never returns pre/on/post — a breakfast on a rest day must not be
 * filed as pre-bike just because it was early.
 */
export function categoryOf(entry, day = null) {
  if (entry?.cat) return entry.cat;
  const m = minutesOf(entry?.time);
  if (m == null) return 'snack';

  const { session, fuelled } = day?.kind ? day : { session: day, fuelled: !!day };
  if (session) {
    const start = minutesOf(session.start_time);
    const end = start == null ? null : start + (session.duration_min || 0);
    if (start != null) {
      // Nothing is eaten during a 45-minute lift, so never file anything there by
      // inference — a mid-morning snack that happens to overlap a gym session is a snack.
      if (fuelled && m >= start && m <= end) return 'bike';
      if (m < start && start - m <= PREFUEL_WINDOW_MIN) return 'prebike';
      if (m > end && m - end <= RECOVERY_WINDOW_MIN) return 'postbike';
    }
  }
  if (m < 10 * 60) return 'breakfast';
  if (m >= 11 * 60 && m < 15 * 60) return 'lunch';
  if (m >= 17 * 60 && m < 21 * 60 + 30) return 'dinner';
  return 'snack';
}

/**
 * Per-category targets for a day, derived from that day's own numbers.
 *
 * `ride` is the day's fuelled session, or null. Everything ride-relative returns null
 * without one, so a rest day shows three slots with no targets rather than three slots
 * demanding 90g of carbs an hour.
 */
export function categoryTargets(targets, athlete, day = null, dayType = 'rest') {
  const { kind, session, fuelled } = day?.kind ? day : { kind: day ? 'cycling' : 'none', session: day, fuelled: !!day };
  const out = {};
  for (const c of CATEGORIES) out[c.id] = { kcal: null, protein: null, carbs: null, note: '' };

  const labels = SESSION_LABELS[kind] || SESSION_LABELS.none;
  ['prebike', 'bike', 'postbike'].forEach((id, i) => { out[id].label = labels[i]; });

  if (fuelled && session) {
    const rate = carbRate(session.duration_min, rideIntensity(session, athlete), athlete);
    if (rate) {
      out.bike.carbs = rate.total_low;
      out.bike.carbs_high = rate.total_high;
      // On-bike carbs are the calories. Nobody eats fat or protein on a hard ride.
      out.bike.kcal = Math.round(rate.total_low * 4);
      out.bike.note = `${rate.low}–${rate.high}g/hr over ${rate.hours.toFixed(1)}h`;
      if (rate.needsBlend) out.bike.blend = rate.blendNote;
    } else {
      out.bike.note = 'under an hour — water is enough';
    }

    const [lo, hi] = dayType === 'high' ? [120, 170] : [80, 120];
    out.prebike.carbs = lo;
    out.prebike.carbs_high = hi;
    out.prebike.kcal = Math.round(lo * 4);
    out.prebike.note = 'in the 3h before, easy on the fat';

    out.postbike.protein = 30;
    out.postbike.protein_high = 40;
    out.postbike.note = 'within an hour of finishing';
  } else if (session) {
    // A lift, or a swim, which for him is 45 minutes of instruction and strength work.
    // Two of these three slots exist to say "nothing here", which is genuinely useful:
    // the mistake on a strength day is treating it like a ride and carb-loading for it.
    out.prebike.note = 'nothing required — 20–30g carbs if you train before breakfast';
    out.bike.note = 'nothing needed, just water';
    // The one target on a strength day that earns its place. Lifting in a calorie deficit
    // at 53 costs lean mass unless protein turns up afterwards, and protein is the number
    // he routinely finishes the day short on.
    out.postbike.protein = 30;
    out.postbike.protein_high = 40;
    out.postbike.note = 'within an hour or two — this is what protects lean mass in a deficit';
  }

  const minProtein = athlete.protein_min_per_meal_g || 30;
  // What the three meals have to cover: the day, less what the ride slots already account
  // for. Without this a ride day double-counts its own fuelling and the meal targets come
  // out absurd.
  const ridekcal = (out.bike.kcal || 0) + (out.prebike.kcal || 0);
  const mealKcal = targets.kcal_target == null ? null : Math.max(0, targets.kcal_target - ridekcal);

  for (const id of ['breakfast', 'lunch', 'dinner']) {
    out[id].protein = minProtein;
    out[id].kcal = mealKcal == null ? null : Math.round(mealKcal * MEAL_SPLIT[id]);
  }
  return out;
}

/** Group a day's entries into the seven slots, with totals against target. */
export function byCategory(entries, targets, athlete, day = null, dayType = 'rest') {
  const tg = categoryTargets(targets, athlete, day, dayType);
  return CATEGORIES.map((c) => {
    const items = (entries || [])
      .filter((e) => categoryOf(e, day) === c.id)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const tot = dayTotals(items);
    const target = tg[c.id];
    return {
      ...c,
      // The session slots rename themselves for the day: a lift must never be labelled
      // "On the bike".
      label: target.label || c.label,
      entries: items,
      ...tot,
      target,
      // A slot is only short once it holds an actual meal. Empty means it has not happened
      // yet, and a lone black coffee is not a breakfast that failed to reach 30g of
      // protein — the same `meal_min_kcal` guard the old time-based clustering used.
      proteinShort: tot.kcal >= (athlete.meal_min_kcal ?? 250)
        && target.protein != null && tot.protein < target.protein,
      proteinGap: target.protein == null ? 0 : Math.max(0, target.protein - tot.protein),
    };
  });
}

// ---------- what should I eat now ----------
//
// Suggests from Matt's OWN food list, never from a generic database. The value is not
// "here is a snack", it is "here is a snack you already eat, that closes the gap you
// actually have right now, and here is why". A suggestion he would not eat is noise.
//
// The gap that matters is almost never calories. It is protein: he lands the calorie
// target routinely and finishes days 60-100g short on protein, so the default mode ranks
// on protein per calorie rather than on filling the remaining budget.

export const RECOVERY_WINDOW_MIN = 90;
export const PREFUEL_WINDOW_MIN = 180;

/** Items worth offering: real food, macros known, not a condiment or a drink. */
function snackable(templates) {
  const ok = (i) => i.suggest !== false && (i.kcal || 0) >= 25;
  return {
    singles: (templates.singles || []).filter(ok),
    meals: (templates.meals || []).filter(ok),
  };
}

const density = (v, kcal) => (kcal > 0 ? (v / kcal) * 100 : 0);

/**
 * Sensible two-item combinations only: something protein-dominant with something
 * carb-dominant. Pairing two steaks, or two bananas, is not advice.
 */
function pairsOf(singles) {
  const protein = singles.filter((i) => density(i.protein, i.kcal) >= 8);
  const carb = singles.filter((i) => density(i.carbs, i.kcal) >= 15);
  const out = [];
  for (const p of protein) {
    for (const c of carb) {
      if (p.id === c.id) continue;
      out.push({
        id: `${p.id}+${c.id}`,
        label: `${p.label} + ${c.label}`,
        kcal: p.kcal + c.kcal,
        protein: p.protein + c.protein,
        carbs: p.carbs + c.carbs,
        fat: p.fat + c.fat,
        source: p.source === 'estimate' || c.source === 'estimate' ? 'estimate' : 'known',
        parts: [p, c],
      });
    }
  }
  return out;
}

/**
 * Work out what the moment calls for. Recovery and pre-fuel beat the daily arithmetic:
 * an hour after a three-hour ride, protein-per-calorie is the wrong question.
 */
export function suggestionMode({ targets, totals, workouts, planned, nowMin }) {
  const kcalLeft = targets.kcal_target == null ? null : targets.kcal_target - totals.kcal;
  const proteinLeft = targets.protein_target == null ? 0 : Math.max(0, targets.protein_target - totals.protein);

  if (kcalLeft != null && kcalLeft <= 0) return { mode: 'over', kcalLeft, proteinLeft };

  const ended = (w) => {
    const start = minutesOf(w.start_time);
    return start == null ? null : start + (w.duration_min || 0);
  };
  const justFinished = (workouts || []).some((w) => {
    const e = ended(w);
    return e != null && nowMin >= e && nowMin - e <= RECOVERY_WINDOW_MIN;
  });
  if (justFinished) return { mode: 'recovery', kcalLeft, proteinLeft };

  const soon = (planned || []).some((p) => {
    if (NON_FUELLED.has(p.type)) return false;
    const s = minutesOf(p.start_time);
    return s != null && s > nowMin && s - nowMin <= PREFUEL_WINDOW_MIN;
  });
  if (soon) return { mode: 'prefuel', kcalLeft, proteinLeft };

  // Can the protein gap still be closed inside the calories left? If it comfortably can,
  // this is an ordinary top-up. If it cannot, protein has to drive every remaining choice.
  const needed = proteinLeft > 0 && kcalLeft != null ? density(proteinLeft, kcalLeft) : 0;
  if (proteinLeft >= 20) return { mode: needed >= 12 ? 'protein-tight' : 'protein', kcalLeft, proteinLeft };
  return { mode: 'topup', kcalLeft, proteinLeft };
}

function scoreFor(mode, c, { kcalLeft, proteinLeft }) {
  const pDens = density(c.protein, c.kcal);
  const cDens = density(c.carbs, c.kcal);
  const fDens = density(c.fat, c.kcal);

  switch (mode) {
    case 'recovery': {
      // 30-40g protein with carbs alongside. Reward landing in the band, not exceeding it.
      const inBand = 1 - Math.min(1, Math.abs(c.protein - 35) / 35);
      return 60 * inBand + 30 * Math.min(1, c.carbs / 40) - 10 * Math.min(1, fDens / 40);
    }
    case 'prefuel':
      // Absolute carbs first, density second. Ranking on density alone recommended a
      // single Clif Blok before a 75-minute tempo session: the densest carb he owns, and
      // 8g of the 80-120g he actually needs. Fat is penalised twice, as a share and as a
      // total, because fat before a ride is how you end up with gut trouble.
      return 65 * Math.min(1, c.carbs / 70)
           + 20 * Math.min(1, cDens / 50)
           - 30 * Math.min(1, fDens / 35)
           - 15 * Math.min(1, Math.max(0, c.fat - 12) / 20);
    case 'protein-tight':
      // Every calorie has to work. Density dominates; volume barely counts.
      return 85 * Math.min(1, pDens / 25) + 15 * Math.min(1, c.protein / Math.max(1, proteinLeft));
    case 'protein':
      return 55 * Math.min(1, pDens / 25) + 45 * Math.min(1, c.protein / Math.max(1, proteinLeft));
    default:
      // Topup: protein still counts, but so does actually filling the remaining budget.
      return 40 * Math.min(1, pDens / 20) + 40 * Math.min(1, c.kcal / Math.max(1, kcalLeft)) - 15 * Math.min(1, fDens / 45);
  }
}

function reasonFor(mode, c, { proteinLeft, kcalLeft }) {
  const after = kcalLeft == null ? null : kcalLeft - c.kcal;
  const tail = after == null ? '' : ` Leaves ${Math.round(after)} kcal.`;
  switch (mode) {
    case 'recovery':
      return `${Math.round(c.protein)}g protein and ${Math.round(c.carbs)}g carbs inside the recovery window.${tail}`;
    case 'prefuel':
      // Don't call 20g of fat "only" 20g. Overselling a pick is how the feature stops
      // being trusted.
      return c.fat <= 10
        ? `${Math.round(c.carbs)}g carbs and only ${Math.round(c.fat)}g fat — sits well before a ride.${tail}`
        : `${Math.round(c.carbs)}g carbs. ${Math.round(c.fat)}g fat, so give it a bit of time.${tail}`;
    case 'protein-tight':
      return `${Math.round(density(c.protein, c.kcal))}g protein per 100 kcal, the best ratio you have left.${tail}`;
    case 'protein':
      return `${Math.round(c.protein)}g of the ${Math.round(proteinLeft)}g protein you still need.${tail}`;
    default:
      return `${Math.round(c.kcal)} kcal, ${Math.round(c.protein)}g protein.${tail}`;
  }
}

const HEADLINE = {
  over: (s) => `You're ${Math.abs(Math.round(s.kcalLeft))} kcal over target. Nothing more today unless it's protein.`,
  recovery: () => `You finished a session in the last ${RECOVERY_WINDOW_MIN} minutes. Protein and carbs now.`,
  prefuel: () => `Ride coming up. Carbs, and go easy on the fat.`,
  'protein-tight': (s) => `${Math.round(s.proteinLeft)}g protein left in only ${Math.round(s.kcalLeft)} kcal. Every choice has to be dense.`,
  protein: (s) => `${Math.round(s.proteinLeft)}g protein still to find, ${Math.round(s.kcalLeft)} kcal to play with.`,
  topup: (s) => `Protein's basically there. ${Math.round(s.kcalLeft)} kcal left if you want it.`,
};

/**
 * Rank Matt's own foods against the gap he has right now.
 *
 * `nowMin` is minutes since midnight, passed in rather than read from the clock so this
 * stays pure and testable.
 */
export function suggestSnacks({ targets, totals, entries, templates, workouts, planned, nowMin, limit = 3 }) {
  const situation = suggestionMode({ targets, totals, workouts, planned, nowMin });
  const { mode, kcalLeft, proteinLeft } = situation;
  const out = { ...situation, headline: HEADLINE[mode](situation), picks: [] };

  const { singles, meals } = snackable(templates || {});
  let candidates = [...singles, ...meals, ...pairsOf(singles)];

  // Over budget: only protein-dense items are still defensible, and say so.
  if (mode === 'over') {
    candidates = candidates.filter((c) => density(c.protein, c.kcal) >= 15 && c.kcal <= 200);
  } else if (kcalLeft != null) {
    candidates = candidates.filter((c) => c.kcal <= kcalLeft * 1.05);
  }

  const eatenToday = new Set((entries || []).map((e) => (e.label || '').toLowerCase()));
  const seen = new Set();

  out.picks = candidates
    .map((c) => {
      let score = scoreFor(mode, c, { kcalLeft, proteinLeft });
      // Already had it today: still allowed, just not the headline advice.
      const repeated = [...(c.parts || [c])].some((p) => eatenToday.has((p.label || '').toLowerCase()));
      if (repeated) score *= 0.6;
      if (c.source === 'estimate') score *= 0.95; // prefer items whose macros are verified
      return { ...c, score, repeated, why: reasonFor(mode, c, situation) };
    })
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      // One suggestion per headline food, so the list is not three variations of a shake.
      // Keyed on the label root rather than the id, because "PB&J" and "PB&J (large)" are
      // two ids and one piece of advice.
      const head = c.parts ? c.parts[0] : c;
      const key = (head.label || head.id).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);

  return out;
}

// ---------- on-device text matching ----------
//
// Resolves typed entries against Matt's own food list before any API call is considered.
// Deliberately strict and all-or-nothing: a fragment it cannot resolve exactly fails the
// whole match and the entry falls through to the LLM parser. Partial credit would silently
// understate a day's intake, which is the failure mode this dashboard exists to prevent.

const FILLER = new Set(['a', 'an', 'the', 'some', 'of', 'my', 'plain', 'just']);

const NUMBER_WORDS = {
  half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  couple: 2, pair: 2, dozen: 12,
};

function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull a leading quantity off a fragment. Returns [qty, rest]. */
function takeQuantity(text) {
  const m = /^(\d+(?:\.\d+)?|[a-z]+)\s+(.*)$/.exec(text);
  if (!m) return [1, text];
  const [, head, rest] = m;
  if (/^\d/.test(head)) return [Number(head), rest];
  if (head in NUMBER_WORDS) return [NUMBER_WORDS[head], rest];
  if (head === 'a' || head === 'an') return [1, rest];
  return [1, text];
}

function stripFiller(text) {
  return text.split(' ').filter((w) => w && !FILLER.has(w)).join(' ');
}

/** Longest alias that exactly equals the cleaned text, or null. */
function exactItem(text, items) {
  let best = null;
  for (const item of items) {
    for (const alias of item.aliases || []) {
      const a = stripFiller(normalise(alias));
      const hit = a === text || singular(a) === singular(text);
      if (hit && (!best || a.length > best.aliasLength)) {
        best = { item, aliasLength: a.length };
      }
    }
  }
  return best ? best.item : null;
}

/** Singularise a trailing plural so "2 bananas" resolves like "2 banana". */
function singular(text) {
  return text
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

function scale(item, qty) {
  const per = item.unit_count || 1;
  const f = qty / per;
  return {
    id: item.id,
    label: item.label,
    qty,
    kcal: Math.round(item.kcal * f),
    protein: Math.round(item.protein * f * 10) / 10,
    carbs: Math.round(item.carbs * f * 10) / 10,
    fat: Math.round(item.fat * f * 10) / 10,
    estimate: item.source === 'estimate',
  };
}

/**
 * Try to resolve free text locally. Returns null when it can't — that is the signal to
 * fall through to the API parser, not a failure.
 */
export function matchEntry(text, templates) {
  const raw = normalise(text);
  if (!raw) return null;

  // 1. Whole-text match against a meal template ("eggs on toast", "tuna on rye").
  //    Done first because meal phrases contain connectors that step 2 would split on.
  const [mealQty, mealRest] = takeQuantity(raw);
  const meal = exactItem(stripFiller(mealRest), templates.meals || []);
  if (meal) {
    const item = scale(meal, mealQty);
    return { items: [item], ...totalsOf([item]), label: labelOf([item]) };
  }

  // 2. Otherwise split on connectors and resolve each fragment against single items.
  const fragments = raw
    .split(/\s*(?:,|\+|\band\b|\bwith\b|\bplus\b)\s*/)
    .map((f) => f.trim())
    .filter(Boolean);
  if (!fragments.length) return null;

  const items = [];
  for (const fragment of fragments) {
    const [qty, rest] = takeQuantity(fragment);
    const single = exactItem(stripFiller(rest), templates.singles || []);
    if (!single) return null; // all-or-nothing
    items.push(scale(single, qty));
  }

  return { items, ...totalsOf(items), label: labelOf(items) };
}

function totalsOf(items) {
  return {
    kcal: items.reduce((s, i) => s + i.kcal, 0),
    protein: Math.round(items.reduce((s, i) => s + i.protein, 0) * 10) / 10,
    carbs: Math.round(items.reduce((s, i) => s + i.carbs, 0) * 10) / 10,
    fat: Math.round(items.reduce((s, i) => s + i.fat, 0) * 10) / 10,
    anyEstimate: items.some((i) => i.estimate),
  };
}

function labelOf(items) {
  return items.map((i) => (i.qty !== 1 ? `${i.qty}x ${i.label}` : i.label)).join(' + ');
}
