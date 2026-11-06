/**
 * Upgrade-from-Beta-RC-232 gate. Every production install runs RC-232 at the
 * start of the launch sprint; this test proves the full migration set:
 *
 *  1. loses nothing and only touches what a migration declares it may touch,
 *  2. is idempotent (a second run changes nothing), and
 *  3. leaves data that Beta-RC-232's own route handlers still serve correctly
 *     (rollback safety) — checked by extracting server/src at the tag.
 *
 * Every migration PR extends ALLOWED below and adds its own assertions.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = './data/test-upgrade-rc232.db';
process.env.DB_BACKEND = 'sqlite';
process.env.SQLITE_PATH = DB_PATH;

const { default: db } = await import('../../src/lib/db-sqlite.js');
const { runMigrations, MIGRATIONS, ROLLBACK_BASELINE } = await import('../../src/lib/migrations.js');
const { ensureBundledLessons, BUNDLED_COURSE, BUNDLED_LESSONS } = await import('../../src/lib/bundled-lessons.js');
const { repairUnits } = await import('../../src/lib/unit-repair.js');
const { seedRc232, snapshot, diffSnapshots, FIXTURE } = await import('./fixtures/rc232.js');

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_DIR = join(SERVER_DIR, '..');
const RC232_DIR = join(SERVER_DIR, '.rc232');
const { tag: TAG, commit: RC232_COMMIT } = ROLLBACK_BASELINE;

// What the migrations are allowed to add or change, as snapshot-key regexes.
// Anything else differing from the RC-232 fixture fails the test.
const ALLOWED = {
  added: [
    /^sync:_system:migrations$/,
    /^sync:_system:program:prog-default$/, // m004_default_program
    // Bundled Getting Started course (#443): seeded at startup, before the migrations.
    /^sync:_system:lesson:getting-started(-sharing|-behind)?$/,
    /^sync:_system:bundled:getting-started(-sharing|-behind)?$/,
    /^sync:_system:bundled:course:getting-started$/,
    /^sync:_system:program:prog-getting-started$/,
    /^sync:_system:course:unit-getting-started$/,
  ],
  changed: [
    /^user:usr_(ada|cher|mae|jose|blank|pad)$/, // m003_role_learner: stored role was 'user'
    /^user:usr_admin$/, // m005_name_split: firstName/lastName added
    /^sync:_system:course:/, // m004: units gain programId + lessonIds
  ],
};
// Learner work is never rewritten by any migration, ever.
const NEVER_TOUCHED = /^sync:usr_[^:]+:(messages|screenshot|lessonKB|courseProgress|lessons):/;

function cleanup() {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) unlinkSync(f);
}

// Beta-RC-232's server/src, found once for every test that runs its code:
// - PLATO_RC232_SRC: a tree CI extracted already (Cloud Build's test image
//   has no git);
// - otherwise the pinned commit, extracted from this clone.
// When neither is there, CI fails (the rollback check must run, not skip);
// a local run skips with the command that fixes it.
let rc232Src;
function rc232Source(t) {
  if (rc232Src) return rc232Src;
  const prepared = process.env.PLATO_RC232_SRC;
  if (prepared) {
    assert.ok(existsSync(join(prepared, 'routes/admin.js')), `PLATO_RC232_SRC holds no ${TAG} server/src: ${prepared}`);
    return (rc232Src = prepared);
  }
  const git = (...args) => spawnSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' });
  if (git('cat-file', '-e', `${RC232_COMMIT}^{commit}`).status !== 0) {
    const fix = `${TAG} (${RC232_COMMIT}) isn't in this clone. Run: git fetch --no-tags --depth=1 origin ${RC232_COMMIT}`;
    if (process.env.CI || process.env.PLATO_REQUIRE_RC232) assert.fail(`${fix}. CI must run the rollback check, not skip it.`);
    t.skip(fix);
    return null;
  }
  // Where a clone has the tag, it must still be the pinned commit.
  const tagged = git('rev-parse', '--verify', '--quiet', `${TAG}^{commit}`);
  if (tagged.status === 0) assert.equal(tagged.stdout.trim(), RC232_COMMIT, `${TAG} no longer points at the pinned commit`);
  rmSync(RC232_DIR, { recursive: true, force: true });
  mkdirSync(RC232_DIR, { recursive: true });
  const archive = execFileSync('git', ['archive', RC232_COMMIT, 'server/src'], { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '--strip-components=1', '-C', RC232_DIR], { input: archive });
  return (rc232Src = join(RC232_DIR, 'src'));
}

// Runs Beta-RC-232's own route handlers against the test database.
function runRc232(src, args = []) {
  const child = spawnSync(process.execPath, [join(SERVER_DIR, 'tests/migrations/rc232-compat-check.js'), src, ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, DB_BACKEND: 'sqlite', SQLITE_PATH: DB_PATH, SKIP_EMAIL: 'true' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.trim().split('\n').filter((l) => l.startsWith('{"results"')).pop();
  return JSON.parse(line).results;
}

describe('upgrade from Beta-RC-232', () => {
  let before1;
  let after1;

  before(async () => {
    await seedRc232(db);
    before1 = await snapshot(db);
    // Upstream's startup order: bundled content first, then the migrations.
    // It's the harder case for m004 (the bundled course already exists). The
    // fork's startup (index.js, start.js) migrates first, then seeds; the
    // second-start check below runs that order.
    assert.deepEqual((await ensureBundledLessons({ db })).installed, ['getting-started', 'getting-started-sharing', 'getting-started-behind']);
    const outcome = await runMigrations();
    for (const { id, result } of outcome.ran) assert.equal(result.errors, 0, `${id} reported errors: ${JSON.stringify(result)}`);
    after1 = await snapshot(db);
  });
  after(() => { cleanup(); rmSync(RC232_DIR, { recursive: true, force: true }); });

  it('runs every registered migration exactly once and records it', async () => {
    const state = (await db.getSyncData('_system', 'migrations'))?.data;
    for (const m of MIGRATIONS) assert.ok(state?.applied?.[m.id], `${m.id} recorded as applied`);
    assert.equal(state?.lock ?? null, null, 'lock released');
  });

  it('loses nothing and touches only what migrations declare', () => {
    const { added, removed, changed } = diffSnapshots(before1, after1);
    assert.deepEqual(removed, [], 'no record removed');
    for (const k of added) assert.ok(ALLOWED.added.some((re) => re.test(k)), `unexpected new record ${k}`);
    for (const k of changed) assert.ok(ALLOWED.changed.some((re) => re.test(k)), `unexpected change to ${k}`);
  });

  it("m003_role_learner: every 'user' becomes 'learner'; admins and nothing else change", () => {
    for (const u of FIXTURE.users) {
      const after = JSON.parse(after1[`user:${u.userId}`]);
      const before = JSON.parse(before1[`user:${u.userId}`]);
      assert.equal(after.role, u.role === 'user' ? 'learner' : u.role, u.userId);
      const strip = ({ role, firstName, lastName, nameSource, ...rest }) => rest; // eslint-disable-line no-unused-vars
      assert.deepEqual(strip(after), strip(before), `${u.userId}: only the role (and m005's name parts) changed; updatedAt untouched`);
    }
  });

  it('m004_default_program: one default Course holding every unit, lesson order unchanged', async () => {
    const program = (await db.getSyncData('_system', 'program:prog-default'))?.data;
    assert.equal(program.name, FIXTURE.settings.classroomName);
    assert.deepEqual(program.unitIds, ['course-lead001', 'course-found01'], 'units ordered by name (AI Leadership, Foundations)');
    const found = (await db.getSyncData('_system', 'course:course-found01')).data;
    assert.equal(found.programId, 'prog-default');
    assert.deepEqual(found.lessonIds, ['les-f1', 'les-f2'], 'name order: "Foundations 1" before "Foundations 2"');
    assert.equal(found.name, 'Foundations', 'existing unit fields kept');
    const lead = (await db.getSyncData('_system', 'course:course-lead001')).data;
    assert.deepEqual(lead.lessonIds, ['les-l1', 'les-priv']);
    // Lessons themselves are untouched (membership stays on lesson.course).
    for (const l of FIXTURE.lessons) {
      assert.equal(after1[`sync:_system:lesson:${l.id}`], before1[`sync:_system:lesson:${l.id}`], l.id);
    }
  });

  it('m005_name_split: first/last inferred at the first whitespace; name itself never rewritten', () => {
    const expected = {
      usr_admin: ['Admin', ''],
      usr_ada: ['Ada', 'Lovelace'],
      usr_cher: ['Cher', ''],
      usr_mae: ['Mary', 'Ann Evans'],
      usr_jose: ['José', 'María García López'],
      usr_pad: ['Padded', 'Name'],
    };
    for (const u of FIXTURE.users) {
      const after = JSON.parse(after1[`user:${u.userId}`]);
      assert.equal(after.name, u.name, `${u.userId}: name unchanged`);
      if (expected[u.userId]) {
        assert.deepEqual([after.firstName, after.lastName, after.nameSource], [...expected[u.userId], 'auto'], u.userId);
      } else {
        assert.equal(after.firstName ?? null, null, `${u.userId}: an empty name gets no split`);
      }
    }
  });

  it('Getting Started arrives private on an existing classroom (learners see nothing new until an admin publishes)', async () => {
    for (const id of ['getting-started', 'getting-started-sharing', 'getting-started-behind']) {
      const l = (await db.getSyncData('_system', `lesson:${id}`)).data;
      assert.equal(l.status, 'private', id);
      assert.deepEqual(l.sharedWith, [], id);
      assert.equal(l.course, 'unit-getting-started', id);
    }
  });

  it('the bundled course doesn\u2019t stop m004 from making the default course (startup seeds it first)', async () => {
    const gs = (await db.getSyncData('_system', 'program:prog-getting-started')).data;
    assert.deepEqual(gs.unitIds, ['unit-getting-started']);
    assert.equal((await db.getSyncData('_system', 'course:unit-getting-started')).data.programId, 'prog-getting-started');
    assert.ok(await db.getSyncData('_system', 'program:prog-default'), 'default course still created');
  });

  it('never rewrites learner work', () => {
    for (const k of Object.keys(before1).filter((key) => NEVER_TOUCHED.test(key))) {
      assert.equal(after1[k], before1[k], `${k} unchanged`);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const outcome = await runMigrations();
    assert.equal(outcome.ran.length, 0);
    await ensureBundledLessons({ db });
    assert.deepEqual(await repairUnits({ db }), { repaired: [], ambiguous: [] });
    assert.deepEqual(diffSnapshots(after1, await snapshot(db)), { added: [], removed: [], changed: [] });
  });

  it('Beta-RC-232 route handlers still serve the migrated data (rollback safety)', (t) => {
    const src = rc232Source(t);
    if (!src) return;
    const results = runRc232(src);
    for (const [label, r] of Object.entries(results)) assert.equal(r.status, 200, `RC-232 ${label} → ${r.status}`);

    const publicVisible = FIXTURE.lessons.filter((l) => l.status === 'public').length;
    assert.equal(results['admin users'].count, FIXTURE.users.length);
    assert.equal(results['admin lessons'].count, FIXTURE.lessons.length + 3, 'plus the three private Getting Started lessons');
    assert.equal(results['admin courses'].count, FIXTURE.courses.length + 1, 'plus the Getting Started unit (RC-232 calls units courses)');
    assert.equal(results['admin waitlist'].count, FIXTURE.waitlist.length);
    assert.equal(results['learner lessons'].count, publicVisible + 1, 'public + the private lesson shared with Ada');
    assert.equal(results['learner kb'].count, 10, "Ada's completed lesson keeps progress 10");
  });

  it('both CI paths fetch the pinned commit and require the rollback check', () => {
    const github = readFileSync(join(REPO_DIR, '.github/workflows/test.yml'), 'utf8');
    assert.match(github, new RegExp(`git fetch --no-tags --depth=1 origin ${RC232_COMMIT}`));
    const cloudBuild = readFileSync(join(REPO_DIR, 'deploy/cloudrun/cloudbuild.yaml'), 'utf8');
    assert.match(cloudBuild, new RegExp(`git fetch -q --no-tags --depth=1 origin ${RC232_COMMIT}`));
    assert.match(cloudBuild, /PLATO_RC232_SRC=\/workspace\/server\/\.rc232\/src/);
    assert.match(cloudBuild, /PLATO_REQUIRE_RC232=1/);
  });

  // Last: it changes the database. Beta-RC-232 saves a unit by replacing its
  // record, so a rename there drops programId, lessonIds, and bundled. The next
  // start of the new release (lib/unit-repair.js) must put them back.
  it('a unit renamed under Beta-RC-232 gets its course, order, and marker back on the next start', async (t) => {
    const src = rc232Source(t);
    if (!src) return;
    const { Hono } = await import('hono');
    const { default: admin } = await import('../../src/routes/admin.js');
    const { signAccessToken } = await import('../../src/lib/jwt.js');
    const app = new Hono().route('/', admin);
    // An order an admin set on the new release.
    const reorder = await app.request('/v1/admin/units/course-found01/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signAccessToken('usr_admin', 'admin')}` },
      body: JSON.stringify({ lessonIds: ['les-f2', 'les-f1'] }),
    });
    assert.equal(reorder.status, 200, await reorder.text());

    const renames = [['course-found01', 'Foundations (renamed on RC-232)'], [BUNDLED_COURSE.unitId, 'Orientation (renamed on RC-232)']];
    const results = runRc232(src, ['--rename', JSON.stringify(renames)]);
    for (const [unitId] of renames) assert.equal(results[`rename ${unitId}`].status, 200, unitId);
    const unit = async (id) => (await db.getSyncData('_system', `course:${id}`)).data;
    assert.equal((await unit('course-found01')).programId, undefined, 'RC-232 replaced the record');

    // The next start: migrations (none pending), bundled content, the repair.
    assert.equal((await runMigrations()).ran.length, 0);
    await ensureBundledLessons({ db });
    assert.deepEqual((await repairUnits({ db })).repaired.sort(), ['course-found01', BUNDLED_COURSE.unitId].sort());
    const found = await unit('course-found01');
    assert.deepEqual([found.name, found.programId, found.lessonIds], ['Foundations (renamed on RC-232)', 'prog-default', ['les-f2', 'les-f1']]);
    const gs = await unit(BUNDLED_COURSE.unitId);
    assert.deepEqual([gs.name, gs.programId, gs.lessonIds, gs.bundled],
      ['Orientation (renamed on RC-232)', BUNDLED_COURSE.programId, BUNDLED_LESSONS.map((b) => b.id), { id: BUNDLED_COURSE.id }]);
  });
});
