async (page) => {
  await page.unrouteAll({ behavior: 'wait' });
  const markdown = (name, objective = 'Write a specific, actionable feedback message.') => `# ${name}\n\n## Description\nPractice giving clear, useful feedback in a short workplace conversation.\n\n## Exemplar\nWrite a feedback message that identifies an observed behavior, explains its impact, and requests a concrete next step.\n\n## Learning Objectives\n- Can distinguish observations from assumptions.\n- Can ${objective}\n\n## Coach Instructions\nAsk the learner to draft feedback for a realistic workplace scenario and revise it using the objectives.`;
  const state = {
    records: {},
    requests: [],
    unknown: [],
    aiCount: 0,
    extractions: 0,
    failAi: false,
    failDraft: false,
    failFinalize: false,
    failGet: false,
    delayDraft: 0,
    delayAi: 0,
    delayExtract: 0,
    creatorReply: 'Which skill should this lesson teach, and what should learners be able to demonstrate? [READINESS: 1]',
    extractionQueue: [markdown('Give constructive feedback')],
  };
  await page.context().addInitScript(() => {
    localStorage.setItem('plato_auth', JSON.stringify({
      accessToken: 'synthetic-audit-token',
      refreshToken: 'synthetic-audit-refresh',
      provider: 'password',
      user: { userId: 'audit-admin', email: 'audit@example.test', username: 'audit-admin', name: 'Audit Admin', role: 'admin' },
    }));
  });
  const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:5175') {
      state.unknown.push(`External request blocked: ${url.origin}${path}`);
      return route.abort();
    }
    if (path === '/__audit/control') {
      if (req.method() === 'POST') Object.assign(state, req.postDataJSON());
      return respond(route, state);
    }
    if (!path.startsWith('/v1/')) return route.continue();
    let body = null;
    try { body = req.postDataJSON(); } catch {}
    const entry = { method: req.method(), path, body, started: Date.now() };
    state.requests.push(entry);
    if (path === '/v1/auth/setup-status') return respond(route, { needsSetup: false });
    if (path === '/v1/branding') return respond(route, { classroomName: 'Audit Classroom' });
    if (path === '/v1/version') return respond(route, { version: 'audit-a6ec9da' });
    if (path === '/v1/sync') return respond(route, { items: [], cursor: null });
    if (path.startsWith('/v1/sync/')) return respond(route, { data: null });
    if (path === '/v1/lessons') return respond(route, []);
    if (path === '/v1/knowledge-base') return respond(route, { content: 'Synthetic audit classroom.' });
    if (path === '/v1/admin/courses') return respond(route, [
      { courseId: 'communication', name: 'Workplace communication' },
      { courseId: 'long-course', name: 'A deliberately long course name for checking narrow screens and enlarged text' },
    ]);
    if (path === '/v1/admin/stats/lessons') return respond(route, { byLesson: {} });
    if (path === '/v1/admin/lessons') return respond(route, Object.values(state.records));
    if (path.startsWith('/v1/prompts/')) return respond(route, { content: path.split('/').at(-1) });
    if (path === '/v1/ai/messages') {
      state.aiCount++;
      const extracting = body.system === 'lesson-extractor';
      const delay = extracting ? state.delayExtract : state.delayAi;
      const text = extracting
        ? state.extractionQueue[Math.min(state.extractions++, state.extractionQueue.length - 1)]
        : state.creatorReply;
      const fail = state.failAi;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      entry.completed = Date.now();
      if (fail) return respond(route, { error: 'Synthetic provider failure' }, 502);
      return respond(route, { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } });
    }
    const match = path.match(/^\/v1\/admin\/lessons\/([^/]+)(\/conversation)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (req.method() === 'GET') {
        if (state.failGet) return respond(route, { error: 'Synthetic read failure' }, 500);
        return state.records[id] ? respond(route, state.records[id]) : respond(route, { error: 'Lesson not found' }, 404);
      }
      if (req.method() === 'PUT') {
        const finalizing = !!body.markdown;
        const fail = finalizing ? state.failFinalize : state.failDraft;
        const delay = finalizing ? 0 : state.delayDraft;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        entry.completed = Date.now();
        if (fail) return respond(route, { error: state.failFinalizeStatus === 400 ? 'The lesson needs a title and valid learning objectives.' : 'Synthetic storage failure' }, finalizing ? (state.failFinalizeStatus || 503) : 503);
        const current = state.records[id] || {};
        if (body.operationId && body.operationId === current.authoringOperationId) return respond(route, { ok: true, version: current.version });
        if (body.expectedVersion !== undefined && body.expectedVersion !== (current.version || 0)) return respond(route, { error: 'This lesson changed in another session. Load the saved lesson before continuing.' }, 409);
        if (body.status === 'draft' && current.markdown) return respond(route, { error: 'Lesson already finalized' }, 409);
        const md = body.markdown || current.markdown || '';
        const requested = body.status || current.status || 'private';
        const status = requested === 'draft' && md ? 'private' : requested;
        state.records[id] = {
          ...current, ...body, lessonId: id, markdown: md, status, version: (current.version || 0) + 1, authoringOperationId: body.operationId,
          sharedWith: body.sharedWith || current.sharedWith || [],
          createdAt: current.createdAt || '2026-10-20T08:00:00Z',
        };
        return respond(route, { ok: true, lessonId: id, version: state.records[id].version });
      }
    }
    state.unknown.push(`${req.method()} ${path}`);
    return respond(route, { error: 'Unmapped audit fixture request' }, 599);
  });
  await page.goto('http://127.0.0.1:5175/plato/lessons');
}
