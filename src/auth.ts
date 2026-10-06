import Keycloak from 'keycloak-js'

export const ROLE_VIEWER = 'feature-planner-viewer'
export const ROLE_EDITOR = 'feature-planner-editor'

export type Auth = {
  enabled: boolean
  /** Has at least the viewer role (or auth disabled). */
  canView: boolean
  /** Has the editor role (or auth disabled). */
  canEdit: boolean
  userName: string | null
  /** fetch that attaches (and refreshes) the bearer token when auth is enabled. */
  fetch: typeof fetch
  logout: () => void
}

const noAuth: Auth = {
  enabled: false,
  canView: true,
  canEdit: true,
  userName: null,
  fetch: (...args) => fetch(...args),
  logout: () => {},
}

/**
 * Auth off (local dev): everyone edits — unless `localStorage['feature-planner:viewer-preview'] = '1'`,
 * which shows the app exactly as the viewer role sees it. Ignored whenever OIDC is on, because
 * then the roles come from the token.
 */
function devAuth(): Auth {
  let preview = false
  try {
    preview = localStorage.getItem('feature-planner:viewer-preview') === '1'
  } catch {
    /* storage blocked: plain no-auth */
  }
  return preview ? { ...noAuth, canEdit: false } : noAuth
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

  const roles = new Set([
    ...(kc.realmAccess?.roles ?? []),
    ...(kc.resourceAccess?.[cfg.clientId]?.roles ?? []),
  ])
  const canEdit = roles.has(ROLE_EDITOR)

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

  return {
    enabled: true,
    canView: canEdit || roles.has(ROLE_VIEWER),
    canEdit,
    userName: (kc.tokenParsed?.preferred_username as string | undefined) ?? null,
    fetch: authFetch,
    logout: () => kc.logout({ redirectUri: window.location.origin }),
  }
}
