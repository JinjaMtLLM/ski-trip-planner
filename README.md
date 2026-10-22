# ski-trip-planner

An agent skill that turns "fly to the airport nearest a ski resort" into a ranked list of trip options, priced as **cost per skiable hour**.

Given an origin airport, one or more candidate destination airports and a resort, it enumerates every viable outbound × return flight pair, buckets them by **annual leave taken (0 / 0.5 / 1 / 2 days)**, computes how many hours you can actually ski and what the trip costs, then emits a filterable HTML report sorted by cost per ski day.

The interesting part is not the multiplication — it is the time boundaries: landing → arriving at the resort, leaving the resort → boarding, night-session weighting, flights that land after midnight, overnight layovers, taxes charged per flight segment. Those decide the ranking.

No resort, airport, date or price is hard-coded. Every number comes from the user and is written into a `config.json`.

## Requirements

- Node.js ≥ 18 (uses built-in `fetch`, no npm dependencies)
- Python 3.9+ — only for `tools/package.py`
- API keys, read from environment variables or `~/.workbuddy-ai/mcp.json`:

| Variable | Role | Service | Used for | Get it at |
|---|---|---|---|---|
| `VARIFLIGHT_MCP_KEY` | **required** | Variflight MCP | flights, times, tax-inclusive fares, seats | https://cmcp.variflight.com/ |
| `WENDAO_API_KEY` | optional | Ctrip Wendao | one-shot airport comparison, operating-status check | https://www.ctrip.com/wendao/openclaw |
| `AMAP_API_KEY` | fallback | Amap (Gaode) | driving time, only when Wendao can't supply it or you need an exact figure | https://console.amap.com/dev/key/app |

The Amap key must be a **Web Service** key with *Geocoding* and *Driving Direction* enabled. Keys are never written to `config.json`, never passed as command-line arguments, and never echoed back in full.

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

It merges the entry into `~/.workbuddy-ai/mcp.json` (backing up the old file, leaving other MCP servers untouched, masking the key in its output). Then click **Trust** on the custom connector in WorkBuddy's connector manager — that step can't be scripted. `--check` verifies, `--print` shows the fragment, `--remove` undoes it.

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

Ask the agent for a ski trip. It runs four steps:

0. **Credentials** — `doctor.js`, and help set up any missing key.
1. **Destination and airport** — list the airports around the resort, then rough-screen them in **one** plain-language Ctrip Wendao prompt that returns flight counts, earliest/latest landing, fare ballpark *with total elapsed time*, drive time and resort hours per airport. Take exact drive times from Amap for the shortlist, verify resort hours against the official page, and let *you* pick. Then confirm the trip skeleton.
2. **Parameters** — date range, lodging budget (resort and layover city priced separately), leave buckets, tax per segment, and the three leave-day cut-off times (work start / noon split / work end, default `08:30` / `14:00` / `20:00`).
3. **Flights** — `flight_query.js`, one call per weekend and direction; it fans the dates out from the leave bucket, direct and connecting. Raw results are cached on disk, so re-running a failed step costs nothing.
4. **Report** — `planner.js` produces the HTML.

Scripts can also be run by hand:

```bash
# driving time for a single route, with buffer applied
node scripts/amap_route.js --from "Some Airport" --to "Some Resort" --from-city "Some City"

# flights for one weekend, both directions, dates fanned out by leave days
node scripts/flight_query.js --from SZX --to CGQ --weekend 2026-12-11 --leave-days 1 --both --out weekend-1211.json

# flights for one date, direct + connecting, written as a config-ready array
node scripts/flight_query.js --from SZX --to CGQ --date 2026-12-05 --type both --out out-2026-12-05.json

# compute and render
node scripts/planner.js config.json --csv
```

`--from` / `--to` take IATA codes. Prefer **city** codes (`BJS` = PEK + PKX, `SHA` = PVG + SHA) so one query covers every airport in a city; use airport codes only when the airports sit in different cities.

`planner.js` exits with an error naming any missing config field. There are no silent defaults — that is deliberate.

### Query cache

Every flight query is expensive, so the **raw response** of each `tools/call` is written to `<skill>/.cache/` (override with `SKI_CACHE_DIR`). The cache key is a hash of the tool name plus its arguments — which include the full SQL — so the same command re-run hits the cache, while any change to dates, routes or `--per-transfer` produces a new key.

- **Freshness** — 6 hours by default (`--cache-ttl <minutes>`). A stale entry, a truncated entry, or an entry that recorded a previous failure is *not* reused in normal mode; the query is re-run instead.
- **Failure fallback** — if the live call throws (network down, key expired, tool error), the script falls back to whatever cache exists for that key and flags it as `fallback` in the metadata. You get an answer instead of a stack trace.
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
| `SKILL.md` | Skill definition and the four-step workflow |
| `scripts/planner.js` | Enumeration engine + HTML report generator. Purely parameter-driven |
| `scripts/flight_query.js` | Flight search via the Variflight MCP; fans dates out from the leave bucket, outputs config-shaped `{ out, ret }` |
| `scripts/variflight.js` | Variflight MCP client: JSON-RPC/SSE parsing, SQL builder, date windows, row mapping, cache plumbing |
| `scripts/cache.js` | Query cache: raw responses on disk keyed by tool + arguments, with freshness window, failure fallback and pruning |
| `scripts/journal.js` | Run journal: per-run record of commands, step I/O, failing SQL and cache keys, so a broken chain can be repaired without replaying it |
| `scripts/mcp_config.js` | One-command MCP setup: merges `variflight-mcp` into `~/.workbuddy-ai/mcp.json` with backup, `--check`, `--print`, `--remove` |
| `scripts/amap_route.js` | Amap driving time, outputs `toResortMinutes` including the buffer |
| `scripts/airport_scan.js` | Optional: precise multi-airport pre-query (fare + drive time on one date). Costs Variflight credits — the main flow rough-screens with Wendao instead |
| `scripts/wendao.js` | Ctrip Wendao request/parse implementation for programmatic use; not on the main path |
| `scripts/amap.js` | Geocoding and driving route implementation, shared by the route scripts |
| `scripts/keys.js` | Credential registry and the shared missing-key guide |
| `scripts/doctor.js` | Credential status; `--probe` verifies against the live APIs |
| `references/wendao-prompts.md` | Wendao prompt library: the single combined airport-comparison prompt, the operating-status check, and the phrasing rules that keep it from dropping data |
| `references/intake.md` | What to ask, how to offer options, the confirmation card |
| `references/config-schema.md` | Field-by-field `config.json` reference with a copyable skeleton |
| `references/manual-flights.md` | Manual mode: what to collect, a runnable example, and the four common mistakes |
| `references/algorithm.md` | The model: windows, leave-day rules, cost boundaries, sensitivity checks |

## How the numbers are built

- **Skiable time** — the resort's opening hours are intersected with your actual presence, day by day. Day sessions count fully; night sessions are multiplied by a weight (0.5 by default). Nights when the resort does not open night skiing are skipped.
- **Arrival / departure** — landing + transfer time to the resort; the reverse adds check-in and the drive back before departure.
- **Leave days** — outbound judged by departure time, return judged by landing time (a late-evening flight or an early-morning arrival can cost zero leave); whole working days in between are counted.
- **Cost** — fare + tax. Tax is taken from the flight's own construction-fee-plus-fuel figures when the data source provides them; only when it does not does the skill fall back to the per-segment default (a connection is two segments). Plus lodging. Late-night arrivals that land before a set hour are not charged a hotel night.
- **Multiple airports** — each flight may carry a three-letter airport code, shown next to the flight number; transfer time uses the longest drive among the chosen airports.
- **Drive time provenance** — `destAirport.toResortMinutesSource` records whether the figure is `amap` (measured), `wendao` (estimate) or `user` (stated), and the report subtitle prints it. Wendao's number is a coarse one, so it carries a 30% buffer rather than Amap's 20%.

## Development

```bash
python tools/package.py     # -> dist/ski-trip-planner.zip, whitelisted files only
```

The bundler uses the git file list, so `.gitignore` is respected and `.git/` never ends up in the archive. `tools/`, `.gitignore` and this README are dev-only and excluded; every other file must sit under `scripts/` or `references/` to be packaged at all, so local `config.json` files and query dumps can never slip into a release.

`SKILL.md`, the references and the code comments are written in Chinese — that is the language of the agent-facing instructions. This README is in English for anyone browsing the repo.

## Before you rely on it

- Fares and schedules come from third-party services as point-in-time snapshots. Prices move, connections get re-timed. Verify every itinerary on the booking page before paying.
- Only the flight lookup truly needs a key. `planner.js` needs nothing, so a total refusal to configure credentials degrades to [manual mode](#manual-mode) rather than to failure.
- Flight data comes from the **Variflight MCP** (`c-gw.variflight.com`), which is billed in credits: **100 credits per month**, charged **once per unique origin→destination city pair**, regardless of how many dates you search. `initialize` / `tools/list` are free. A single round-trip weekend therefore costs 2 credits no matter how many leave buckets you enumerate. If you run out, swap the key.
- The MCP returns at most **200 rows per SQL query** and flags it as `truncated: true`. The query builder ranks rows per direction and per transfer count so one direction can never crowd out the other, but on very dense routes you may still need a smaller `--per-transfer` or `--chunk`.
- Cached responses are point-in-time snapshots, exactly like live ones — a 6-hour-old cache is still a 6-hour-old price. Check `meta.dataAt` before quoting a fare, and prefer `--refresh` right before you book.
- **Wendao is not a fare source.** It is used in one call to rough-screen candidate airports (flight counts, earliest/latest landing, fare ballpark with elapsed time, drive time, resort hours) and optionally once more to confirm that a given flight operates on a given day. Its transfer coverage is roughly 9%, it sometimes misreports flight numbers, it quotes bare fares without taxes, it merges night sessions into day hours, and it is not reproducible (the same prompt can answer differently twice). Nothing from Wendao is written into `config.json`.
- The Wendao endpoint behind that skill (`externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo`) is **not publicly documented** and is not a supported public API — its response format can change, it can start demanding new credentials, or it can stop answering entirely. If that happens you lose only the rough-screening step; flight search still works.
- Resort hours, lift tickets and lodging prices are inputs you supply; the skill does not verify them.
- This is an unofficial tool. It is not affiliated with Variflight, Ctrip or Amap, and use of their services is governed by their own terms.

## License

AGPL-3.0 — see [LICENSE](LICENSE). Copyright (C) 2026 SardineFish.
