# Par Timer (PWA) — prototype

A browser replacement for Dry Fire Par Timer: the timing engine (Basic and Advanced drills, four
adjustable tones, pause/resume/stop, screen wake lock) plus storage — a drill library, drill sets,
history and stats, and import of the old app's backup. Not yet installable/offline (see
`../DryFireParTimerAPK/FEATURE_INVENTORY.md` for the roadmap).

## Storage

IndexedDB (`js/db.js`): `drills`, `sets`, `history` (one row per step run: drill, par, reps, time),
`sessions` (practice time per run), `meta` (current drill and set). One drill per exercise; its
name is always shown with its current settings (`15 × 1.50s`, `5 × 1.30→1.00s`), and history keeps
the par and reps actually run, so **History & stats** can break a drill down by par time.

**Data → Import old app backup** reads the `DryFire_*.db` file the old app's Backup writes, in the
browser via sql.js (vendored in `vendor/`, loaded only when importing). Drill ids, sets, every run
and the practice-time rows come across; float noise is rounded (0.699999988 → 0.70) and the
"Exercise Description" placeholder is dropped. **Export / Restore backup** is this app's own JSON.

**Clearing history:** *History & stats → Clear this drill's history* removes one drill's runs (the drill
stays). *Data → Clear all history* removes every run and the practice-time log (drills, sets and settings
stay); it requires typing CLEAR and downloads a backup first unless you untick that.

## Drill packs

A drill pack (`*.drillpack.json`) holds drill names, descriptions and settings, plus optional sets,
and never any history. **Data → Share drills as pack** saves the drills you tick. **Import drill pack**
adds a pack's drills. A drill whose name you already have (ignoring case) is left alone, so your
settings and history always win. New users get a **Load starter drills** button that adds
`packs/starter.json`: 28 drills in the sets Fundamentals, Skill drills and Standards.

## Beep tones

| Tone | Default pitch | Length |
|---|---|---|
| Start | 800 Hz | 0.25 s |
| Stop | 1000 Hz | 0.25 s |
| Step (par changes, Advanced) | 900 Hz | 0.20 s |
| Finish | 1100 Hz | 0.70 s |

* Pitches are adjustable (500–2500 Hz) under **Beep tones**. Lengths are fixed.
* The par runs from the start of the start tone to the start of the stop tone.
* The rep delay runs from the start of the stop tone to the start of the next start tone. A delay
  never goes below 0.30 s, so the stop tone always ends at least 0.05 s before the next start tone.
* Step and finish tones begin 0.06 s after the stop tone ends (0.31 s after it starts).
* After a step tone, the next start tone waits at least 0.15 s after the step tone ends
  (0.66 s after the stop tone starts), lengthening that one delay if needed.

Source of truth: `DEFAULT_TONES`, `MIN_DELAY_MS`, `TONE_GAP_EXTRA` and `STEP_TONE_CLEARANCE` in `js/drill.js`.

## How the timing works

`Start` builds the whole drill up front (every delay, random offset, step and finish tone) and
schedules every beep on the Web Audio clock with `AudioBufferSourceNode.start(when)`. The audio
hardware places each beep to the sample, so nothing on the JS thread can shift one. The display
reads the same clock minus the reported output latency, so the countdown follows what you hear.

| File | Role |
|---|---|
| `js/drill.js` | Pure drill math: validation, steps, rep plan, tone timeline (ms integers) |
| `js/audio.js` | Tone rendering, scheduling, and `verifyTiming()` offline self-check |
| `js/runner.js` | Start / pause / resume / stop, position from the audio clock |
| `js/db.js` | IndexedDB stores and transactions |
| `js/legacy.js` | Old-app `.db` backup → records |
| `js/stats.js` | History windows (7 / 14 / 30 days / lifetime), per-par breakdown |
| `js/app.js` | UI |

Deliberate choices:
* The delay before a start beep has no countdown on screen, so you can't anticipate it.
* Random offset is uniform within ± the amount you set (the original used only 0 or ± the full
  amount), floored at 0.3 s.
* Resume repeats the interrupted rep, with the first-rep delay to get back into position.
* If the OS interrupts audio mid-drill (call, another app), the drill pauses instead of drifting.

## Run it

```
npm install              # once: test-only dependency (sql.js)
npm test                 # unit tests (Node 22); DRYFIRE_DB=path/to/backup.db also tests a real import
npm run serve            # http://localhost:8000
```

Diagnostics → **Verify timing** renders the current drill offline and measures every beep onset.

## On the phone

Wake lock (and later the service worker) needs a secure origin; `localhost` counts. Easiest with
USB debugging on:

```
adb reverse tcp:8000 tcp:8000
```

then open `http://localhost:8000` in Chrome on the phone while `npm run serve` is running on the PC.

Opening the PC's LAN address (`http://192.168.x.x:8000`) also works for sound but not for the wake
lock, so the screen may sleep mid-drill. For regular use it will go on GitHub Pages (HTTPS).

## What to test

1. 1.00 s par, 2.0 s delay, 10 reps; record with a second device and measure start→stop spacing.
2. Same over Bluetooth: absolute lag grows, the par interval should not.
3. Lock the screen or take a call mid-drill: it should pause and say why, then resume cleanly.
4. The screen stays on for the whole drill (Diagnostics shows `wake lock: on`).

## Credits

* **Dry Fire Par Time Tracker** by CSL1911A1 ([Google Play](https://play.google.com/store/apps/details?id=com.csl1911a1.dryfirepartimer),
  [apps4shooting.com](https://www.apps4shooting.com/)). This app independently re-creates its drill formats, drill sets and
  practice history, and imports its backups. No code or text from it is used.
* **Ben Stoeger's training books**, especially *DryFire Reloaded*, *Dry-Fire Training: For the Practical Pistol Shooter*
  and *Practical Shooting Training* (with Joel Park). Many starter-pack drills and par-time goals are inspired by them. The
  pack's descriptions are original short summaries.
* [sql.js](https://github.com/sql-js/sql.js) (MIT) reads the old app's backups; see `vendor/sql.js-LICENSE`.

Not affiliated with or endorsed by CSL1911A1 or Ben Stoeger. The same credits appear in the app under **About & credits**.

## Deploying (GitHub Pages)

The site is the repository root, served as static files: no build step beyond the service worker.

1. After changing any app file, run `npm run build:sw` to write the new cache version into `sw.js`.
   `npm test` fails if you forget, because installed copies only update when that version changes.
2. Commit and push to `main`. GitHub Pages (Settings → Pages → Deploy from a branch → `main` / root)
   publishes it within a minute or two.
3. Installed copies pick up the new version the next time they open, and show **Reload to update**.

The service worker is skipped on `localhost` so edits show up immediately; add `?sw=1` to test it.
