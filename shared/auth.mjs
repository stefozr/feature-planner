// Who may do what, from the roles on an access token. Shared by the server (every /api route) and
// the browser (which shows or hides the editing controls), so both read the same claims and reach
// the same answer. Nothing here knows about Keycloak or Express: roles in, access out.
//
//   feature-planner-admin             everything: every team, the Program, team management
//   feature-planner-editor:<team-id>  write that team's plan; read everything
//   feature-planner-viewer            read everything
//   feature-planner-editor            (plain, from before teams) read everything, writes nothing
//
// Team ids are slugs that never change on rename (server/store.mjs TEAM_ID), so the per-team role
// name is stable. The Program (shared/db.mjs PROGRAM_ID) is only ever written by an admin.
import { PROGRAM_ID } from './db.mjs'

export const ROLE_ADMIN = 'feature-planner-admin'
export const ROLE_VIEWER = 'feature-planner-viewer'
export const ROLE_EDITOR = 'feature-planner-editor'
export const EDITOR_PREFIX = `${ROLE_EDITOR}:`

/** the role that lets its holder edit one team @param {string} teamId */
export const editorRole = (teamId) => EDITOR_PREFIX + teamId

/**
 * @typedef {{ canView: boolean; admin: boolean; teams: Set<string> }} Access
 *   canView  may read anything (every role grants it)
 *   admin    may do anything
 *   teams    the team ids an editor role names (empty for admins and viewers)
 */

/** the access nobody has: not even reading */
export const NO_ACCESS = Object.freeze({ canView: false, admin: false, teams: new Set() })
/** what everyone has when auth is off */
export const FULL_ACCESS = Object.freeze({ canView: true, admin: true, teams: new Set() })

/**
 * @param {Iterable<string>} roles
 * @returns {Access}
 */
export function accessOf(roles) {
  const teams = new Set()
  let admin = false
  let canView = false
  for (const r of roles ?? []) {
    if (typeof r !== 'string') continue
    if (r === ROLE_ADMIN) admin = true
    else if (r.startsWith(EDITOR_PREFIX) && r.length > EDITOR_PREFIX.length) teams.add(r.slice(EDITOR_PREFIX.length))
    else if (r !== ROLE_VIEWER && r !== ROLE_EDITOR) continue
    canView = true
  }
  return { canView, admin, teams }
}

/**
 * May this access write the team's plan? Admins always; the Program only admins; everyone else
 * only the teams their editor roles name.
 * @param {Access} access @param {string} teamId
 */
export function canEditTeam(access, teamId) {
  if (access.admin) return true
  if (teamId === PROGRAM_ID) return false
  return access.teams.has(teamId)
}

/**
 * Every role a decoded token carries: the realm roles and the roles of every client in
 * `resource_access` (Keycloak puts client roles there under the client's id).
 * @param {{ realm_access?: { roles?: string[] }; resource_access?: Record<string, { roles?: string[] }> } | null | undefined} payload
 * @returns {Set<string>}
 */
export function rolesOfToken(payload) {
  const roles = new Set(payload?.realm_access?.roles ?? [])
  for (const client of Object.values(payload?.resource_access ?? {})) {
    for (const r of client?.roles ?? []) roles.add(r)
  }
  return roles
}
