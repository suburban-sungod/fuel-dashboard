# fuel-dashboard

Static nutrition dashboard, built for a phone. **This repo is public and contains no
personal data of any kind** — no food log, no weight, no body stats. It is code only.

The data lives in Cloudflare D1 behind a private Worker, and is read at runtime with a
key the user pastes into their own device once. Without that key this page renders an
empty lock screen. Anyone can read this source; nobody can read the data.

## What it does

**Cumulative deficit is the headline.** Week-to-date actual deficit against planned,
with per-day bars — so a run of small overages surfaces on Wednesday rather than at
the weekend post-mortem.

**Targets are computed, never hardcoded.** Base TDEE is Mifflin-St Jeor recalculated
from the latest weigh-in and multiplied by a sedentary activity factor; exercise
calories are added per-day from ride power (`W × h × 3.6`). Protein target is g/kg of
current bodyweight. Nothing goes stale as weight moves.

**The in-progress day is never counted.** A day that is only half eaten looks like an
enormous deficit. Today is shown live and separately; only closed days enter the total.

**The weight chart leads with a 7-day rolling average**, with raw weigh-ins kept
visible underneath and confounder flags (alcohol, high sodium, poor sleep, sauna,
travel, heavy lift, illness) marked along the axis, so a 1kg swing has a visible
explanation. The rolling line only draws where the window actually holds three or more
readings — a "7-day average" over a single weigh-in is a raw point in disguise.

**Day type is classified from data,** not typed in: rest / moderate / high, derived
from Strava duration, TSS and IF, falling back to the TrainingPeaks plan and saying
which it used.

**On-bike carbs scale with ride length** — 30–60 g/hr under 2.5h, up to 90 g/hr beyond,
and above 60 g/hr it flags the 2:1 glucose:fructose blend, since a single carb source
saturates gut absorption at that rate.

## Logging

Saved meal templates are one tap. Individual items are a second tap. Anything novel goes
in as free text, and the Worker estimates its macros in the response to the write — so the
row lands already resolved, in a couple of seconds, without an API key ever reaching the
browser. If the estimate does not come back the entry is kept as free text and re-asked on
the next attempt; nothing rewrites it behind the app's back.

Entries write to local storage first and queue for the Worker, so logging never waits on a
signal and a ride out of range doesn't lose anything. The queue holds **operations** — put
this entry, delete that one, close this day — not whole files, which is why an edit on one
device no longer has to be merged against an edit on another.

## Files

| File | Role |
|---|---|
| `fuel.js` | All calculation. Pure functions, no DOM, no network. Unit tested. |
| `store.js` | Worker reads/writes, local cache, offline op queue |
| `app.js` | Rendering, charts (hand-rolled SVG, no chart library), log sheet |
| `styles.css` | Light and dark, both deliberately stepped |
| `sw.js` | Caches the app shell only — never data |

## Install on iPhone

Open the page in Safari, Share → Add to Home Screen. It then runs full-screen with no
browser chrome. The Action Button can be bound to a shortcut that opens it directly.
