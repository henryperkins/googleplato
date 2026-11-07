// Loaded before the real CLI, against its real disposable SQLite adapter.
// Conflicting marker writes simulate a competing writer until the runner gives up.
import db from '../../src/lib/db.js';

const target = process.env.PLATO_TEST_MARKER_FAULT;
if (!['m003_role_learner', 'm004_default_program'].includes(target)) {
  throw new Error(`Unexpected marker probe: ${target}`);
}
const put = db.putSyncData.bind(db);
let faults = 0;
db.putSyncData = async (...args) => {
  const [owner, key, state] = args;
  if (owner === '_system' && key === 'migrations' && state.applied?.[target] && state.lock) {
    faults++;
    console.error(`PROBE marker-conflict ${target} attempt=${faults}`);
    throw Object.assign(new Error('injected marker version conflict'), { name: 'ConditionalCheckFailedException' });
  }
  return put(...args);
};
console.error(`PROBE armed ${target}`);
