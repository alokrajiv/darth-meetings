/** Logout = darth-auth's `/logout` (SPEC §3.7). `/logout` here is a server
 * route that 302s to `${DARTH_AUTH_URL}/logout?returnTo=<app root>`, so the
 * auth base URL never has to be baked into the client bundle. Used by the
 * header's account menu. */
export async function signOut(): Promise<void> {
  window.location.href = '/logout';
}
