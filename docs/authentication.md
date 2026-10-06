# Authentication and roles

How Feature Planner decides who may see the plan and who may change it. Everything lives in two
files: `src/auth.ts` (browser) and `server/index.mjs` (server). The Keycloak used for local
development is described in `docker-compose.yml`.

## The on/off switch

Auth is enabled only when the server starts with `OIDC_ISSUER` set, e.g.

```sh
OIDC_ISSUER=https://keycloak.example.com/realms/myrealm OIDC_CLIENT_ID=feature-planner node server/index.mjs
```

Without it, `requireRole()` is a pass-through middleware and every visitor is an editor. The browser
learns which mode it is in from `GET /api/auth/config`, which returns `{ enabled, issuer, clientId }`
and is the only route that never needs a token.

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

There are exactly two, defined as string constants in both `src/auth.ts` and `server/index.mjs`:

| Role | Grants |
|---|---|
| `feature-planner-viewer` | read the plan, export, list and download backups, read calendar status |
| `feature-planner-editor` | everything above plus every write |

Editor implies viewer on both sides. Roles are taken from the access token's `realm_access.roles`
and `resource_access.<client>.roles`, so either realm roles or client roles work in Keycloak.

One small difference: the browser only reads client roles under its own client id, while the server
accepts roles from every client entry in the token. The server is the gate that matters, so this is
an inconsistency rather than a hole.

There is no per-record or per-field authorization. The plan is one JSON document and an editor can
replace all of it (`PUT /api/data`).

## Server enforcement

Each route is wrapped with `requireRole(role)`. With auth on, the middleware:

1. extracts the bearer token from the `Authorization` header (401 `missing bearer token` if absent);
2. verifies signature, issuer and optionally audience with `jose`'s `jwtVerify` against the issuer's
   JWKS endpoint (`<issuer>/protocol/openid-connect/certs`), fetched and cached by
   `createRemoteJWKSet` (401 `invalid token` on any failure);
3. collects the roles as above and checks the required one (403 `role '<role>' required`);
4. attaches `req.user = { sub, name, roles }` for the handler.

| Route | Role |
|---|---|
| `GET /api/auth/config` | none |
| `GET /api/data` | viewer |
| `GET /api/backups` | viewer |
| `GET /api/backups/:name` | viewer |
| `GET /api/vacations/status` | viewer |
| `PUT /api/data` | editor |
| `POST /api/vacations/sync` | editor |

`req.user` is not used beyond the request. Saves are not attributed to a user, so there is no audit
trail of who changed what.

## Client enforcement

The `Auth` object exposes `canView` and `canEdit`. These only shape the UI; the server check above is
the real gate.

- `src/main.tsx`: a signed-in user with neither role sees a "no access, ask an admin for the viewer
  or editor role" screen with a log-out link instead of the app.
- `src/App.tsx`: every edit goes through the single `update()` function, which refuses with the
  toast *Read-only — editor role required* when `canEdit` is false. The header shows a *Read-only*
  badge instead of the save state, and **People** / **+ Package** are hidden.
- `readOnly={!auth.canEdit}` is passed to the grid, Gantt, status, capacity views and the feature,
  epic and people dialogs, which render plain text instead of inputs and drop Save and Delete.
- `src/ui/SettingsMenu.tsx` hides Import, Settings, Releases and Sync vacations for viewers and shows
  **Log out** only when auth is enabled.

## Local development

`docker compose up -d` starts Keycloak 26 (`admin` / `admin` on port 8080) and imports an inline
realm `feature-planner` with:

- both realm roles;
- a public `feature-planner` client with PKCE S256, redirect URIs for `localhost:5174` (Vite) and
  `localhost:3179` (the Express server);
- two users: `viewer` / `viewer` (viewer role) and `editor` / `editor` (editor role).

Then run `OIDC_ISSUER=http://localhost:8080/realms/feature-planner npm run dev`.

With auth off, set `localStorage['feature-planner:viewer-preview'] = '1'` to render the app exactly
as a viewer would see it. The flag is ignored whenever OIDC is on, because roles then come from the
token.

## Notes for extending

- Adding a role means adding the constant in both files (or moving both into `shared/db.mjs`, as
  `docs/improvements.md` suggests), a `requireRole` on the server routes, and a flag on `Auth`.
- Finer-grained permissions (per package, per customer) would need the server to inspect the PUT
  body against the stored document, since writes currently replace the whole plan.
- User attribution or an audit log would hang off `req.user` in the `PUT /api/data` handler.
- Any other OIDC provider works as long as it exposes a JWKS endpoint at
  `<issuer>/protocol/openid-connect/certs` and puts roles in the same claims; otherwise adjust
  `rolesOf()` on the server and the role extraction in `src/auth.ts`.
