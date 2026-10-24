# ski-trip-planner

An agent skill that turns "fly to the airport nearest a ski resort" into a ranked list of trip options, priced as **cost per ski day** (total cost ÷ equivalent ski days).

Given an origin airport, one or more candidate destination airports and a resort, it builds a graph of every flight, high-speed train and taxi hop, enumerates every viable outbound × return path pair, and **buckets the results by the annual leave each one actually costs** — not by a list you declare up front. It then computes how many hours you can actually ski on snow and what the trip costs, and emits a filterable HTML report sorted by cost per ski day, with a small trend chart across leave buckets.

The interesting part is not the multiplication — it is the time boundaries: landing → arriving at the resort, leaving the resort → boarding, night-session weighting, flights that land after midnight, overnight layovers, taxes charged per flight segment. Those decide the ranking.

No resort, airport, date or price is hard-coded. Every number comes from the user and is written into a `case.json` (enumeration pipeline) or a `config.json` (manual engine).

## Requirements

- Node.js ≥ 18 (uses built-in `fetch`, no npm dependencies)
- Python 3.9+ — only for `tools/package.py`
- API keys, read from environment variables; the Variflight key may also come from your agent's MCP config:

| Variable | Role | Service | Used for | Get it at |
|---|---|---|---|---|
| `VARIFLIGHT_MCP_KEY` | **required** | Variflight MCP | detailed flight search only — full candidate set, tax-inclusive fares, seats | https://cmcp.variflight.com/ |
| `WENDAO_API_KEY` | **recommended** | Ctrip Wendao | the only source for airport rough-screening, plus operating-status checks | https://www.ctrip.com/wendao/openclaw |
| `AMAP_API_KEY` | fallback | Amap (Gaode) | driving time, only when Wendao can't supply it or you need an exact figure | https://console.amap.com/dev/key/app |

The Amap key must be a **Web Service** key with *Geocoding* and *Driving Direction* enabled. Keys are never written to `config.json`, never passed as command-line arguments, and never echoed back in full.

**Variflight is charged once per `tools/call`, so it is reserved for the detailed search.** That is also the reason the script merges every date of one direction into a single call: the split-by-date habit would silently cost 6× more. It must never be used to probe "does this route have flights" or to compare candidate airports — that is what the Wendao key is for, and if you skip it the skill asks *you* to pick the airport rather than quietly spending credits.

**None of the three is a dead end.** You can decline all of them and still get a full report — see [Manual mode](#manual-mode).

Check status without spending anything:

```bash
node scripts/doctor.js                 # reads config only, no requests at all
node scripts/doctor.js --probe         # + free probes (MCP handshake, one geocode)
node scripts/doctor.js --probe-wendao  # + Wendao (costs 1 daily quota, 20–60s)
```

Cost of each check is deliberate: the MCP `initialize` / `tools/list` handshake is not billed, a single Amap geocode sits inside the free quota, but a Wendao probe burns one daily quota and takes up to a minute — so it is opt-in.

Set up the MCP in one command:

```bash
VARIFLIGHT_MCP_KEY="your key" node scripts/mcp_config.js --write
```

It merges the entry into your agent's MCP config — it picks whichever config already exists (`~/.workbuddy/mcp.json`, then `~/.workbuddy-ai/mcp.json`), and `--file <path>` or `SKI_MCP_CONFIG` overrides that. The old file is backed up, other MCP servers are left untouched, and the key is masked in the output. Then approve/trust the new server in your agent's connector manager — that step can't be scripted. `--check` verifies, `--print` shows the fragment, `--remove` undoes it.

When a key is missing or invalid the scripts print the same setup guide — apply link, the one-command path, the exact variable name, the per-platform `export`/`set`/`$env:` line, the verification command, and its cost.

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

Ask the agent for a ski trip. It runs five stages:

0. **Credentials** — `doctor.js`, and help set up any missing key.
1. **Destination and airport** — list the airports around the resort, then rough-screen them in **one** plain-language Ctrip Wendao prompt that returns flight counts, earliest/latest landing, fare ballpark *with total elapsed time*, drive time and resort hours per airport. Take exact drive times from Amap for the shortlist, verify resort hours against the official page, and let *you* pick. Then confirm the trip skeleton.
2. **Parameters** — date range, lodging budget (resort and layover city priced separately), the maximum number of leave days, tax per segment, and the three leave-day cut-off times (work start / noon split / work end, default `08:30` / `14:00` / `20:00`).
3. **Flights** — `flight_query.js`, one call per direction; the query window is the weekend ± (max leave days + 1) so that "one extra day turns out cheaper" dates also enter the pool. Raw results are cached on disk, so re-running a failed step costs nothing.
4. **Enumeration and report** — `legs.js` turns the cached flights plus the static train/taxi timetable into one edge table, `enumerate.js` exhaustively pairs outbound and return paths and buckets the result by the leave each combination really costs, `render.js` draws the HTML.

Scripts can also be run by hand:

```bash
# driving time for a single route, with buffer applied
node scripts/amap_route.js --from "Some Airport" --to "Some Resort" --from-city "Some City"

# flights for one weekend, both directions, dates fanned out by leave days
node scripts/flight_query.js --from SZX --to CGQ --weekend 2027-01-08 --leave-days 1 --both --out weekend-0108.json

# flights for specific dates, direct + connecting, written as a config-ready array
# keep every date in ONE `--dates` call: credits are charged per call, not per date
node scripts/flight_query.js --from SZX --to CGQ --dates 2027-01-08,2027-01-09 --type both --out out-0108-0109.json

# deterministic pipeline: cached flights + static timetable -> edges -> pairs -> report
node scripts/legs.js case.json --out legs.csv        # also writes legs.json next to it
node scripts/enumerate.js case.json --legs legs.json --top 30
node scripts/render.js case.json --top top.json --legs legs.json --out report.html

# small-scale / hand-picked candidates, no cache needed
node scripts/planner.js config.json --csv
```

`--from` / `--to` take IATA codes. Prefer **city** codes (`BJS` = PEK + PKX, `SHA` = PVG + SHA) so one query covers every airport in a city; use airport codes only when the airports sit in different cities.

`planner.js` exits with an error naming any missing config field. There are no silent defaults — that is deliberate.

### Query cache

Every flight query is expensive, so the **raw response** of each `tools/call` is written to `<skill>/.cache/` (override with `SKI_CACHE_DIR`). The cache key is a hash of the tool name plus its arguments — which include the full SQL — so the same command re-run hits the cache, while any change to dates, routes, `--per-day` or `--max-stop` produces a new key.

- **Freshness** — 24 hours by default (`--cache-ttl <minutes>`). A stale entry, a truncated entry, or an entry that recorded a previous failure is *not* reused in normal mode; the query is re-run instead. The long default exists because the same window gets re-run repeatedly within one working day (tweaking a report, adding a scenario); the cost is that a price quote can be a day old, which is why `meta.dataAt` must go into the report footer and fares still need re-checking before booking.
- **Failure fallback** — if the live call throws (network down, key expired, tool error), the script falls back to whatever cache exists for that key and flags it as `fallback` in the metadata. You get an answer instead of a stack trace.
- **Coverage index** — every write also refreshes `.cache/index.json` + `.cache/index.md`: per route, which dates are cached, which airports actually came back, how many rows, when it was queried, and the key to fetch. This file is **for the agent, not for scripts** — read it before spending credits: if the route/date is already cached, skip the query entirely. `node scripts/cache.js index` prints it, `reindex` rebuilds it after an upgrade. Two sources are kept apart on purpose: `cities`/`dates` come from the SQL (what was asked for), `airports`/`perDate` come from the returned rows (what was actually obtained, capped per day) — entries written before 2026-10-23 have no airport columns and are labelled as such.
- **Overrides** — `--refresh` re-queries and overwrites; `--no-cache` neither reads nor writes.
- **Provenance** — `meta.dataAt` reports when the data was actually fetched. A cache hit makes that earlier than "now", so use it for the report footer rather than the current time.
- **Maintenance** — `node scripts/cache.js list | prune | clear`, or `show <key>` to read back one raw response.

```bash
node scripts/cache.js list              # what's cached, how old, how many rows
node scripts/cache.js prune --days 7    # drop entries older than a week
node scripts/cache.js clear             # start over
```

### Manual mode

`planner.js` is purely parameter-driven — it needs no network, no key, no API. If you'd rather not configure anything, the skill collects the flights from you and builds `config.json` by hand. You lose automatic price comparison; you keep the full leave-bucket ranking, because that math is local.

```bash
node scripts/doctor.js --manual   # prints the collection checklist, exits 0
```

The checklist is: flights (route, date, flight numbers, departure/arrival times, fare), connections, drive time, resort hours, lodging, and the three leave-day cut-off times. `references/manual-flights.md` has a complete, runnable example plus the four things people get wrong (`price` is the bare fare, cross-midnight flights need `arrDate`, a connection's `dep`/`arr` are the first and last legs, and `toResortMinutesSource` must be honest).

### Run journal

Script-to-script calls only live in process memory. When one throws, the caller sees a single error string and can't tell whether the parameters, the SQL, or the endpoint failed — and re-running costs credits. So every run writes `runs/<runId>.json` under the cache directory:

- the full command line, timing, exit state
- every step's input and output (arrays are reduced to a count plus a sample; full data stays in the cache under its key)
- on failure, the exact SQL that broke, the error `kind`, and the hints for what to do next

That record is what lets a caller repair the pipeline with a small glue step instead of replaying the whole chain: read the failed step's SQL, pull the raw rows out of the cache by key, assemble `{ out, ret }` by hand, and feed it straight to `planner.js`.

```bash
node scripts/journal.js list             # recent runs, newest first
node scripts/journal.js show <runId>     # one run in full
node scripts/journal.js clear            # drop them all
```

Disable with `--no-journal` or `SKI_NO_JOURNAL=1`.

## Files

| Path | Purpose |
|---|---|
| `SKILL.md` | Skill definition and the workflow |
| `scripts/legs.js` | Edge table builder: cached flights + high-speed-rail timetable + taxi hops, all normalised into directed edges (`legs.csv` for humans, `legs.json` for the enumerator) |
| `scripts/enumerate.js` | Exhaustive path enumeration: DFS out/back, same-key pruning, Cartesian pairing, per-bucket top N |
| `scripts/graphcore.js` | Pure algorithm layer the enumerator sits on — snow hours (including the `minDayH` day-session floor), leave days (including the holiday calendar), night states, DFS, same-mode ground merging, pruning, return retiming. No I/O, so it is unit-testable offline |
| `scripts/holidays.js` | Statutory-holiday and make-up-workday calendar. Published years use the official notice; unpublished years infer New Year only and warn about the rest |
| `scripts/render.js` | Report renderer. Presentation only, no arithmetic |
| `scripts/design.js` | Report styles and static assets (CSS / SVG fragments) consumed by `render.js`. Change colours here |
| `scripts/embed.js` | Embeds a case's raw data (`case.json` / `network.json` / `legs.csv` / `legs.json` / `top.csv`) plus the algorithm source closure into the page, and writes `#raw-manifest`. Also exposes `strip()` so the tabbed page can reuse a finished report |
| `scripts/planner.js` | Small-scale engine + HTML report for hand-picked candidates. Purely parameter-driven |
| `scripts/flight_query.js` | Flight search via the Variflight MCP; spreads the query window from the max leave days, outputs config-shaped `{ out, ret }` |
| `scripts/variflight.js` | Variflight MCP client: JSON-RPC/SSE parsing, SQL builder, date windows, row mapping, cache plumbing |
| `scripts/cache.js` | Query cache: raw responses on disk keyed by tool + arguments, with freshness window, failure fallback and pruning |
| `scripts/journal.js` | Run journal: per-run record of commands, step I/O, failing SQL and cache keys, so a broken chain can be repaired without replaying it |
| `scripts/mcp_config.js` | One-command MCP setup: merges `variflight-mcp` into the agent's MCP config with backup, `--check`, `--print`, `--remove` |
| `scripts/mcp_json.js` | Locates that config file — `SKI_MCP_CONFIG`, then the common per-agent paths — and reads/writes one shared resolution |
| `scripts/amap_route.js` | Amap driving time, outputs `toResortMinutes` including the buffer |
| `scripts/rail_12306.js` | 12306 rail timetable client: 1 QPS throttle, block detection (302 → error page, or 200 + HTML), 15-day presale guard. `--list` for availability, `--verify` to check train numbers against stop-by-stop times, `--stops` for a full schedule |
| `scripts/wendao.js` | Ctrip Wendao request/parse implementation for programmatic use; not on the main path |
| `scripts/amap.js` | Geocoding and driving route implementation, shared by the route scripts |
| `scripts/keys.js` | Credential registry and the shared missing-key guide |
| `scripts/doctor.js` | Credential status; `--probe` verifies against the live APIs |
| `references/wendao-prompts.md` | Wendao prompt library: the single combined airport-comparison prompt, the operating-status check, and the phrasing rules that keep it from dropping data |
| `references/intake.md` | What to ask, how to offer options, the confirmation card |
| `references/config-schema.md` | Field-by-field `config.json` reference with a copyable skeleton |
| `references/manual-flights.md` | Manual mode: what to collect, a runnable example, and the four common mistakes |
| `references/algorithm.md` | The model: windows, leave-day rules, cost boundaries, sensitivity checks, and how the two engines differ |
| `references/enumeration.md` | The graph pipeline: data model, five stages, why pruning is safe, known limits |
| `references/case-schema.md` | `case.json` field reference (input of the enumeration pipeline) |
| `templates/README.md` | **Deliverable layouts**: the single-resort report contract, the tabbed multi-session page (one command, one config file), the three escaping/encoding rules, and the verification checklist |
| `templates/season-page/` | Tabbed-page template. Entry point is `build.py` (collect → shell → attach → payloads → verify in one go); the only file you edit is `season.config.json`. Internals: `collect.py`, `build_season.py`, `build_season_all.py`, `attach.js`, `verify_season_all.py`, `sync_algo.py`; `shell/` holds the extracted styles and tab runtime; `legacy/` holds retired one-off scripts |

## How the numbers are built

- **Skiable time** — the resort's opening hours are intersected with your actual presence, day by day. Day sessions count fully; night sessions are multiplied by a weight (0.5 by default). Nights when the resort does not open night skiing are skipped. **A day session shorter than `resort.minDayH` (default 3 h) is dropped to zero for that whole day** — boots, lockers and warm-up eat more than that, and pro-rating a 1.7 h day makes an unusable window look cheap. Night sessions are exempt; `minDayH: 0` restores the old "every minute counts" rule.
- **Arrival / departure** — landing + transfer time to the resort; the reverse adds check-in and the drive back before departure.
- **Leave days** — outbound judged by departure time, return judged by landing time, each split three ways (before the workday starts = 0, before the noon split = 0.5, later = 1), so a late-evening flight or a morning landing can cost zero or half a day; whole working days in between are counted. The total is *computed*, never used as a filter: whatever days fall out become the buckets. **`params.calendar: "CN"` switches "free day" from "Saturday or Sunday" to the real statutory-holiday calendar** (make-up workdays are checked first, so a make-up Saturday still costs leave). Without it a New Year or Spring Festival window over-counts by one to three days and every bucket shifts.
- **Cost** — fare + tax. Tax is taken from the flight's own construction-fee-plus-fuel figures when the data source provides them; only when it does not does the skill fall back to the per-segment default (a connection is two segments). Plus lodging, decided by sampling where you are at 03:00 each night: at the resort, stuck at an airport/station long enough to need a room, or still in transit (no charge — which is why red-eyes cost nothing extra and need no special rule).
- **Ground hops** — two consecutive same-mode, on-demand ground hops are merged into one edge before the DFS continues. Without it `station → airport → resort` shows up as a legal path and crowds out real itineraries. The same-mode condition is load-bearing: "taxi to the airport, then the airport shuttle up the mountain" is a genuine transfer, not a mergeable pair.
- **Multiple airports** — each flight may carry a three-letter airport code, shown next to the flight number; transfer time uses the longest drive among the chosen airports.
- **Drive time provenance** — `destAirport.toResortMinutesSource` records whether the figure is `amap` (measured), `wendao` (estimate) or `user` (stated), and the report subtitle prints it. Wendao's number is a coarse one, so it carries a 30% buffer rather than Amap's 20%.

## Development

```bash
node tests/smoke.js         # offline regression: leave-day boundaries, ordering, error exits
python tools/package.py     # -> dist/ski-trip-planner.zip, whitelisted files only
```

`tests/smoke.js` is offline and key-free, and asserts the things that have broken before: the leave-day cut-offs on both ends, snow-hour intersection and night weighting, DFS feasibility and return retiming, pruning, credit accounting, and — end to end on a synthetic five-edge graph — that leave buckets come from the data rather than from the declared `leaveDays`, and that the report still leads with the all-buckets table, the headline cards and the trend chart. CI runs the syntax check and the suite on every push and pull request.

The bundler uses the git file list, so `.gitignore` is respected and `.git/` never ends up in the archive. `tools/`, `tests/`, `.github/`, `.gitignore` and this README are dev-only and excluded; every other file must sit under `scripts/` or `references/` to be packaged at all, so local `config.json` files and query dumps can never slip into a release.

`SKILL.md`, the references and the code comments are written in Chinese — that is the language of the agent-facing instructions. This README is in English for anyone browsing the repo.

## Before you rely on it

- Fares and schedules come from third-party services as point-in-time snapshots. Prices move, connections get re-timed. Verify every itinerary on the booking page before paying.
- Only the flight lookup truly needs a key. `planner.js` needs nothing, so a total refusal to configure credentials degrades to [manual mode](#manual-mode) rather than to failure.
- Flight data comes from the **Variflight MCP** (`c-gw.variflight.com`), billed in credits: **100 per month**. Settled: **dates are free** — querying 3 or 6 dates of the same direction is one `tools/call`, and `initialize` / `tools/list` / failed calls / 400-parameter errors / local cache hits cost nothing. Unsettled: whether a call is charged **once per call** or **once per unique city pair**; the two sources in this repo disagree and neither proof is solid (the journal's `credits` field is self-counted, so citing it is circular). One conclusion holds either way: **packing both directions into one call is never more expensive** (one credit saved if per-call, a wash if per-pair) — though the script groups batches by direction, so it never actually does this. The script merges every date of one direction by default (`--chunk 0`, capped at 6 sources per call), so a round-trip weekend costs 2 credits however many leave buckets you enumerate. Because of that pricing it is used **only** for the detailed search step. If you run out, swap the key.
- Two independent caps per SQL query: **6 data sources** (i.e. 6 dates) and **200 output rows** (`truncated: true`, no error). Rows come back ordered by date, so truncation silently drops the *later* dates: the last date present may be half-cut and everything after it is missing. Instead of re-running the whole batch (a new `tools/call`, one more credit), the script locates the cut date and re-queries **only that date onward** — one call per day, zero if cached. Never sort by direction instead of date: a `ORDER BY direction` was measured to fill all 200 rows with the return leg and drop the outbound one entirely, with no error.
- The row budget is the real design knob: `--per-day <n>` caps each date at its n cheapest itineraries, so **dates × n ≤ 200**, i.e. `n = floor(200 / dates-per-direction)`. The query window never extends past what the stated leave budget can actually reach (a Thursday departure already costs one day, a Wednesday costs two), so outbound and return always have the same length: 0/0.5 leave → 2 dates × 100, 1 leave → 3 dates × 66, 2 → 4 × 50, 3 → 5 × 40. Merged weekends pack the same 200-row budget into fewer per day (6 dates × 33). On a trunk route (SZX↔BJS, 87–113 candidates/day) a 33/day cut loses 1–2 Pareto-optimal itineraries per day, while 66/day loses none. Do not lower `--max-stop` to 480: the cheapest itinerary of the day is almost always an overnight transfer, and an 8h cap costs **¥30–290 per day**; the default 960 (16h) is within ¥20 of uncapped.
- Cached responses are point-in-time snapshots, exactly like live ones — a 6-hour-old cache is still a 6-hour-old price. Check `meta.dataAt` before quoting a fare, and prefer `--refresh` right before you book.
- **Wendao is not a fare source**, but it *is* the only rough-screening source. It is used in one call to compare candidate airports (flight counts, earliest/latest landing, fare ballpark with elapsed time, drive time, resort hours) and optionally once more to confirm that a given flight operates on a given day. Its transfer coverage is roughly 9%, it sometimes misreports flight numbers, it quotes bare fares without taxes, it merges night sessions into day hours, and it is not reproducible (the same prompt can answer differently twice). Nothing from Wendao is written into `config.json`.
- The Wendao endpoint behind that skill (`externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo`) is **not publicly documented** and is not a supported public API — its response format can change, it can start demanding new credentials, or it can stop answering entirely. If that happens you lose only the rough-screening step; flight search still works.
- Resort hours, lift tickets and lodging prices are inputs you supply; the skill does not verify them.
- This is an unofficial tool. It is not affiliated with Variflight, Ctrip or Amap, and use of their services is governed by their own terms.

## License

AGPL-3.0 — see [LICENSE](LICENSE). Copyright (C) 2026 SardineFish.
