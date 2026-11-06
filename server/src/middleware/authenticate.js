import { verifyAccessToken } from '../lib/jwt.js';
import db from '../lib/db.js';

export async function authenticate(c, next) {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = auth.slice(7);
  let payload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  // Strongly consistent: the role (and the account itself) decides what this
  // request may do, and a demotion or deletion applies from the next request.
  // On DynamoDB an eventually consistent read could still return the old role.
  const user = await db.getUserById(payload.sub, { consistentRead: true });
  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  c.set('userId', user.userId);
  c.set('role', user.role);
  c.set('user', user);
  await next();
}
