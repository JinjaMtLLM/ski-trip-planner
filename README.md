# ski-trip-planner

An agent skill that turns "fly to the airport nearest a ski resort" into a ranked list of trip options, priced as **cost per skiable hour**.

Given an origin airport, one or more candidate destination airports and a resort, it enumerates every viable outbound × return flight pair, buckets them by **annual leave taken (0 / 0.5 / 1 / 2 days)**, computes how many hours you can actually ski and what the trip costs, then emits a filterable HTML report sorted by cost per ski day.

The interesting part is not the multiplication — it is the time boundaries: landing → arriving at the resort, leaving the resort → boarding, night-session weighting, flights that land after midnight, overnight layovers, taxes charged per flight segment. Those decide the ranking.

No resort, airport, date or price is hard-coded. Every number comes from the user and is written into a `config.json`.

## Requirements

- Node.js ≥ 18 (uses built-in `fetch`, no npm dependencies)
- Python 3.9+ — only for `tools/package.py`
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

This is an ordinary agent skill: a directory whose root contains `SKILL.md`. Install it the way your agent installs skills — in most cases that means placing the directory into the agent's skills folder under the name declared in the `name` field of `SKILL.md` (`ski-trip-planner`).

Two common routes:

```bash
# link the repo so edits take effect immediately
ln -s "$PWD" "<your-agent-skills-dir>/ski-trip-planner"
```

```powershell
# Windows equivalent, no admin rights needed
New-Item -ItemType Junction -Path "<your-agent-skills-dir>\ski-trip-planner" -Target (Get-Location)
```

If your agent has a skill installer or an archive import, package the directory first and feed it the zip:

```bash
python tools/package.py        # -> dist/ski-trip-planner.zip
```

Either way the destination folder must be named `ski-trip-planner`, matching `SKILL.md`.

## Usage

Ask the agent for a ski trip. It runs four steps:

0. **Credentials** — `doctor.js`, and help set up any missing key.
1. **Destination and airport** — list the airports around the resort, pre-query them on one sample date with `airport_scan.js` (driving time plus cheapest fare), and let *you* pick. Then confirm the trip skeleton: resort opening hours, day/night sessions, night-session rest days.
2. **Parameters** — date range, lodging budget (resort and layover city priced separately), leave buckets, tax per segment, and the three leave-day cut-off times (work start / noon split / work end, default `08:30` / `14:00` / `20:00`).
3. **Flights** — `flight_query.js` per date and direction, direct and connecting.
4. **Report** — `planner.js` produces the HTML.

Scripts can also be run by hand:

```bash
# compare candidate airports on one date: drive time + cheapest fare
node scripts/airport_scan.js --resort "Some Resort" --from "City A" --date 2026-12-05 \
  --candidates "Airport One|City One;Airport Two|City Two" --type direct --repeat 1

# driving time for a single route, with buffer applied
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
| `scripts/airport_scan.js` | Multi-airport pre-query: drive time and cheapest fare on one date |
| `scripts/flight_query.js` | Flight search via the Ctrip Wendao API; outputs config-shaped arrays |
| `scripts/amap_route.js` | Amap driving time, outputs `toResortMinutes` including the buffer |
| `scripts/wendao.js` | Flight query and response parser, shared by the search scripts |
| `scripts/amap.js` | Geocoding and driving route implementation, shared by the route scripts |
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
- **Multiple airports** — each flight may carry a three-letter airport code, shown next to the flight number; transfer time uses the longest drive among the chosen airports.

## Development

```bash
python tools/package.py     # -> dist/ski-trip-planner.zip, whitelisted files only
```

The bundler uses the git file list, so `.gitignore` is respected and `.git/` never ends up in the archive. `tools/`, `.gitignore` and this README are dev-only and excluded; every other file must sit under `scripts/` or `references/` to be packaged at all, so local `config.json` files and query dumps can never slip into a release.

`SKILL.md`, the references and the code comments are written in Chinese — that is the language of the agent-facing instructions. This README is in English for anyone browsing the repo.

## Before you rely on it

- Fares and schedules come from third-party services as point-in-time snapshots. Prices move, connections get re-timed. Verify every itinerary on the booking page before paying.
- The Wendao token is rate-limited — roughly 30 queries per token per day. Plan the query budget per date and direction.
- Resort hours, lift tickets and lodging prices are inputs you supply; the skill does not verify them.
- Flight data comes from the endpoint behind Ctrip's Wendao skill (`externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo`). That endpoint is **not publicly documented** and is not a supported public API — its response format can change, it can start demanding new credentials, or it can stop answering entirely, at any time and without notice. If that happens the flight-search step breaks and no other input can substitute for it; `planner.js` still runs on a `config.json` you assemble by hand.
- This is an unofficial tool. It is not affiliated with Ctrip or Amap, and use of their services is governed by their own terms.

## License

AGPL-3.0 — see [LICENSE](LICENSE). Copyright (C) 2026 SardineFish.
