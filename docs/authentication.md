# Authentication and roles

How Feature Planner decides who may see which team and who may change it. The rules live in one
shared module, `shared/auth.mjs`, used by the server (`server/index.mjs`, every `/api` route) and the
browser (`src/auth.ts`, which shows or hides the editing controls). The Keycloak used for local
development is described in `docker-compose.yml`.

## The on/off switch

Auth is enabled only when the server starts with `OIDC_ISSUER` set, e.g.

```sh
OIDC_ISSUER=https://keycloak.example.com/realms/myrealm OIDC_CLIENT_ID=feature-planner node server/index.mjs
```

Without it, `authenticate` is a pass-through that gives every request full access, so every visitor
is an admin. The browser learns which mode it is in from `GET /api/auth/config`, which returns
`{ enabled, issuer, clientId }` and is the only route that never needs a token.

A production image started without an issuer therefore runs wide open. `docs/improvements.md`
already flags this and suggests refusing to start in production unless `ALLOW_NO_AUTH=1` is set.

| Variable | Default | Effect |
|---|---|---|
| `OIDC_ISSUER` | unset | turns auth on; must be `<base>/realms/<realm>` |
| `OIDC_CLIENT_ID` | `feature-planner` | client the browser logs in as |
| `OIDC_AUDIENCE` | unset | if set, the server also checks the token's `aud` claim |

## Login flow (auth on)

On page load `initAuth()` in `src/auth.ts`:

1. fetches `/api/auth/config`; if it fails or reports `enabled: false`, returns the no-auth object;
2. splits the issuer into Keycloak base URL and realm, and builds a `keycloak-js` client;
3. runs `kc.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false })`.

This is the authorization-code flow with PKCE. The Keycloak client is public, so there is no client
secret anywhere in the app. Unauthenticated users are redirected to Keycloak before any UI renders.

The returned `Auth` object wraps `fetch`. Every API call first calls `kc.updateToken(30)` so a token
expiring within 30 seconds is refreshed, then sets `Authorization: Bearer <token>`. If the refresh
token itself has expired, `kc.login()` forces a full re-login and the pending request never
resolves because the page is redirecting.

Nothing is stored in cookies or server-side sessions. The token lives in the Keycloak JS client in
memory for the life of the page. `logout()` calls Keycloak's end-session endpoint and returns to the
site origin.

## Roles

Three levels, read from the access token's `realm_access.roles` and from every client's roles under
`resource_access`, so realm roles and client roles both work in Keycloak:

| Role | Grants |
|---|---|
| `feature-planner-admin` | everything: every team's plan, the Program, creating, renaming and deleting teams |
| `feature-planner-editor:<team-id>` | write that team's plan and run its vacation sync; read everything else |
| `feature-planner-viewer` | read every team, export, list and download backups, read calendar status |
| `feature-planner-editor` (plain) | the role from before teams: reads like a viewer, writes nothing |

Every role grants reading; a signed-in user with none of them has no access at all.

`<team-id>` is the team's slug: the name it was created with, lower-cased, accents folded, runs of
anything else turned into a dash (`Mobile apps` → `mobile-apps`, see `slugify()` in
`server/store.mjs`), with `-2`, `-3` on a collision. It is what the URL hash carries
(`#/mobile-apps/planner`) and the tooltip of the name in **Manage teams…**; it never changes on rename, so the role
stays valid for the team's whole life. The slug alphabet is `[a-z0-9-]`, which Keycloak accepts in a
role name.

The built-in Program (`PROGRAM_ID` in `shared/db.mjs`) is only ever written by an admin; a
`feature-planner-editor:program` role grants nothing on it. Team management (`POST`, `PATCH`,
`DELETE /api/teams…`) is admin-only.

`accessOf(roles)` in `shared/auth.mjs` turns the role set into `{ canView, admin, teams }`, and
`canEditTeam(access, teamId)` answers the write question: admin, else not the Program, else the team
is in `teams`. `server/auth.test.mjs` covers the combinations.

### Giving someone a team

1. Find the team's id: open it and read the hash, or hover its name in **Manage teams…**.
2. In Keycloak, create the realm role `feature-planner-editor:<id>` (once per team) and assign it
   to the user, directly or through a group. A user may hold several; each adds one team.
3. The next token carries it; a signed-in user sees it after their token refreshes or they reload.

Deleting a team does not remove its role from Keycloak. The leftover role is harmless and can be
cleaned up by hand.

There is no per-record or per-field authorization inside a team. The plan is one JSON document and
a team's editor can replace all of it (`PUT /api/teams/:id/data`).

## Server enforcement

`authenticate` runs on every `/api` route except `/api/auth/config`. With auth on it:

1. extracts the bearer token from the `Authorization` header (401 `missing bearer token` if absent);
2. verifies signature, issuer and optionally audience with `jose`'s `jwtVerify` against the issuer's
   JWKS endpoint (`<issuer>/protocol/openid-connect/certs`), fetched and cached by
   `createRemoteJWKSet` (401 `invalid token` on any failure);
3. collects the roles with `rolesOfToken()` and leaves `req.access = accessOf(roles)` and
   `req.user = { sub, name, roles }` for the route.

With auth off it sets `req.access` to full access. Three guards then read it:

| Guard | Passes when | Routes |
|---|---|---|
| `requireView` | `access.canView` | `GET /api/teams`, `GET /api/program/teams`, `GET /api/teams/:id/data`, `GET /api/teams/:id/backups`, `GET /api/teams/:id/backups/:name`, `GET /api/teams/:id/vacations/status` |
| `requireAdmin` | `access.admin` | `POST /api/teams`, `PATCH /api/teams/:id`, `DELETE /api/teams/:id` |
| `requireTeamEdit` | `canEditTeam(access, team)`; runs after `withTeam` resolved the team | `PUT /api/teams/:id/data`, `POST /api/teams/:id/vacations/sync` |

A failed guard answers 403 with a message that names what is missing: `admin role required`,
`only admins can edit the Program`, or `you cannot edit team "Mobile apps" — role
'feature-planner-editor:mobile-apps' required`. An unknown team is 404 before any edit check.

`req.user` is not used beyond the request. Saves are not attributed to a user, so there is no audit
trail of who changed what.

## Client enforcement

The `Auth` object exposes `canView`, `isAdmin` and `canEditTeam(teamId)`, computed from the same
`rolesOfToken()` and `accessOf()` the server uses. These only shape the UI; the server guards above
are the real gate.

- `src/main.tsx`: a signed-in user with no planner role sees a "no access, ask an admin" screen
  naming the three roles, with a log-out link, instead of the app.
- `src/App.tsx`: the team switcher's **+ New team…** and **Manage teams…** show for admins only.
- `src/Plan.tsx` computes `canEdit = auth.canEditTeam(team.id)` once per team and hands it to
  `useAutosave`, whose `update()` — the one path every edit takes — refuses with the toast
  *Read-only — you cannot edit this team* when it is false. The header then shows a *Read-only*
  badge whose tooltip names the role to ask for, and **People** / **+ Package** are hidden.
- The same flag goes as `readOnly` into the grid, Gantt, status and capacity views and the feature,
  epic and people dialogs, which render plain text instead of inputs and drop Save and Delete, and
  into the Settings menu, which hides Import, Settings, Releases and Sync vacations.
- `src/program/ProgramPlan.tsx` uses `auth.isAdmin` the same way: the Program's roadmap and notes
  are editable by admins only.

Switching teams remounts the plan, so the badge and the controls follow the team: an editor of
*Mobile apps* edits there and browses *Data platform* read-only.

## Local development

`docker compose up -d` starts Keycloak 26 (`admin` / `admin` on port 8080) and imports an inline
realm `feature-planner` with:

- the realm roles `feature-planner-admin`, `feature-planner-viewer`, and one editor role per demo
  team: `feature-planner-editor:demo`, `…:mobile-apps`, `…:data-platform`;
- a public `feature-planner` client with PKCE S256, redirect URIs for `localhost:5174` (Vite) and
  `localhost:3179` (the Express server);
- three users: `admin` / `admin` (admin), `editor` / `editor` (editor of the Demo team only) and
  `viewer` / `viewer` (viewer).

Then run `OIDC_ISSUER=http://localhost:8080/realms/feature-planner npm run dev`. The realm is only
imported into an empty Keycloak: after changing it, `docker compose down -v` and start again.

With auth off, `localStorage['feature-planner:preview-roles']` set to a comma-separated role list
(`feature-planner-editor:demo`, or `feature-planner-viewer`) renders the app exactly as a user with
those roles would see it; the older `localStorage['feature-planner:viewer-preview'] = '1'` still
means the viewer role. Both are ignored whenever OIDC is on, because roles then come from the token.

## Upgrading from the single editor role

Before team-scoped roles, `feature-planner-editor` wrote every team and managed teams. It now only
reads. After deploying this version, give each editor either `feature-planner-editor:<id>` for the
teams they own or `feature-planner-admin`; nobody loses read access in the meantime.

## Notes for extending

- A new permission means a new field on `accessOf()`'s result in `shared/auth.mjs`, a guard on the
  server routes that need it, and a flag on `Auth` in `src/auth.ts`; the test in
  `server/auth.test.mjs` pins the matrix.
- Finer-grained permissions inside a team (per package, per customer) would need the server to
  inspect the PUT body against the stored document, since writes replace the whole plan.
- User attribution or an audit log would hang off `req.user` in the `PUT /api/teams/:id/data`
  handler.
- Any other OIDC provider works as long as it exposes a JWKS endpoint at
  `<issuer>/protocol/openid-connect/certs` and puts roles in the same claims; otherwise adjust
  `rolesOfToken()` in `shared/auth.mjs`, which both sides share.
