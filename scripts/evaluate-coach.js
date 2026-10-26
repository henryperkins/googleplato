import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseCoachResponse, applyCoachResponseToKB, buildContext, submissionSources, retainSources } from '../server/src/shared/coachContract.js';
import { assessCoachResponse, ASSESSMENT_REPAIR_PROMPT } from '../server/src/lib/coach-assessment.js';
import { classifyAiError } from '../server/src/lib/ai-errors.js';
import { coachFixtures } from './coach-fixtures.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const currentSources = fixture => fixture.opening ? [] : submissionSources({ turnId: 'fixture', text: fixture.input });
export function buildCoachEvaluationRequest(fixture, prompt) {
  const sources = retainSources(fixture.kb.sources, [...(fixture.sources || []), ...currentSources(fixture)]);
  const context = buildContext(fixture.lesson, { ...fixture.kb, sources }, 'Synthetic learner; no profile facts.', 'Ada');
  return { system: prompt, max_tokens: 3072, messages: [
    { role: 'user', content: context }, { role: 'assistant', content: 'Ready.' },
    ...(fixture.history || []),
    { role: 'user', content: fixture.opening ? 'Start the lesson.' : JSON.stringify({ learnerSubmission: fixture.input, currentSourceIds: currentSources(fixture).map(item => item.id) }) },
  ] };
}
export function evaluateCoachReply(fixture, raw, { live = false } = {}) {
  const parsed = parseCoachResponse(raw);
  const applied = applyCoachResponseToKB(fixture.kb, parsed, { opening: fixture.opening,
    sources: [...(fixture.sources || []), ...currentSources(fixture)], submissionId: 'fixture:0', now: () => 1 });
  const failures = [];
  if (parsed.valid !== (fixture.expectedValid !== false)) failures.push('protocol');
  if (parsed.valid && !(fixture.allowedTypes || [fixture.expectedType]).includes(parsed.kbUpdate.responseType)) failures.push('response_type');
  if (!(fixture.allowedProgress || [fixture.expectedProgress]).includes(applied.lessonKB.progress)) failures.push('progress');
  if (applied.achieved !== fixture.expectedComplete) failures.push('completion');
  if (fixture.expectedAssessmentUnchanged) {
    const signature = kb => JSON.stringify({ progress: kb.progress, evidence: (kb.evidence || []).map(item => ({ objectiveId: item.objectiveId, status: item.status, sourceIds: [...item.sourceIds].sort() })).sort((a, b) => a.objectiveId.localeCompare(b.objectiveId)), exemplar: kb.exemplarEvidence ? { status: kb.exemplarEvidence.status, sourceIds: [...kb.exemplarEvidence.sourceIds].sort() } : null });
    if (signature(applied.lessonKB) !== signature(fixture.kb)) failures.push('reference_assessed');
  }
  for (const id of fixture.expectedUnconfirmedSources || []) if (applied.lessonKB.sources?.find(item => item.id === id)?.confirmed) failures.push('unconfirmed_reference');
  for (const id of fixture.expectedPreservedObjectives || []) if (!applied.lessonKB.evidence?.some(item => item.objectiveId === id && item.status === 'met')) failures.push('unrelated_evidence_lost');
  for (const id of fixture.expectedInvalidatedObjectives || []) if (applied.lessonKB.evidence?.some(item => item.objectiveId === id && item.status === 'met')) failures.push('retraction_ignored');
  if ((fixture.expectedNoProfile || ['feedback', 'pause', 'distress', 'uncertainty'].includes(fixture.expectedType)) && parsed.profileUpdate) failures.push('unwarranted_profile');
  if (live && parsed.valid && (fixture.opening || fixture.kb.status === 'completed'
    || ['question', 'clarification', 'uncertainty', 'feedback', 'pause', 'distress'].includes(fixture.expectedType))) {
    if (parsed.progress !== (fixture.opening ? 0 : fixture.kb.progress)) failures.push('reported_progress');
  }
  if (live && applied.issues.length) failures.push('assessment_rejected');
  return { id: fixture.id, passed: !failures.length, failures, metadataValid: parsed.valid, issues: applied.issues,
    progress: applied.lessonKB.progress, reportedProgress: parsed.progress, reportedResponseType: parsed.kbUpdate?.responseType || null,
    evidence: applied.lessonKB.evidence || [], exemplarEvidence: applied.lessonKB.exemplarEvidence,
    profileUpdate: parsed.profileUpdate, rawReply: raw, visibleReply: parsed.text, editorialReview: 'pending' };
}
export async function evaluateCoach({ live = false, trials = 1, maxCalls = 0, invoke, identity, caseIds, onUpdate, stream = false, invokeRepair } = {}) {
  if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error('Trials must be an integer from 1 to 5.');
  let cases = live ? coachFixtures.filter(item => item.expectedValid !== false) : coachFixtures;
  if (caseIds) {
    if (!Array.isArray(caseIds) || !caseIds.length || caseIds.some(id => !cases.some(item => item.id === id))) throw new Error('Select known evaluation case IDs.');
    cases = cases.filter(item => caseIds.includes(item.id));
  }
  if (live && (!Number.isInteger(maxCalls) || cases.length * trials > maxCalls)) throw new Error(`Live evaluation needs an explicit max-calls budget of at least ${cases.length * trials}.`);
  const prompt = await readFile(new URL('../client/prompts/coach.md', import.meta.url), 'utf8');
  if (live && !invoke) {
    const { default: ai } = await import('../server/src/lib/ai-provider.js');
    const { readAiSettings, BEDROCK_MODEL } = await import('../server/src/lib/ai-settings.js');
    const settings = await readAiSettings();
    identity = { provider: settings.provider, model: settings.provider === 'workers-ai' ? settings.workersAiModel : BEDROCK_MODEL, settingsVersion: settings.version };
    invokeRepair = async body => {
      const result = await ai.invokeWithSettings(settings, body, { context: { agent_role: 'coach-assessment-repair' } });
      return { raw: result.content.filter(item => item.type === 'text').map(item => item.text).join(''), usage: result.usage, stopReason: result.stop_reason };
    };
    invoke = async body => {
      if (!stream) {
        const result = await ai.invokeWithSettings(settings, body, { context: { agent_role: 'coach' } });
        return { raw: result.content.filter(item => item.type === 'text').map(item => item.text).join(''), usage: result.usage, stopReason: result.stop_reason };
      }
      let raw = '', usage, stopReason;
      for await (const event of ai.invokeStream(identity.model, body, { context: { agent_role: 'coach' } })) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') raw += event.delta.text;
        if (event.type === 'message_delta') stopReason = event.delta?.stop_reason;
        if (event.usage) usage = event.usage;
      }
      return { raw, usage, stopReason };
    };
  }
  const report = { version: 2, promptScope: 'isolated bundled coach prompt; excludes server admin overrides, program references and enrichment; source framing mirrors server coaching',
    mode: live ? 'live' : 'offline-authored-fixtures', transport: stream ? 'stream' : 'non-stream', promptHash: hash(prompt), repairPromptHash: hash(ASSESSMENT_REPAIR_PROMPT), fixtureHash: hash(JSON.stringify(coachFixtures)),
    identity: identity || { provider: null, model: null }, startedAt: new Date().toISOString(), state: 'running', trials, maxCalls, calls: 0, plannedCases: cases.length * trials,
    passed: false, results: [], qualification: 'Automated contract checks plus a separate recorded agent editorial review of synthetic replies. No production lesson state is written.' };
  await onUpdate?.(report);
  evaluation: for (let trial = 0; trial < trials; trial++) for (const fixture of cases) {
    const body = buildCoachEvaluationRequest(fixture, prompt);
    const started = Date.now();
    let result;
    const call = async (request, phase) => {
      if (report.calls >= maxCalls) { report.state = 'budget-exhausted'; throw new Error('Evaluation call budget exhausted.'); }
      report.calls++;
      report.activeRequest = { case: fixture.id, trial: trial + 1, phase };
      await onUpdate?.(report);
      return (phase === 'assessment-repair' ? (invokeRepair || invoke) : invoke)(request);
    };
    try {
      const response = live ? await call(body, 'coach') : fixture.raw;
      const originalRaw = typeof response === 'string' ? response : response.raw;
      let repairResponse;
      const assessed = live ? await assessCoachResponse(originalRaw, body, async request => {
        repairResponse = await call(request, 'assessment-repair');
        return typeof repairResponse === 'string' ? repairResponse : repairResponse.raw;
      }, { opening: fixture.opening, lessonKB: fixture.kb }) : { raw: originalRaw, repair: { attempted: false, succeeded: false, originalIssues: [] } };
      result = { ...evaluateCoachReply(fixture, assessed.raw, { live }), trial: trial + 1, latencyMs: Date.now() - started,
        requestHash: hash(JSON.stringify(body)), usage: response.usage || null, stopReason: response.stopReason || null,
        originalRawReply: originalRaw, firstPassMetadataValid: parseCoachResponse(originalRaw).valid,
        metadataRepair: assessed.repair, repairRaw: assessed.repairRaw || null, repairUsage: repairResponse?.usage || null };
      if (result.stopReason === 'max_tokens') { result.passed = false; result.failures.push('truncated'); }
    } catch (error) {
      const { code } = classifyAiError(error);
      result = { id: fixture.id, trial: trial + 1, passed: false, failures: ['provider_error'], errorCode: code,
        latencyMs: Date.now() - started, requestHash: hash(JSON.stringify(body)), editorialReview: 'unavailable' };
      if (report.state !== 'budget-exhausted') report.state = 'provider-error';
    }
    delete report.activeRequest;
    report.results.push(result);
    await onUpdate?.(report);
    if (report.state !== 'running') break evaluation;
  }
  if (report.state === 'running') report.state = 'complete';
  report.finishedAt = new Date().toISOString();
  report.passed = report.state === 'complete' && report.results.every(item => item.passed);
  await onUpdate?.(report);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  let completed = 0;
  const report = await evaluateCoach({ live: process.argv.includes('--live'), stream: process.argv.includes('--stream'),
    trials: Number(value('trials') || 1), maxCalls: Number(value('max-calls') || 0), caseIds: value('cases')?.split(','),
    onUpdate: async report => {
      if (value('output')) { await writeFile(`${value('output')}.tmp`, JSON.stringify(report, null, 2) + '\n'); await rename(`${value('output')}.tmp`, value('output')); }
      if (report.results.length > completed) {
        completed = report.results.length;
        const result = report.results.at(-1);
        console.log(JSON.stringify({ case: result.id, completed, planned: report.plannedCases, passed: result.passed, failures: result.failures, latencyMs: result.latencyMs }));
      }
    },
  });
  console.log(JSON.stringify({ mode: report.mode, state: report.state, cases: report.results.length, calls: report.calls, passed: report.passed, promptHash: report.promptHash, identity: report.identity }));
  if (!report.passed) process.exitCode = 1;
}
