# Feature Planner

A planner for delivery teams: which features exist, who works on each of them which week, how far along they are, how many hours they have used, whether the team has the capacity, and how the high-level roadmap looks. Every team has its own plan — people, packages, releases, milestones, roadmap and settings — picked in the header; four tabs share it, and a built-in **Program** team shows the same four tabs across every team at once (capacity per team, every feature, each team's critical path):

| Tab | Answers |
|---|---|
| **Planner** | Features × weeks: who works on what, and progress |
| **Capacity** | Progress per release and package, availability vs booked, overbooking |
| **Status** | Hours, budget, deadline, risks and blockers per feature |
| **Roadmap** | The high-level plan: workstreams, activities and milestones |

React + TypeScript + Vite + TanStack Table in the browser; Express + SQLite on the server, holding each team's plan as one JSON document with optimistic concurrency, autosave, backups, optional Keycloak auth and a public-calendar vacation sync.

It ships with three invented demo teams. *Demo team* (`server/seed.json`) exercises every state the app can show: people, packages, features (six of them split into stories), releases, milestones and roadmap rows. *Mobile apps* and *Data platform* (`server/seed-teams.json`) are smaller plans with their own people and settings, so switching teams shows something different. The *Program* comes with its own cross-team roadmap and a few notes. A fresh database holds all of them. Replace them with your own through ⚙ Settings → Import…, edit them in place, delete them, or create your own teams next to them.

Data model and every formula: **[docs/feature-planner.md](docs/feature-planner.md)**. Known limitations and the refactoring backlog: [docs/improvements.md](docs/improvements.md).

## Contents

1. [Quick start](#quick-start)
2. [Teams](#teams) · [The Program](#the-program)
3. [Concepts](#concepts)
4. [Planner](#planner)
5. [Capacity](#capacity)
6. [Status](#status)
7. [Roadmap](#roadmap)
8. [People](#people)
9. [Releases, milestones and settings](#releases-milestones-and-settings)
10. [Vacation calendar sync](#vacation-calendar-sync)
11. [Data, saving and backups](#data-saving-and-backups)
12. [Authentication and roles](#authentication-and-roles)
13. [Run, test and deploy](#run-test-and-deploy)
14. [Project layout](#project-layout)

## Quick start

```bash
just dev            # installs deps if missing, then runs the storage server + Vite on random free ports (prints both URLs)
npm run dev         # the same without just
npm run dev:fixed   # server on 3179 + Vite on 5174
```

Open the Vite URL. The database `data/db.sqlite` is created on first start with the three demo teams (or with one team *Default* from `data/db.json` when that older file exists). To add the two extra demo teams to a database that already has teams, run `just demo-teams <server URL>`. A database from before teams existed keeps its plan as the team *Default*, and its backups move into that team's folder. To start over on the demo, stop the server and run `just reset-db` (it removes every team).

**URLs.** The team and the view are in the hash, and every tab or team switch is a browser-history entry, so Back works: `#/<team>/planner`, `#/<team>/capacity`, `#/<team>/status`, `#/<team>/roadmap`, where `<team>` is the team's id (see [Teams](#teams)). Deep links: `#/<team>/planner?feature=<id>` or `#/<team>/planner?epic=<id>` opens the planner on that row; `#/<team>/capacity?at=attention` and `#/<team>/capacity?at=scope` jump to those sections. A link without a hash reopens the team and tab you used last; a link without a team (`#/planner…`, from before teams) opens the team you used last; a link to a team that no longer exists says so and falls back.

**Header.** The 👥 **team switcher** (the current team's name; every team with its feature and people counts, and for editors **+ New team…** and **Manage teams…**), the four tabs, then ✎ **People** and **+ Package** (editors only), the save badge (*Saved* / *Saving…* / *Save failed*) and the ⚙ **Settings** menu: theme (🖥 system / ☀ light / 🌙 dark, remembered per browser), **Export…**, **Backups ▾**, **Import…**, **Settings…**, **Releases & milestones…**, **Sync vacations now**, **Log out**. Everything in ⚙ Settings acts on the current team. Viewers see only the theme, Export and Backups.

## Teams

A team is a completely separate plan: its own people, packages, features and stories, releases and milestones, roadmap, and settings (statuses, customers, colours, hours per week, calendar link, import mapping). Nothing is shared between teams, and every tab shows the team picked in the header. Everyone who can open the app sees every team; the viewer and editor roles apply to all of them.

- **Switch** with the 👥 menu in the header. A pending autosave lands before the switch, and the filters, grouping and expansion you set are remembered per team and per browser. Browser Back returns to the previous team.
- **+ New team…** (editors) asks for a name and, optionally, a team to **copy settings from**: project start, horizon, hours per person-week, statuses, customers, colours, profiles and link categories. The new team starts with no people, packages, releases or roadmap. The vacation calendar link and the sheet-import mapping are never copied — one is another team's roster, the other names that team's people. Leave the copy empty to start from the defaults.
- **Manage teams…** (editors) renames (Enter or click away saves) and deletes. A team's **id** is the slug of the name it was created with (`Platform team` → `platform`; `-2`, `-3` on a collision), is what links carry, and never changes with a rename. The view names `planner`, `capacity`, `status`, `roadmap` and `api` are not available as ids. Deleting a team removes its whole plan after a confirm that shows its counts; the server snapshots the plan to the team's backups first (`data/backups/<team>/…-delete.json`), and the last team cannot be deleted.
- **Export…** and **Import…** act on the current team, so importing one team's export into another is the way to copy a plan. **Backups ▾** lists the current team's snapshots.

### The Program

**Σ Program** is a built-in team, first in the switcher, that reads every other team instead of holding people and features of its own. It exists in every database (the server creates it on start; it cannot be deleted, and no team can take its id `program`), it can be renamed, and new teams join it automatically. Its four tabs are the other teams at a higher level:

- **Planner** — read-only: every team's features (team → package → feature) with status, lead, release, hours, progress and schedule, and in the week cells the FTE each feature books instead of who. Hover a cell for the people; click a feature to open it in its team's planner (Back returns).
- **Capacity** — the teams instead of the people: a tile per team (progress, next release, delayed / blocked / overbooked), the booked-vs-available chart with every team summed (hover for the split), a **Team load** table with one row per team showing *booked / available* FTE per week (red when the team as a whole is over), then the Scope Overview and Needs attention lists over every team's features, each tagged with its team.
- **Status** — every team's features (no stories) with the hours and budget as the team keeps them, read-only, plus **Risks / issues**, **Dependencies / blockers** and **Comment** that are the Program's own notes per feature; the team's own note shows beneath in grey. Program notes never touch the team's document.
- **Roadmap** — first a read-only **Critical path per team**: one bar per team from its earliest roadmap bar to its latest (planned start to planned end dotted, earliest actual start to latest actual or forecast end solid, mean progress, the most severe status), with that team's releases ⚑ and milestones ◆ in the row; click it to open the team's roadmap. Below, the Program's own workstreams, releases and milestones, edited as on any roadmap.

The Program reads the teams when it opens and when its tab comes back after a minute; **↻ Refresh** in the tools row reloads them (the time shown is the snapshot's). Filters on its Planner and Status tabs are Team, Status and Customer (the union across teams), *Hide finished* and search. ⚙ Settings holds only the roadmap's start, horizon and status colours; People, + Package, the sheet import and the vacation sync are not offered. Export, Import and Backups act on the Program's own document (`program.tracking` holds the notes, keyed `<team>:<feature>`).

## Concepts

- **Package → feature → story.** The top level is a *package* (`PKG-100 Customer onboarding`); under it sit its *features*, which are planned week by week; on the Status tab a feature can be split into *stories*, which carry the hours. In the stored document a package is an `Epic` in `epics[]` and the deep-link key is `?epic=`; only the words on screen say package.
- **Weeks.** Everything is planned in whole weeks keyed by their Monday. The timeline starts at the project start (⚙ Settings) and runs for the horizon, stretching when something is planned beyond it.
- **People and kinds.** A person has a profile (Engineer, QA, BA, or your own), a capacity and periods away or outside the project. Each booking has a *kind*: **Dev**, **Test** or **Buffer** (fixed), and a percentage of the week.
- **Hours.** A person-week is 30 h by default (⚙ Settings → *Hours per person-week*). A feature's *booked* hours are the sum of its bookings; its *estimate*, *logged* and *remaining* hours are entered by hand (or imported), or summed from its stories.
- **Plan vs actual.** Each feature keeps its *original plan* (planned start and end week) apart from what happened (actual start and end). The Roadmap's bars work the same way: a planned span and an actual span.
- **Statuses and customers.** Feature statuses default to the Jira set (`New, Open, Analyzing, In Progress, Need Verification, Blocked, Closed, Rejected`); Closed and Rejected count as finished everywhere and Blocked feeds the Capacity tab's *Needs attention* list. Statuses, customers and their colours are edited in ⚙ Settings.

## Planner

Features grouped under their packages, one column per week.

**Toolbar.** *Group by*: **By package / By release / By status / By lead / By customer**. A depth stepper (**Collapse All · Packages · Features**, or Releases/Statuses/Leads/Customers when grouped that way). **Filters** (shared with the Status tab). **Compact fields** keeps only Status and Lead. **Narrow weeks** fits more of the timeline on screen. **From today** starts the timeline four weeks before today. **Gantt view** swaps names for bars (below), with **Show planned** beside it. The search box (*Search packages, features, people…*) also matches Status-tab notes and story names and keys. Drag the edge of the name column to resize it, double-click to reset.

**Rows.** An optional group, then package rows, then feature rows. A package row shows its feature count, a **+ Feature** button, and roll-ups: estimate, remaining, hour-weighted progress and *N delayed*; its week cells show how many FTE are booked on the package that week.

**Feature columns** (each edited in place by clicking it):
- **Status**, **Customer**, **Release**, **Lead**, **Buddy**, **Test lead**.
- **Estimate (h)** and **Remaining (h)**, read-only once the feature has stories (*Sum of N stories — edit them in the Status tab*).
- **Progress** = 1 − remaining ÷ estimate; a finished feature reads 100%.
- **Schedule**: **Ahead**, **On plan** or **Delayed** with the number of weeks. It compares planned and actual end weeks; the actual end is the stated end or, when empty, the last booked week; an open feature past its planned end counts as delayed up to today. *—* means no planned end yet.

**Week header.** Months, then a timeline row: a milestone with an end date is a *phase* and shows its name across its weeks; a one-day milestone (a code freeze, say) or a release date sits on its own week. Their week headers are tinted in the event's colour and thin lines in that colour run down the grid. Then `W##` with the date, and a *today* chip.

**Week cells.** A cell holds the people on that feature that week.
- Each entry has a **%** of the week (0, 20, 40, 60, 80 or 100), a **kind** (Dev / Test / Buffer) and an optional **note**; the cell takes the colour of its kind (yellow dev, blue test, magenta buffer).
- A cell can also hold **unnamed slots** (+ Dev / + Test / + Buffer, for work nobody is assigned to yet) and a **cell note** not tied to anyone. A corner triangle marks a note.
- A red chip means the person is booked beyond their availability that week; a struck-through name is away all week; `!` after the name is away part of the week. Hover the cell for everyone's kind, %, notes and availability.

**Editing.**
- Click a cell to select it; click it again, double-click, or press `Enter` to open its editor. The person picker (*Add person…*) ranks people by how free they are that week and labels each *free N%*, *over N%*, *away*, *resigned* or *not on the project*. **Same as last week** and **Clear** are one click.
- Drag across weeks to select a range; `Enter` opens the range editor: **Add to all N weeks** at a %, **Copy**, **Repeat first week**, **Clear N weeks**.
- Keys: `↑↓←→` or `hjkl` move, `Shift+←→` extends the selection, `Enter` edits, `R` repeats last week, `⌫` clears, `⌘C` / `⌘V` copy and paste weeks (copied cells get a dashed outline; paste also works inside an open editor), `Esc` clears the selection.
- Viewers can press `Enter` on a cell to read it.

**Gantt view.** Each feature row becomes one lane: the **planned** weeks as a thin dotted bar above (hidden by *Show planned*), the **booked** weeks as a solid bar in the kind's colour. A bar past the dotted end is the slip: booked weeks past the planned end get a red underline, unbooked ones a red hatch up to the forecast end (today when overdue). A feature finished ahead of plan shows a green hatch over the planned weeks it did not need, and ✓ marks the week a finished feature ended. Weeks inside the actual span with nobody booked are neutral grey. Package and group rows show the envelope of their features' plans and the union of booked weeks, shaded by FTE. Hovering names who is booked and adds planned vs actual weeks with the delta; clicking, keys and editors work as with names.

**Feature dialog** (click a name, or ⓘ on the Status tab): **Jira key**, **Name**, **Package**, **Status**, **Target release**, **Feature lead**, **Feature buddy**, **Test lead**, **Customer**, **Deadline** (a week; informational, shown on the Status tab), **Estimate (h)**, **Logged (h)**, **Remaining (h)**; a **Schedule** block with the *Original plan* (planned start and end, **Set plan from current** copies the current weeks) and the *Actual* start and end (empty values follow the booked weeks); a stats line (Progress · Estimate · Booked · **Balance** = estimate − booked · **Budget** = estimate − logged − remaining); a Markdown **Description** with Write / Preview; and **Links** (+ Add link, with a category and a source detected from the URL such as Figma, Miro or Notion). **Delete** removes the feature.

**Package dialog** (+ Package, or click a package name): Jira key, Name, Description. Deleting a package removes its features and stories.

## Capacity

- **Tiles**: *Overall progress*, one tile per release (progress, hours left, the next ◆ milestone, open features scheduled past the release date, counts by status), and *Overbooking from today* listing person, week and %.
- **Booked vs available, per week**: stacked FTE columns by kind against the available line; hover a column for the week's totals and everyone booked that week. Its own **From today** checkbox starts it four weeks before today.
- **Team load**: developers and testers, one row each, with the % of each week booked (green free, yellow booked, red over, hatched away, blank not on the project, an orange bar for a partly-away week), then **Available / Booked (dev · test · buffer) / Free FTE** per week. Hover a cell for the person's load against their availability; click it to see the features behind it, **Mark away this week** (with the away type) or **Edit person…**; click a name to edit the person. Availability = capacity − external allocation − away days (20% per weekday).
- **Scope Overview**: one row per package with its features count, estimate, remaining, progress, booked hours and balance; ▸ expands it to its features with their status and customer. A name jumps to the planner row; Back returns here with the same packages open.
- **Needs attention**: **Booked beyond estimate**, **Work left, nobody booked from today**, **Delayed** (by how many weeks) and **Blocked**. An item jumps to the planner with the row centred; Back returns to the list.

## Status

The tracking sheet as a tab: one row per feature under its package and one per story under its feature, every value edited in place. The columns mirror a Jira status export:

- **Description** (Jira key and name), **Status** and **Assignee** (the feature lead) are the planner's own fields; a change here shows in the Planner and vice versa. These three stay pinned while the rest scrolls.
- **Original estimate (h)**, **Logged (h)**, **Remaining (h)**; **Budget (h)** = original − logged − remaining, red when negative. Package rows sum the four columns and **Total project** in the header sums every listed feature.
- **Deadline**: the week the feature is due, shown as `W46 · 9 Nov`; the date picker snaps to a Monday.
- **Risks / issues**, **Dependencies / blockers**, **Comment**: free text (Enter saves, Shift+Enter for a new line, Esc cancels).
- **Stories**: hover a feature and click **+ Story** (Enter adds and keeps the box open, Esc closes). A story row has the same columns; key and name are edited in place; ✕ deletes after a confirm. The first story of an estimated feature takes the feature's hours with it; from then on the feature's three hour figures are the sum of its stories (greyed here, read-only in the Planner and the feature dialog).
- ▸ folds a package or a feature with stories; the **Collapse All / Features / Stories** stepper sets the depth for all of them (remembered per browser); a search opens everything. The planner's filters and search apply here too, and the search also looks in the notes and the stories. ⓘ opens the feature dialog; a name jumps to the planner row.

**Import sheet…** (editors) takes a Jira export (`.xlsx`, `.xls`, `.xlsm`, `.csv`, `.tsv`) and fills these columns:
1. **Columns**: pick the sheet, the header row and *Hours in a Jira day*, then which column feeds each field: **Jira key** (required), Name, Parent key, Parent name, Status, Assignee, the three hour figures with their unit (hours, minutes, seconds as in a Jira CSV, days such as `2d 4h`, or an Excel `[h]:mm` time), Deadline, Risks / issues, Dependencies / blockers, Comment. A budget column such as Jira's `BAC` maps to Original estimate, since Budget is computed.
2. **Review**: what would happen row by row before anything is written, filterable by **All / Updated / Created / Skipped / Unchanged**. Rows are matched by Jira key to a story first, then a feature; a row nothing carries becomes a new story under the feature named by the parent column, else it is skipped; a blank cell leaves the value alone; a feature with stories keeps their sum, so import the stories' rows. Jira status synonyms (Done → Closed, …) are mapped automatically; *Statuses the app does not know* and *Assignees no person matches* are mapped here (to an existing value, a new status, or left alone). Tick **Save as the default mapping** and the next export is pre-mapped for everyone, since the mapping lives in the database settings. **Import N rows** applies it.

## Roadmap

The high-level plan: **workstream → group → activity** rows, with bars, ◆ milestones and release lines. Toolbar: **Collapse all**, **Expand all**, **+ Workstream**, **Show planned**, **Late / blocked only**, and a legend of the bar statuses.

**Rows.** Click a name to edit the row (**Name**, **Parent**, **Workstream colour**, and its list of bars with planned start · weeks · ◆ milestone). Each row has ↑ ↓ to reorder and ＋ to add a sub-row. A row with sub-rows shows a **roll-up** bar instead of bars of its own: the earliest start, the latest end, the mean progress and the most severe status of its descendants.

**Bars.** Every bar has a **Planned** side (start week + weeks) and an **Actual** side (actual start and end, status, progress, colour, reason).
- **Add**: drag across empty weeks on a row without sub-rows (a single click adds a one-week bar). Only the solid bar of an existing bar blocks the drag; its dotted plan line does not.
- **Merge**: when the new span touches or overlaps an existing bar, a **Merge bars?** prompt appears. **Merge** stretches that bar over both spans and keeps its status, progress, colour and reason (a Complete bar's actual end, or a started bar's actual start, move along so the drawn bar really grows); a span that bridges two bars merges all of them into the earliest. **Keep separate** (also Esc) adds the bar on its own. Milestones are never merged.
- **Edit**: click a bar. The dialog has **Start week** and **Weeks**, **Actual start** and **Actual end**, **Status** (Planned, In progress, Blocked, On hold, Complete), **Progress %**, **Colour** (*Auto (by status)* or *Custom*), **Reason / Jira** (for Blocked and On hold), the **Milestone ◆** flag and **Delete bar**. Picking a status fills today as the actual start; Complete also sets 100% and the actual end.
- **Drawing**: the planned span is the thin dotted bar above (hidden by *Show planned*); the actual span is the solid bar coloured by status, with the status and progress written on it (or beside it when the bar is short) and the darker part showing the progress. A bar with no actual start is a grey *Planned · not started* over its planned span. While **In progress** the end is re-estimated from the progress (time elapsed ÷ % complete) once a week has elapsed or the progress passes 10%, never shorter than planned; the weeks past the planned length are hatched red. **Blocked / On hold** bars are hatched in their colour, show the reason, are not re-estimated and stretch to today only when today is past their end. **Complete** fills to the actual end. **+Nw** in red after a bar is how many weeks its actual (or forecast) end is past the planned end.
- **◆ milestones** are one-week bars flagged as milestones, drawn as a diamond.
- **Late / blocked only** keeps the rows with a bar past its planned end, Blocked or On hold, and their parents.
- The week header marks release weeks with ⚑ and milestone weeks with ◆, and shades milestone windows. Status colours come from ⚙ Settings → *Roadmap status colours*; a bar can override its colour.

## People

✎ **People** lists everyone grouped by profile, with chips for *Resigned*, *cap N%*, *ext N%* and *Away*, a search box and **Hide resigned** (on by default, per browser: hides people whose unavailable-from date has passed; someone serving notice stays visible so their handover can be planned). A person opens read-only; **Edit** changes:

- **Name**, **Profile**, **Short name** (the chip label), **Usually works as** Developer / Tester (the default kind for new bookings), **Capacity** (%), **Calendar name** (how the vacation calendar names them).
- **Away** periods: Vacation, Sick, Public holiday, Parental, Training, Borrowed out, Other. Periods imported from the calendar carry a *calendar* chip and are read-only.
- **External allocation** periods: time outside the project at a %, optionally open-ended (*onwards*). Someone who joins late or leaves the project is an open-ended external entry at 100%.
- **Resigned** with the date they are **unavailable from**: from that day their capacity reads 0 everywhere, the name is struck through, and any booking past the date shows as overbooked, to be reassigned.

**+ New person…** adds one; **Delete** removes one.

## Releases, milestones and settings

**⚙ Settings → Releases & milestones…**
- **Releases**: name, label, release date, colour (used for the ⚑ week header and the timeline line), and the number of features targeting it.
- **Milestones**: name, date, optional **End**, release, colour. A milestone with an end date is a window (a system test phase) and shows its name across its weeks; without one it is a one-day event (a code freeze).

**⚙ Settings → Settings…**
- **Project start** (snapped to a Monday) and **Horizon (weeks)**: the timeline.
- **Hours per person-week** (default 30): what a 100% booking is worth.
- **Feature statuses** and **Customers**: add, remove, drag to reorder, pick colours. Removing one leaves features that use it unchanged.
- **Roadmap status colours**: the five fixed roadmap statuses.
- **Profiles** and **Link categories**.
- **Vacation calendar**: the public `.ics` link (https only), see below.

**⚙ Settings → Export…** downloads the whole database as `feature-planner-YYYY-MM-DD.json`. **Import…** replaces it with such a file after a *Replace database* confirm that shows the before/after counts; the server snapshots the current database first. **Backups ▾** lists the server's snapshots; click one to download it.

## Vacation calendar sync

Paste the **public `.ics` link** of the team's vacation calendar into ⚙ Settings → Settings… → *Vacation calendar*; each team has its own (`VACATION_CALENDAR_URL` in the environment is a fallback for every team without one). The server pulls it on start, every `VACATION_SYNC_HOURS` (default 6, `0` turns the timer off) and on ⚙ Settings → **Sync vacations now**, and writes the away periods itself; the toast reports how many people matched. The timer walks every team, so a link added later, or a team created later, is picked up on the next tick.

- **Events** are expected as all-day `Name - Kind`, the description becoming the note. Kinds: vacation / holiday / annual leave → Vacation; sick → Sick; national or public holiday → Public holiday; parental, maternity, paternity → Parental; training → Training; borrowed out → Borrowed out; other, marriage → Other. Recurring events (birthdays) are skipped.
- **Matching** is by the person's **Calendar name**, else their name, folding case, accents and spacing; a shortened first name with the same surname is accepted when it is unambiguous, and a hyphenated or multi-part first name matches its first part. People already past their resigned date are skipped. The People dialog says whether each person was found at the last sync.
- **Company-wide holidays**: a public holiday that more than half of the calendar's names share goes to everyone, and so does an event with no `Name - ` part, so a plain public-holidays calendar works through the same link.
- **Merging**: imported periods (chip *calendar*) are replaced on every sync from the feed's earliest date on; a hand-typed period of the same type wholly inside an imported one is dropped as a duplicate; an empty feed changes nothing.

Rules and tests: [`server/vacations.mjs`](server/vacations.mjs), `npm test`.

## Data, saving and backups

Each team's plan is one JSON document in a row of `data/db.sqlite` (WAL mode; the `teams` table holds the names and order, `docs` the documents). The browser loads it with `GET /api/teams/<team>/data` and autosaves it with `PUT /api/teams/<team>/data` about half a second after every edit. Switching teams, Back/Forward across teams and closing the tab wait for, or warn about, a pending save.

- **Concurrency.** Every save echoes the `X-Data-Version` it last saw; the write lands only if the store is still at that version, otherwise the server answers 409 and the browser replays its unsaved edits onto the other editor's document and saves again (*Merged another editor's change*, or *…; N of your edits no longer applied* when something no longer fits).
- **Backups** go to `data/backups/<team>/` as `db-<timestamp>-<reason>.json`: `startup` on every boot (skipped when identical to the newest), `daily` at most once a day on save, `import` before every import, `delete` before a team is deleted (its folder stays). The newest `BACKUP_KEEP` (default 30) are kept per team; ⚙ Settings → Backups lists and downloads the current team's.
- **Validation.** An import is checked the same way in the browser and on the server (`shared/db.mjs`): every id unique, every reference to a person, package or release resolving, every cell a real object, and the error names the path that is wrong. Older exports are upgraded on import (`server/schema.mjs`): story points become hours, a completed week folds into the end week, the old readiness checklist is dropped, old status names map onto the new ones. A document from a newer version is never downgraded.
- **Demo data.** `scripts/make-seed.mjs` builds `server/seed.json` (Demo team) and `server/seed-teams.json` (Mobile apps, Data platform, and the Program's own roadmap and notes) deterministically from a fixed project start (`just seed`), one builder per team in `scripts/seed/`, and validates every document with the import check; edit the builders, not the JSON. The seeds are only read when the database has no team yet. `scripts/add-demo-teams.mjs` (`just demo-teams <url>`) loads the extra teams into a running server: it creates each team whose name is free and imports its plan, skips the rest, and fills the Program only while it is still empty.

Routes: `GET /api/auth/config`; `GET /api/teams` (the Program carries `builtin: true`), `POST /api/teams` (`{ name, copySettingsFrom? }`), `PATCH /api/teams/:id` (`{ name }`), `DELETE /api/teams/:id`; per team `GET|PUT /api/teams/:id/data`, `GET /api/teams/:id/backups`, `GET /api/teams/:id/backups/:name`, `GET /api/teams/:id/vacations/status`, `POST /api/teams/:id/vacations/sync`; `GET /api/program/teams` (every team but the Program, each with its document and version, for the Program's tabs). An unknown team answers 404; a duplicate name, deleting the last team or deleting the Program 409. The store itself (tables, team CRUD, per-team writes and backups, the move from the single-plan layout) is `server/store.mjs`, tested in `server/store.test.mjs`.

## Authentication and roles

Auth is off unless `OIDC_ISSUER` is set, and with it off everyone is an editor. For a read-only preview without auth, set `localStorage['feature-planner:viewer-preview'] = '1'`.

With auth on, the browser logs in through Keycloak (PKCE) and the server verifies every token against the issuer's keys. Roles, the same for every team: `feature-planner-viewer` (read everything, export, download backups) and `feature-planner-editor` (everything, including creating, renaming and deleting teams). Viewers see a *Read-only* badge and the toast *Read-only — editor role required* on any edit; a user with neither role is told to ask an admin.

`docker compose up -d` starts a Keycloak (admin / admin on port 8080) with a `feature-planner` realm, a public `feature-planner` client, both roles and two test users (`viewer` / `viewer`, `editor` / `editor`). Then run the app with `OIDC_ISSUER=http://localhost:8080/realms/feature-planner npm run dev`. `OIDC_CLIENT_ID` (default `feature-planner`) and `OIDC_AUDIENCE` are optional.

The full walkthrough — login flow, token refresh, server middleware, route-to-role table and client-side gating — is in [docs/authentication.md](docs/authentication.md).

## Run, test and deploy

| Command | What |
|---|---|
| `just dev` / `npm run dev` | storage server + Vite on random free ports |
| `npm run dev:fixed` | server on 3179 + Vite on 5174 |
| `npm run build` | `tsc` + `vite build` into `dist/` |
| `npm run server` | the server alone (serves `dist/` when it exists) |
| `npm test` / `just test` | vitest over `src/` (bar maths, Status sums, sheet import, the hash route) and `node --test` over `server/` (schema migrations, story roll-up, calendar parsing and merge rules, the team store) |
| `just typecheck` | `tsc --noEmit` |
| `just seed` | regenerate the demo seeds (`server/seed.json`, `server/seed-teams.json`) |
| `just demo-teams URL` | add the Mobile apps and Data platform demo teams to a running server (existing ones are skipped) and fill an empty Program with its demo roadmap and notes |
| `just reset-db` | delete the database and every team in it (stop the server first) |
| `just favicon` | redraw the icons (needs Pillow) |
| `just release IMG=<registry>/feature-planner` | build for linux/amd64 and push |

| Environment variable | Default | What |
|---|---|---|
| `PORT` | 3179 | server port |
| `DATA_DIR` | `data/` | where the database and its backups live |
| `BACKUP_KEEP` | 30 | snapshots to keep |
| `OIDC_ISSUER` | unset | turns auth on |
| `OIDC_CLIENT_ID` | `feature-planner` | client id |
| `OIDC_AUDIENCE` | unset | optional `aud` check |
| `VACATION_SYNC_HOURS` | 6 | calendar sync interval, `0` = off |
| `VACATION_CALENDAR_URL` | unset | fallback calendar link for every team without one |
| `API_URL` | `http://localhost:3179` | where Vite proxies `/api` in development |

`Dockerfile` builds a single image that serves the API and the built app on `PORT`; mount a volume at `/app/data` to keep the database and its backups.

## Project layout

| Path | What |
|---|---|
| `src/App.tsx`, `src/main.tsx` | the shell: theme, the team list, which team the hash names, the team switcher and its dialogs |
| `src/Plan.tsx`, `src/useAutosave.ts` | one team's plan: filters, dialogs, the four tabs; the autosave and conflict replay it shares with the Program |
| `src/program/` | the Program team: the other teams' snapshot, the pure aggregation (critical path, team load, the week axis) and its Capacity, Status and read-only Planner tabs |
| `src/grid/` | Planner tab |
| `src/capacity/` | Capacity tab |
| `src/status/` | Status tab and the sheet import |
| `src/gantt/` | Roadmap tab (with the Program's pinned critical-path rows) and the bar maths |
| `src/ui/` | dialogs, pickers, settings menu, team menu and team dialogs, filter bar, the hash route |
| `src/logic.ts`, `src/types.ts` | the calculations and the document types |
| `shared/` | code used by both the browser and the server: import check and defaults, story roll-up, name matching |
| `server/` | Express routes, auth and the per-team vacation sync (`index.mjs`); the team store, backups and the single-plan migration (`store.mjs`); schema migrations; calendar rules; the demo seed |
| `scripts/` | dev launcher, the demo seed builders (`make-seed.mjs` and `seed/`, one per team plus the Program), the demo-team loader, icon script |
| `docs/` | [data model and formulas](docs/feature-planner.md), [backlog](docs/improvements.md) |
