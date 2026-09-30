# Internship Radar

**Apply first 8 hours · Reply same day.**

A live board of internship and co-op postings, gathered from thousands of company career sites directly plus the major aggregators, with an application tracker built in.

**App:** https://adityasingh2400.github.io/jobradar/

## How it works

```
 company career sites ─┐                                   ┌─> web app (GitHub Pages)
 (Greenhouse, Lever,   │   Mac runner (~1 min, while on)   │     Radar · Pipeline · Dashboard
  Ashby, Workday,      ├─> ─────────────────────────────── ┤
  Oracle, iCIMS, …,    │   GitHub Actions (~5 min, when    │   data branch = shared database
  Google, Apple, …)    │   the Mac is asleep)              │   (jobs.json, health.json, …)
 aggregators ──────────┘                                   └─> private tracker repo (your pipeline)
 (Simplify, SpeedyApply, LinkedIn, …)
```

- **Direct first.** Aggregators are used to *discover* which companies hire interns; the radar then polls those companies' own career systems, so new postings show up minutes after they go live instead of hours or days later. Rows show `⚡ 5h before Simplify` when that happens.
- **Two runners, one database.** The Mac runner (a LaunchAgent) polls continuously while the Mac is awake; elite companies every 1–3 minutes. GitHub Actions takes over automatically when the Mac hasn't published for 6 minutes. GitHub's cron is unreliable for 5-minute schedules, so the `radar` workflow re-dispatches itself every ~5 minutes (pause it with the repo variable `RADAR_LOOP=off`); the hourly `watchdog` restarts the loop if it ever stops and fails (emailing you) if data goes stale. Both runners write to the `data` branch with compare-and-swap pushes, so neither can overwrite the other.
- **Corroboration & safety.** Every job keeps each source that saw it (employer site, Simplify, LinkedIn, …). The employer's own system is authoritative for closures; a source that suddenly returns nothing is held for three polls before anything is closed; dead boards are retired automatically. Companies that block automated access (Tesla) are still covered through aggregators and LinkedIn company feeds. Settings → Elite companies shows every top company's feed health.
- **Everything merges.** The same job seen on Simplify, LinkedIn and the company's Greenhouse board is one row, with first-seen time per source.
- **Tracker.** Save, apply, and move applications through the status ladder (To Apply → Applied → OA → Recruiter Screen → Technical → Final → Offer). The dashboard shows response, interview and offer rates, follow-ups due, and your speed-to-apply. It lives in your browser and optionally syncs to the private `jobradar-tracker` repo (Settings → Sync).

## Layout

| Path | What |
|---|---|
| `radar/run.mjs` | runner: `once` (Actions), `daemon` (Mac), `discover`, `squash` |
| `radar/engine.mjs` | merge/dedupe/first-seen/closed state machine |
| `radar/store.mjs` | the `data` branch as a CAS-protected database |
| `radar/discover.mjs` | builds the watchlist of career sites + Levels.fyi pay |
| `radar/sources/ats/` | Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable |
| `radar/sources/platforms/` | Oracle, iCIMS, Jibe, SuccessFactors, Phenom, Taleo, Eightfold, Avature, Rippling, JazzHR, … |
| `radar/sources/custom/` | Google, Apple, Meta, Microsoft, Amazon, TikTok, ByteDance, Jane Street, Citadel, … |
| `radar/sources/aggregators/` | Simplify, CSCareers, SpeedyApply, Jobright, LinkedIn |
| `config/` | filters (`config.json`), company tiers, seed boards |
| `web/` | the app (no build step) |
| `mac/` | install / uninstall the Mac runner |

## Common tasks

```bash
# Mac runner
mac/install.sh                       # install / update the LaunchAgent
tail -f ~/Library/Logs/jobradar.log  # watch it
mac/uninstall.sh                     # remove it (Actions keeps running)

# Test one adapter against a live site
node radar/tools/test-adapter.mjs radar/sources/custom/google.mjs

# Tests (also run in CI; the Mac runner won't self-update to code that fails them)
node test/engine.test.mjs && node test/classify.test.mjs

# One local sweep without publishing
node radar/run.mjs once --runner local --dry

# Force a cloud sweep now
gh workflow run radar -f force=true
```

Add a company: put its board in `config/seeds.json` (or just wait; any company that shows up on an aggregator is added to the watchlist by the daily `discover` job). Add a whole new career-site type: drop an adapter in `radar/sources/platforms/` or `custom/` following `radar/sources/CONTRACT.md`.
