import { PLATO_PROTOCOL_VERSION, SERVER_EPOCH } from '../config.js';

export function clientFenceMiddleware() {
  return async (c, next) => {
    const protocol = c.req.header('x-plato-protocol');
    const epoch = c.req.header('x-plato-server-epoch');

    if (!protocol || protocol !== PLATO_PROTOCOL_VERSION || !epoch || epoch !== SERVER_EPOCH) {
      return c.json({
        error: 'client_upgrade_required',
        code: 'client_upgrade_required',
        message: 'A newer version of Plato is available. Preserve your work and reload to continue.',
        protocol: PLATO_PROTOCOL_VERSION,
        serverEpoch: SERVER_EPOCH,
      }, 409);
    }

    await next();
  };
}
