# ski-trip-planner

A WorkBuddy skill that turns "fly to the airport nearest a ski resort" into a ranked list of trip options, priced as **cost per skiable hour**.

Given an origin airport, a destination airport and a resort, it enumerates every viable outbound × return flight pair, buckets them by **annual leave taken (0 / 0.5 / 1 / 2 days)**, computes how many hours you can actually ski and what the trip costs, then emits a filterable HTML report sorted by cost per ski day.

The interesting part is not the multiplication — it is the time boundaries: landing → arriving at the resort, leaving the resort → boarding, night-session weighting, flights that land after midnight, overnight layovers, taxes charged per flight segment. Those decide the ranking.

No resort, airport, date or price is hard-coded. Every number comes from the user and is written into a `config.json`.

## Requirements

- Node.js ≥ 18 (uses built-in `fetch`, no npm dependencies)
- Two API keys, read from environment variables only:

| Variable | Service | Used for | Get it at |
|---|---|---|---|
| `WENDAO_API_KEY` | Ctrip Wendao | flight numbers, times, fares | https://www.ctrip.com/wendao/openclaw |
| `AMAP_API_KEY` | Amap (Gaode) | geocoding + driving route | https://console.amap.com/dev/key/app |

The Amap key must be a **Web Service** key with *Geocoding* and *Driving Direction* enabled. Keys are never written to disk, never passed as command-line arguments, and never echoed back in full.

Check both at once:

```bash
node scripts/doctor.js          # are they set?
node scripts/doctor.js --probe  # send one real request each
```

When a key is missing or invalid the scripts print the same setup guide — the apply link, the exact variable name, the per-platform `export`/`set`/`$env:` line, and the verification command.

## Install

Copy or link this directory into your skills folder as `ski-trip-planner` (the name must match the `name` field in `SKILL.md`):

```bash
# macOS / Linux
ln -s "$PWD" ~/.workbuddy/skills/ski-trip-planner
```

```powershell
# Windows (no admin rights needed)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.workbuddy\skills\ski-trip-planner" -Target (Get-Location)
```

A symlink or junction lets you edit the repo in place and have the skill pick up changes immediately.

## Usage

Ask the agent for a ski trip. It runs four steps:

0. **Credentials** — `doctor.js`, and help set up any missing key.
1. **Destination** — nearest airport, driving time via `amap_route.js` (adds a buffer), resort day/night operating hours and night-session rest days, then a trip-skeleton card for you to confirm.
2. **Parameters** — date range, lodging budget (resort and layover city priced separately), leave buckets, tax per segment, leave-day cut-offs.
3. **Flights** — `flight_query.js` per date and direction, direct and connecting.
4. **Report** — `planner.js` produces the HTML.

Scripts can also be run by hand:

```bash
# driving time, with buffer applied
node scripts/amap_route.js --from "Some Airport" --to "Some Resort" --from-city "Some City"

# flights for one date, direct + connecting, written as a config-ready array
node scripts/flight_query.js --from "City A" --to "City B" --date 2026-12-05 --type both --out out-2026-12-05.json

# compute and render
node scripts/planner.js config.json --csv
```

`planner.js` exits with an error naming any missing config field. There are no silent defaults — that is deliberate.

## Files

| Path | Purpose |
|---|---|
| `SKILL.md` | Skill definition and the four-step workflow |
| `scripts/planner.js` | Enumeration engine + HTML report generator. Purely parameter-driven |
| `scripts/flight_query.js` | Flight search via the Ctrip Wendao API; outputs config-shaped arrays |
| `scripts/amap_route.js` | Amap driving time, outputs `toResortMinutes` including the buffer |
| `scripts/keys.js` | Credential registry and the shared missing-key guide |
| `scripts/doctor.js` | Credential status; `--probe` verifies against the live APIs |
| `references/intake.md` | What to ask, how to offer options, the confirmation card |
| `references/config-schema.md` | Field-by-field `config.json` reference with a copyable skeleton |
| `references/algorithm.md` | The model: windows, leave-day rules, cost boundaries, sensitivity checks |

## How the numbers are built

- **Skiable time** — the resort's opening hours are intersected with your actual presence, day by day. Day sessions count fully; night sessions are multiplied by a weight (0.5 by default). Nights when the resort does not open night skiing are skipped.
- **Arrival / departure** — landing + transfer time to the resort; the reverse adds check-in and the drive back before departure.
- **Leave days** — outbound judged by departure time, return judged by landing time (a late-evening flight or an early-morning arrival can cost zero leave); whole working days in between are counted.
- **Cost** — base fare + tax per segment (a connection is two segments) + lodging. Late-night arrivals that land before a set hour are not charged a hotel night.

## Development

```bash
python tools/package.py     # -> dist/ski-trip-planner.zip, tracked files only
```

The bundler uses the git file list, so `.gitignore` is respected and `.git/` never ends up in the archive. `tools/` and this README are dev-only and excluded, as is `.gitignore`.
