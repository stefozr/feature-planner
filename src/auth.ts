import Keycloak from 'keycloak-js'
import { FULL_ACCESS, accessOf, canEditTeam, rolesOfToken } from '../shared/auth.mjs'

export { ROLE_ADMIN, ROLE_VIEWER, editorRole } from '../shared/auth.mjs'

export type Auth = {
  enabled: boolean
  /** has some planner role (or auth disabled): may read every team */
  canView: boolean
  /** the admin role (or auth disabled): every team, the Program, team management */
  isAdmin: boolean
  /** may write this team's plan: admins, or the holder of `feature-planner-editor:<teamId>`; the Program is admins only */
  canEditTeam: (teamId: string) => boolean
  userName: string | null
  /** fetch that attaches (and refreshes) the bearer token when auth is enabled. */
  fetch: typeof fetch
  logout: () => void
}

type Access = ReturnType<typeof accessOf>

const fromAccess = (access: Access, rest: Omit<Auth, 'canView' | 'isAdmin' | 'canEditTeam'>): Auth => ({
  ...rest,
  canView: access.canView,
  isAdmin: access.admin,
  canEditTeam: (teamId) => canEditTeam(access, teamId),
})

const plainFetch: typeof fetch = (...args) => fetch(...args)

/**
 * Auth off (local dev): everyone is an admin — unless the browser asks to preview a role:
 *   localStorage['feature-planner:preview-roles']  = 'feature-planner-editor:demo'   any roles, comma-separated
 *   localStorage['feature-planner:viewer-preview'] = '1'                              the viewer role (older key)
 * Both are ignored whenever OIDC is on, because then the roles come from the token.
 */
function devAuth(): Auth {
  let access: Access = FULL_ACCESS
  try {
    const preview = localStorage.getItem('feature-planner:preview-roles')
    if (preview != null && preview.trim() !== '') access = accessOf(preview.split(',').map((r) => r.trim()))
    else if (localStorage.getItem('feature-planner:viewer-preview') === '1') access = accessOf(['feature-planner-viewer'])
  } catch {
    /* storage blocked: plain no-auth */
  }
  return fromAccess(access, { enabled: false, userName: null, fetch: plainFetch, logout: () => {} })
}

/**
 * Asks the server whether OIDC is enabled; if so runs the Keycloak
 * auth-code + PKCE login flow before resolving.
 */
export async function initAuth(): Promise<Auth> {
  let cfg: { enabled: boolean; issuer: string | null; clientId: string }
  try {
    cfg = await fetch('/api/auth/config').then((r) => r.json())
  } catch {
    return devAuth()
  }
  if (!cfg.enabled || !cfg.issuer) return devAuth()

  // issuer is <base>/realms/<realm>
  const i = cfg.issuer.lastIndexOf('/realms/')
  if (i < 0) throw new Error(`unexpected OIDC issuer (want …/realms/<realm>): ${cfg.issuer}`)
  const kc = new Keycloak({
    url: cfg.issuer.slice(0, i),
    realm: cfg.issuer.slice(i + '/realms/'.length),
    clientId: cfg.clientId,
  })
  await kc.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false })

  // the same claims the server reads: realm roles plus every client's roles
  const access = accessOf(rolesOfToken(kc.tokenParsed))

  const authFetch: typeof fetch = async (input, init) => {
    try {
      await kc.updateToken(30)
    } catch {
      kc.login() // refresh token expired — full re-login
      return new Promise(() => {}) // page is redirecting
    }
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${kc.token}`)
    return fetch(input, { ...init, headers })
  }

  return fromAccess(access, {
    enabled: true,
    userName: (kc.tokenParsed?.preferred_username as string | undefined) ?? null,
    fetch: authFetch,
    logout: () => kc.logout({ redirectUri: window.location.origin }),
  })
}

