// This identifies a compatible application, not an authenticated principal.
// Keep authentication/authorization ahead of the gate. An epoch is shared by
// every serving instance and rollback build; never derive it from a revision.
export const CLIENT_PROTOCOL = '1';
export const CLIENT_COMPATIBILITY_HEADERS = ['X-Plato-Client-Protocol', 'X-Plato-Client-Epoch'];

export function clientCompatibility() {
  const epoch = process.env.CLIENT_COMPATIBILITY_EPOCH || '1';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(epoch)) throw new Error('Invalid CLIENT_COMPATIBILITY_EPOCH');
  return { protocol: CLIENT_PROTOCOL, epoch };
}

export async function requireCurrentClient(c, next) {
  // Read access allows old tabs to recover/export work and authenticate again.
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  const { protocol, epoch } = clientCompatibility();
  if (c.req.header('X-Plato-Client-Protocol') !== protocol || c.req.header('X-Plato-Client-Epoch') !== epoch) {
    c.header('Cache-Control', 'no-store');
    return c.json({ code: 'client_upgrade_required',
      error: 'Update this page before continuing. Keep any unsaved reply or draft until recovery is confirmed.',
      protocol, epoch }, 409);
  }
  return next();
}
