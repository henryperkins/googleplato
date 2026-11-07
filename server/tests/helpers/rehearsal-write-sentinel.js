import db from '../../src/lib/db.js';
await db.createSyncData('_system', 'migrations', { applied: {}, lock: { owner: 'other', until: Date.now() + 60000 } });
for (const method of ['createSyncData', 'putSyncData']) {
  db[method] = async () => { console.error(`PROBE unexpected write ${method}`); throw new Error('rehearsal wrote after incomplete migrations'); };
}
console.error('PROBE held lock armed');
