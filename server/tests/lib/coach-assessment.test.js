import { test } from 'node:test';
import assert from 'node:assert/strict';
const assessment = await import('../../src/lib/coach-assessment.js').catch(() => ({}));
const kbUpdate = { responseType: 'question', insights: [], learnerPosition: 'Comparison is demonstrated; a choice is still missing.', evidence: [], exemplarEvidence: { status: 'missing', observation: '', sourceIds: [] } };
const body = { system: 'Coach policy', messages: [{ role: 'user', content: '{"progress":6,"sources":[]}' }, { role: 'user', content: 'What does justify mean?' }] };
const visible = 'Justify means giving a reason. Which option would you choose? café 日本語 🌱';
test('missing metadata receives one repair while preserving the exact visible reply', async () => {
  assert.equal(typeof assessment.assessCoachResponse, 'function');
  let calls = 0;
  const result = await assessment.assessCoachResponse(visible, body, async request => {
    calls++;
    assert.match(request.system, /ONLY.*JSON/);
    assert.equal(request.messages.at(-2).content, visible);
    assert.equal(request.messages[0].content, body.messages[0].content);
    return JSON.stringify({ progress: 6, kbUpdate });
  });
  assert.equal(calls, 1);
  assert.equal(result.parsed.text, visible);
  assert.equal(result.parsed.valid, true);
  assert.equal(result.parsed.progress, 6);
  assert.equal(result.repair.succeeded, true);
});
test('valid output never invokes metadata repair', async () => {
  assert.equal(typeof assessment.assessCoachResponse, 'function');
  const raw = `${visible}\n[PROGRESS: 6]\n[KB_UPDATE: ${JSON.stringify(kbUpdate)}]`;
  const result = await assessment.assessCoachResponse(raw, body, () => assert.fail('Unexpected repair call'));
  assert.equal(result.raw, raw);
  assert.equal(result.repair.attempted, false);
});
test('opening and completed feedback recover known frozen assessment without another model call', async () => {
  assert.equal(typeof assessment.assessCoachResponse, 'function');
  for (const [opening, lessonKB, expected] of [[true, { progress: 0, status: 'active' }, 0], [false, { progress: 10, status: 'completed' }, 10]]) {
    const result = await assessment.assessCoachResponse(visible, body, () => assert.fail('Frozen state needs no model repair.'), { opening, lessonKB });
    assert.equal(result.parsed.valid, true);
    assert.equal(result.parsed.progress, expected);
    assert.equal(result.parsed.text, visible);
    assert.equal(result.repair.method, 'state-preserving');
  }
});
test('invalid, out-of-range, profile-bearing, and failed repairs stay invalid without retrying', async () => {
  assert.equal(typeof assessment.assessCoachResponse, 'function');
  for (const repair of ['not JSON', JSON.stringify({ progress: 100, kbUpdate }), JSON.stringify({ progress: 6, kbUpdate, profileUpdate: { observation: 'Invented trait' } }), null]) {
    let calls = 0;
    const result = await assessment.assessCoachResponse(visible, body, async () => { calls++; if (repair === null) throw new Error('Private provider detail'); return repair; });
    assert.equal(calls, 1);
    assert.equal(result.parsed.valid, false);
    assert.equal(result.parsed.text, visible);
    assert.equal(result.repair.succeeded, false);
    assert.doesNotMatch(JSON.stringify(result), /Private provider detail/);
  }
});
