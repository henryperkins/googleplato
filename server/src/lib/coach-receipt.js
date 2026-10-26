import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { JWT_SECRET } from '../config.js';

export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(item => stableJSON(item ?? null)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stableJSON(value)).digest('hex');
export function receiptKey(secret = JWT_SECRET, env = process.env) {
  if (!secret || ((env.NODE_ENV === 'production' || env.K_SERVICE || env.AWS_LAMBDA_FUNCTION_NAME || env.STAGE === 'prod') && secret === 'dev-secret-change-me')) {
    throw new Error('Coach receipts require a stable configured signing secret.');
  }
  return createHmac('sha256', secret).update('plato/coach-receipt/v1/key').digest();
}
function payload(turn) {
  const { receipt: _receipt, ...signed } = turn;
  return `plato/coach-receipt/v1/turn\n${stableJSON(signed)}`;
}
export function signCoachTurn(turn) {
  return `v1.${createHmac('sha256', receiptKey()).update(payload(turn)).digest('hex')}`;
}
export function verifyCoachTurn(turn) {
  if (typeof turn?.receipt !== 'string' || !/^v1\.[a-f0-9]{64}$/.test(turn.receipt)) return false;
  const expected = signCoachTurn(turn);
  return timingSafeEqual(Buffer.from(turn.receipt), Buffer.from(expected));
}
