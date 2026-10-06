# Feature Planner — model and computations

## Document (`src/types.ts`)

The whole database is one JSON document: `GET/PUT /api/data`, stored in a single SQLite row. Every collection is a flat array addressed by id, and array order is display order.

Naming: an `Epic` is the top level (`PKG-100 Customer onboarding`); its `features[]` are what gets planned week by week; a feature's `stories[]` are the Status tab's finer grain. The route key is `?epic=`.

| Key | What |
|---|---|
| `people[]` | `{ id, name, profile, short?, defaultKind?, capacity?, away?, external?, calendarName?, resignedFrom? }` |
| `epics[]` | `{ id, key?, name, description? }` |
| `features[]` | `{ id, epicId, key?, name, status, customer?, releaseId, leadId, buddyId, testLeadId, planStart, planEnd, startWeek, endWeek, deadline, estimate, logged, remaining, cells, description, links, tracking? }` — `estimate`, `logged`, `remaining` are hours; `deadline` is a Monday week key |
| `features[].tracking` | the Status tab's text columns `{ risks?, blockers?, comment? }`; never an empty object (`patchTracking` drops it) |
| `stories[]` | `{ id, featureId, key?, name, status?, leadId?, deadline?, estimate?, logged?, remaining?, tracking? }` — the Status tab's third level, under a feature; the same columns as a feature row, no cells and no planner row. A feature with stories carries their hour sums (below) |
| `features[].cells` | `weekKey (Monday) → { entries: AllocEntry[], note? }` |
| `AllocEntry` | `{ id, personId \| null, label?, pct, kind: dev\|test\|buffer, note? }` — `personId: null` is an unnamed slot |
| `releases[]` | `{ id, name, label, date, color }` |
| `milestones[]` | `{ id, name, date, end?, releaseId?, color? }` — with `end` it is a phase (window); `color` tints its label, week headers and lines (red when unset) |
| `workstreams[]` | roadmap rows `{ id, parentId, name, color?, segments: RoadmapBar[] }` |
| `RoadmapBar` | `{ start, weeks, actualStart?, actualEnd?, status? (Planned\|In progress\|Blocked\|On hold\|Complete; absent = Planned), progress? (0–100), color?, reason?, milestone? }` — `start`/`weeks` are the plan, the rest the actual side; ◆ milestones are one-week bars with `milestone: true` |
| `settings` | `projectStart`, `horizonWeeks`, `hoursPerWeek` (30), `profiles`, `featureStatuses`, `customers`, `optionColors` (`featureStatuses`, `customers` and the fixed `roadmapStatuses`), `linkCategories`, `calendarUrl?` (the public `.ics` link the server pulls), `importMapping?` (the Status tab's default sheet import: `columns` field → header, `units`, `hoursPerDay`, `statusMap` and `personMap` keyed by the folded sheet value, `sheet`) |

A Jira key is display only and need not be unique; ids are what everything points at.

Every edit is an id-keyed closure passed to `update()` in `App.tsx`. That is what lets a 409 conflict rebase replay local edits onto another editor's document.

`server/schema.mjs` `normalize()` only fills in what is missing: arrays, settings defaults (statuses, customers, colours, link categories), entry `id`/`pct`/`kind`, and roadmap rows' `segments`/`parentId`. `migrate()` runs the versioned ladder once per document (on boot and on import). `payloadProblem()` in `shared/db.mjs` — run by the browser before the confirm prompt and by the server on every PUT — rejects a file that is not a database: `features[]`, `epics[]` or `people[]` missing; an id repeated within a collection; a `leadId`, `buddyId`, `testLeadId`, `releaseId`, `epicId`, story `featureId` or `leadId`, entry `personId`, milestone `releaseId` or roadmap `parentId` pointing at nothing; a cell or entry that is not an object; a settings field of the wrong type; a `calendarUrl` that is not `https://`. The message names the path. Every optional field stays optional, so older exports still import.

### Schema versions

| Version | What changed |
|---|---|
| 2 | the imported start/end weeks became the original plan (`planStart`/`planEnd`); `startWeek`/`endWeek` became the actual dates |
| 3 | a roadmap row's `milestones[]` became one-week bars with `milestone: true` |
| 4 | `estimate`/`remaining` are hours (× the old `hoursPerSP`, default 4, then the setting is dropped); `completedWeek` folds into an empty `endWeek` and is dropped; `tracking` keeps only `risks`, `blockers`, `comment`; the default statuses are the Jira set (`Not started → New`, `Clarify → Analyzing`, `In progress`/`Code review → In Progress`, `Testing → Need Verification`, `Done → Closed`; custom statuses stay); `customers` seeded; `Person.aliases` dropped |

`stories[]` arrived without a version bump: nothing is rewritten, `normalize()` fills the missing array, and a file from before it imports unchanged.

## Numbers (`src/logic.ts`)

- **Available %** (person, week) = `capacityPct − awayPct`. Capacity is the person's ceiling minus external commitments, day-granular. External commitments are also how *not on the project yet* and *left the project* are modelled; a `resignedFrom` date adds an implicit open-ended 100% commitment from that day (`externalEntries`), so a leaver reads as fully unavailable through the same maths.
- **Load %** (person, week) = Σ `pct` of their entries across all features. It is computed once per document in `loadIndex`.
- **Person-week state** — the Team load heatmap's colours (Capacity tab):

  | State | Rule |
  |---|---|
  | over | load > available |
  | away | available = 0 and away |
  | off | available = 0 and not away |
  | unused | load = 0 |
  | used | anything else |

- **Feature hours** (booked) = Σ `pct/100 × hoursPerWeek` over all entries, unnamed slots included. The split by kind appears in the balance tooltip.
- **Balance** = `estimate − feature hours`. It is null without an estimate.
- **Budget** (`src/status/tracking.ts`) = `estimate − logged − remaining`; null without an estimate; negative = over budget. Package rows and *Total project* on the Status tab sum estimate, logged, remaining and budget over the features that carry any of the three (`sumHours`).
- **Sheet import** (`src/status/importSheet.ts`, read through SheetJS in `readSheet.ts`): a row is matched by Jira key (trimmed, case-insensitive) to a story first, then a feature — one story, or one story plus its own feature, takes the values; one feature with no story takes them; anything else is ambiguous and skipped. A key nothing carries becomes a new story under the feature the parent-key column (then the parent-name column) names, uniquely; a parent that is a story is refused. A key repeated in the file is taken once (the first row). Rows with an empty key column are ignored (subtotals). A blank cell never clears a value; `Unassigned` / `None` count as blank; a 0h estimate is left unset. Hours are converted per column (hours, minutes, seconds, "2d 4h" with `hoursPerDay`, Excel `[h]:mm` × 24) and rounded to 0.01h; dates become the Monday week key. Hours on a feature with stories (existing or created by the same import) are not written. Statuses: the saved map, then the same word in `featureStatuses`, then Jira synonyms (`Done → Closed`, `Backlog/To Do → New`, `In Review → Need Verification`, …); assignees: the saved map, then `shared/names.mjs` (`nameKeys`, `findApproxKey`). `applyPlan` runs inside one `update()`: id lookups only, a story created once by its planned id, new statuses appended once, touched features rolled up.
- **Story roll-up** (`shared/stories.mjs`): once a feature has stories, each of its `estimate`, `logged` and `remaining` is the sum over its stories, rounded to 0.1h (a missing figure counts 0; a figure no story carries is removed from the feature). The figure is stored on the feature — every story op in `App.tsx` recomputes it, and the server's `normalize()` recomputes it on every save and at boot — so everything that reads feature hours (progress, balance, the Capacity tiles, the package sums) needs no story awareness. The UI shows such a feature's hours read-only. A feature with no stories keeps its own hours; its first story is created with the feature's figures (`addStory` in `App.tsx`), so adding it moves the hours down rather than dropping them; deleting the last story leaves the last sums in place, editable again.
- **Finished** = the status is Closed or Rejected (`isFinishedStatus`; `Done` is still accepted for old data). **Progress** = 1 when finished, else `1 − remaining/estimate`, else none.
- **Roll-up progress** (package, release, overall) = Σ(done hours) / Σ(estimated hours) over the features that carry an estimate, a finished feature counting as fully done. It is always reported alongside how many features are estimated.
- **Plan vs actual**: `planStart`/`planEnd` are the original plan; `startWeek`/`endWeek` the actual dates, falling back to the first / last week with work (`derivedStartWeek` / `derivedEndWeek`). A finished feature's end week is its finish.
- **Schedule** (`scheduleStatus`): null without `planEnd`. Finished → end week vs `planEnd`. Open → expected end (actual end) vs `planEnd`, but past `planEnd` counts as delayed by the weeks to today. Earlier = ahead, same week = on plan, later = delayed; `weeks` is the signed difference. `deadline` plays no part.
- **Cell colour**: buffer if any buffer entry, else test if any test entry, else dev.
- **Roadmap bars** (`src/gantt/bars.ts`, `barShape`): planned end = `start + weeks − 1`. No `actualStart` → not started (drawn over the planned span). Complete, or an `actualEnd` → the actual end (today when Complete without one), progress 100 when Complete. In progress → the planned length from `actualStart`; once `elapsed ≥ 1 week` or `progress ≥ 10%`, the length becomes `max(weeks, ceil(elapsedWeeks / progress))` (elapsed is day-precise from the actual start to today), the extra weeks marked `overrunFrom`. Blocked / On hold / Planned-but-started → the planned length, stretched to today when today is later; nothing estimated. `delayWeeks = end − plannedEnd`; only a positive value shows (`+Nw`). `rollup` (a row with children): min planned start, max planned end, min actual start, max end, mean progress, the most severe status (Blocked > On hold > In progress > Planned; Complete only when all are).
- **Gantt view** (`featureBars`, the planner's Gantt view): booked = weeks with at least one entry; plan = `planStart..planEnd`; slip = the weeks after `planEnd` up to the schedule's actual end (today when overdue), only for a delayed feature; early = the planned weeks after the actual end that hold no booking, only for a feature ahead of plan; stated = the weeks from the actual start to the actual end that are neither booked nor slip; `done` = the end week of a finished feature (the ✓). A package row draws the envelope of its features' plans and the union of their booked weeks.
- **Colours** (`src/theme.ts`): every stored tag, release and workstream colour is snapped onto the nearest step of the app's palette for painting (lightened on dark surfaces); storage keeps what the user picked.

## Vacation sync (`server/vacations.mjs`)

The server resolves the link (`resolveCalendarUrl`: `settings.calendarUrl` when it is `https://`, else `VACATION_CALENDAR_URL`, else off), fetches it, parses the VEVENTs (`parseIcs`) and merges them into `people[].away` (`applyCalendar`): a `Name - Kind` event becomes an away entry of the mapped type on the matched person (`KIND_TO_TYPE`, case-insensitive); a `Public holiday` shared by more than half of the calendar's names, and any event with no `Name - ` part, go to everyone (`companyHolidays`, `sharedHolidaysOf`). Imported entries carry `source: 'calendar'` and the event's `uid`; a sync replaces them from the feed's earliest date onwards, keeps older imported history, and drops a manual entry of the same type lying wholly inside an imported one. Nothing changes on an empty feed. People whose `resignedFrom` has passed are skipped.

## Files

| Path | Role |
|---|---|
| `src/grid/FeatureGrid.tsx` | planner grid, timeline row, keyboard, field pickers |
| `src/grid/CellPopover.tsx` | cell / range / person-week popovers |
| `src/rows.ts` | package → feature tree, optional group level (`groupKey`), search text |
| `src/capacity/CapacityView.tsx` | Capacity tab |
| `src/status/StatusView.tsx`, `src/status/tracking.ts` | Status tab: the hours / budget / deadline / notes table (features under packages, stories under features, stories added and deleted inline) and its column definitions (`budgetHours`, `sumHours`, tested in `tracking.test.ts`) |
| `src/status/importSheet.ts`, `src/status/readSheet.ts`, `src/status/ImportDialog.tsx` | the sheet import: the pure mapping / planning / applying module (tested in `importSheet.test.ts`), the SheetJS reader (loaded on demand), and the two-step dialog |
| `shared/names.mjs` | person-name matching (`matchKey`, `findApproxKey`, `nameKeys`) for the calendar sync and the sheet import |
| `shared/stories.mjs` | the story roll-up (`storyHours`, `syncFeatureHours`, `syncAllFeatureHours`), imported by the browser and the server (tested in `server/stories.test.mjs`, together with the stories cases of `payloadProblem` and `normalize`) |
| `src/ui/fields.tsx` | `NumberInput`, `TextInput`, `NoteInput`, `WeekInput`, `Bar` — inputs shared by the grid, the popovers, the dialogs and the Status tab |
| `src/ui/pickers.tsx` | status / customer / release / person cells and their pickers — the Planner and the Status tab render the same ones, for features and stories alike |
| `src/ui/Popover.tsx`, `src/ui/useTip.tsx`, `src/ui/ConfirmDialog.tsx` | anchored popover + `PctButtons`; floating tooltip; confirm dialog |
| `src/ui/FilterBar.tsx`, `src/ui/SettingsMenu.tsx`, `src/ui/useHashRoute.ts` | filter dropdowns; the ⚙ menu; the `#/view?…` route |
| `src/theme.ts` | the colour palette tag / release / workstream colours are snapped onto |
| `shared/db.mjs` | seed defaults (statuses, customers, colours, link categories, kinds), `isCalendarUrl()` and `payloadProblem()`, imported by both the server and the browser |
| `server/schema.mjs` | `normalize()` and the `migrate()` ladder (tested in `schema.test.mjs`) |
| `server/vacations.mjs` | calendar parsing, matching and merge rules (tested in `vacations.test.mjs`) |
| `src/gantt/GanttView.tsx`, `src/gantt/bars.ts` | Roadmap tab; the bar maths (tested in `bars.test.ts`, vitest) |
| `src/ui/FeatureDialogs.tsx` | Feature, Package, Releases & milestones, roadmap row dialogs |
| `src/ui/Dialogs.tsx` | Modal, People, Settings, links editor |
| `scripts/make-seed.mjs` | builds the demo `server/seed.json` |
| `scripts/make-favicon.py` | draws `public/favicon.png` and the touch icon |
