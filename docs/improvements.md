# Improvements and refactoring backlog

What a full read of the app turned up on 2026-09-24 that was **not** done in the cleanup pass of that day (that pass moved the import check and the seed defaults into `shared/db.mjs`, and shared the field pickers, week tags and month headers between the Planner and Status tabs), updated on 2026-10-06 when the app was made generic (hours instead of story points, the Status tab remapped, `server/schema.mjs` extracted and tested). Each item names the evidence so it can be picked up cold. Effort: S under an hour, M a few hours, L a day or more. Line numbers are as of those dates and will drift.

## High

### 1. Dialog saves replace whole objects, so a rebase can undo someone else's change — M
The 409 handling replays each buffered edit onto the server's fresh document. That merges well only when an edit touches specific fields by id. These edits instead write back the whole copy the dialog opened with:
- `src/Plan.tsx` — people: `d.people = next` (People dialog save), feature: `d.features[i] = { ...next, cells }`, releases and milestones: `d.releases = releases; d.milestones = milestones`, settings: a top-level spread.
- `src/gantt/GanttView.tsx` — `d.workstreams[i] = g`.

The People dialog is the worst case: the server's calendar sync (every `VACATION_SYNC_HOURS`) rewrites `away[]` while the dialog is open, and the save then reverts it. Fix: each dialog computes the diff between its opening snapshot and the draft and the save op applies only those fields, per id (`Object.assign` on the fresh record). People: per person. (The feature dialog's save already re-runs the story roll-up on the fresh record, so a feature's hours cannot be reverted this way; the other fields can.)

### 2. Side effects inside a React state updater — S
`update()` in `src/Plan.tsx` pushes onto `unsavedOps` and calls `scheduleSave` inside `setDb((prev) => …)`. `src/main.tsx` wraps the app in `<React.StrictMode>`, which invokes updaters twice in development, so every edit is queued twice. On a 409 replay, `addEntry` for an unnamed slot and `addAway` then create duplicates (dev only, but the same shape will bite as soon as anything else double-invokes). Fix: keep the current document in a ref, apply the edit to a clone, then `setDb(next)`, push the op and schedule outside the updater.

### 3. A failed save is never retried, and closing the tab loses unsaved work — S
`flush()` clears `pendingRef` before the PUT; on a non-409 error it sets `saveState = 'error'` and returns. Nothing retries until the next edit. Fix: keep the pending document until the PUT succeeds and retry with backoff. (Done on 2026-10-06 with the teams work: `beforeunload` warns while a save is pending or in flight, and a team switch or Back/Forward flushes it first.)

### 4. Server: unconditional writes, auth off by default, silent repair on save — S
- A PUT without `X-Data-Version` overwrites the whole team document (`server/store.mjs` `writeDoc`, the `expected == null` branch). The client omits the header whenever `versionRef` is null, and a proxy that strips custom headers would turn every autosave into an overwrite. Require the header unless `?reason=import`. Consider standard `ETag` / `If-Match`.
- Auth is off unless `OIDC_ISSUER` is set, and the Dockerfile sets `NODE_ENV=production` without it. Refuse to start in production without OIDC unless an explicit `ALLOW_NO_AUTH=1`.
- `normalize()` turns a non-numeric `pct` into 100 and an unknown `kind` into `dev` on every save, not just on migration. Reject these on PUT (extend `payloadProblem`) and keep the repair for startup only.

### 5. No frontend tests — S to set up, M for coverage
Only `server/vacations.test.mjs`, `server/schema.test.mjs`, `src/gantt/bars.test.ts`, `src/status/tracking.test.ts` (and, since the Program work, `src/program/aggregate.test.ts`) exist. vitest is installed (`npm test` runs it over `src/` and then the server tests), so the rest is writing cases. Cheap, valuable pure targets:
- `src/logic.ts`: `isoWeekNum` at year boundaries (2026-12-28, 2027-01-04); `mondayOf`, `weeksBetween`, `weekRange`; `externalParts` raw vs net so an away day is never counted twice; `availablePct` with `resignedFrom`; every branch of `scheduleStatus`; `gridWeeks` compact vs horizon; `personWeekState`; `rollupProgress` (Done counts as 0 remaining); `cellKind` precedence; `weekFte` slots; the WeakMap caches going stale when a `Person` is mutated in place.
- `src/rows.ts`: `buildFeatureTree` (unset group last, removed statuses still get a group, packages hidden while filtering unless named), `groupKey`, `expandToDepth`, `sameExpansion`.
- `src/ui/useHashRoute.ts`: `parseHash` / `toHash` round-trips.
- `shared/db.mjs`: `payloadProblem` accepts every file in `data/backups/` and rejects the malformed cases.
- Highest value: move the `ops` closures out of `Plan.tsx` into a pure `src/mutations.ts` and test that replaying them onto a changed document behaves.

## Medium

### 6. `Plan.tsx` owns too much — L
(The teams work of 2026-10-06 split the old `App.tsx` in two: `App.tsx` is now the shell — theme, teams, the team in the hash — and `Plan.tsx` holds everything below. The Program work the same day moved the autosave — load, debounce, 409 replay, unmount flush — into `src/useAutosave.ts`, shared with `ProgramPlan.tsx`, and the FTE chart into `src/capacity/FteChart.tsx`; the Scope Overview and Needs attention sections are still written twice, in `CapacityView.tsx` and `ProgramCapacity.tsx`.) It holds the database plus save and concurrency state, about twelve persisted UI settings, filters and facets, tree expansion, the dialog state machine, toast, the calendar status, backups and the jump-to-row effect. `FeatureGrid` takes 17 props and `GridRow` 22; `todayISO`, `hideResigned`, `colorOf`, `readOnly`, `db` and `ops` go to every view. Extract `usePersistence(auth)`, `useFeatureOps`, `useFilters`, `useExpansion`, `useTheme`, `useToast`, a `<DialogHost>`, a `<TopBar>`, and a small context for `{ db, people, todayISO, colorOf, readOnly, hideResigned, ops }`.

### 7. Every edit re-renders every row — M
`ops` is rebuilt on each `db` change (its `useMemo` depends on `db` only because `copyCells` reads it), and `update` deep-clones the entire document, so every feature object is new after each edit. Together they defeat `React.memo(GridRow)`. Read `db` from a ref so `ops` stays stable, copy only the touched path (or use immer), and pass row-level props. Also: the `fullDb` prop is documented as "the unfiltered db" but `Plan.tsx` passes the same object as `db`; drop it. `FeatureGrid` computes its own `todayISO` instead of taking the app's.

### 8. `src/ui/Dialogs.tsx` holds unrelated components — M
`Modal`, the ~600-line `PeopleDialog`, `LinksEditor`, `ChipListEditor` and `SettingsDialog` share one file, and `FeatureDialogs.tsx` imports `Modal` from it. Split into `ui/Modal.tsx`, `people/PeopleDialog.tsx`, `ui/LinksEditor.tsx`, `settings/SettingsDialog.tsx`. Extract the dialog footer (Delete with confirm · spacer · Cancel · Save) that `FeatureDialogs.tsx` writes twice.

### 9. Five copies of "close on Escape / outside click" — S
`Popover.tsx`, `useDropdown.ts`, `ConfirmDialog.tsx`, `Dialogs.tsx` (Modal) and `StatusView.tsx` (`TextPopover`) each register their own listeners, mixing capture and bubble phase; `TextPopover`'s own comment says it depends on that ordering. A `useEscape(handler, { capture })` and `useOutsideClick(ref, handler)` would make the ordering explicit.

### 10. Tooling — S
- No eslint, yet a handful of `// eslint-disable-next-line react-hooks/exhaustive-deps` comments (`Plan.tsx`, `App.tsx`, `FeatureGrid.tsx`), so the hooks rules are never checked. Add eslint with `eslint-plugin-react-hooks`.
- `tsconfig.json` now has `noUnusedLocals` / `noUnusedParameters` and type-checks `shared/`; `server/*.mjs` is still unchecked. Add `// @ts-check` there or include `server` with `checkJs`.
- No CI. A workflow running `just typecheck`, `npm run build` and `npm test` on push would catch the next dead import before it ships.

### 11. Server cost per save — S
Each PUT runs `store.backup(team, 'daily')`, which parses the whole stored row and stats the team's backup directory even when today's snapshot exists; `GET /api/teams` parses every team's document for its counts. SQL statements are re-prepared on every call. The document is stored pretty-printed (about 150 KB vs 85 KB minified) and `GET` sends those bytes. Cache "today's backup exists", prepare statements once, store minified and pretty-print only in backups.

### 12. Other clients never see changes — M
No polling, no push. Viewers and idle editors see other people's saves and the calendar sync only after a reload or a 409. A cheap version poll (`HEAD /api/data` returning `X-Data-Version`, or `If-None-Match`) or SSE would do.

### 13. Constants still duplicated across server and client — S
The team-id rule and the reserved ids (`server/store.mjs` vs `src/ui/useHashRoute.ts`). Move them into `shared/db.mjs` next to the status, customer and colour defaults (the hours-per-week default already lives there). The role names and the access rules already moved to `shared/auth.mjs`, the name matching to `shared/names.mjs`.

### 13a. Team-level roles — done
Admin, per-team editor (`feature-planner-editor:<team>`) and viewer, in `shared/auth.mjs`, checked per `/api/teams/:id` write on the server and reflected in the header badge and the switcher. Left open: the switcher does not yet mark which teams the user can edit, and a deleted team leaves its editor role behind in Keycloak.

## Low

### 14. Small repeats left
- Two percent preset lists: `PCT_OPTIONS` (`Popover.tsx`), `PCTS` (`CellPopover.tsx`).
- Three decimal-comma number parsers: `fields.tsx`, `FeatureDialogs.tsx` (`numOrUndef`), `Popover.tsx`.
- "Is this a planned week" is computed twice in `FeatureGrid.tsx`.
- Date math re-implemented on the server: `vacations.mjs` `addDays`, `schema.mjs` `nextMonday`, `scripts/seed/helpers.mjs` `addDays`; `CellPopover.tsx` `fridayOf` with a raw `86400000`.

### 15. Type tightening
- `Person.defaultKind` could be `Exclude<AllocKind, 'buffer'>`.
- Sixteen non-null assertions; `td.dataset.row!` and `r.date!` could be narrowed instead.
- `VacationSyncStatus.intervalHours`, `lastSync.reason`, `lastSync.error`, `lastSync.unmatchedCalendarNames` are typed but never read by the UI.
- About 25 symbols are exported but used only in their own file (`logic.ts` `WEEK_MS`, `loadIndex`, the `Schedule`/`Rollup` types; `rows.ts` `TreeFilter`; `auth.ts` roles; `useHashRoute.ts` `parseHash`/`toHash`; `tracking.ts` option lists …). Harmless; un-export if a stricter lint wants it.

### 16. Data-model edge
A hand-made file with no `schemaVersion` is treated as v0: `migrate()` moves its `startWeek`/`endWeek` into `planStart`/`planEnd` and deletes them, then treats its estimates as story points (×4). Right for real pre-v2 exports, wrong for a file written today without the version. `scripts/seed/` writes `schemaVersion: 4`, so nothing triggers it now; `payloadProblem` could warn when the field is missing.

### 17. Image size
`react`, `react-dom`, `react-markdown`, `remark-gfm`, `keycloak-js`, `@tanstack/react-table` and `@fontsource/*` are in `dependencies`, so `npm ci --omit=dev` in the Dockerfile ships them in the runtime image although only the server runs there. Move them to `devDependencies` (Vite bundles them at build time).

### 18. Rejected features in the roll-ups
`isFinishedStatus` treats Rejected like Closed, so a Rejected feature with an estimate reads as 100% done and its hours count as delivered in the Capacity tiles. A separate `isRejectedStatus` that `rollupProgress` skips entirely would be more honest.
