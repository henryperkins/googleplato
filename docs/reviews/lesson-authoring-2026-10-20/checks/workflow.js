async (page) => {
  const results = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.removeAllListeners('dialog');
  page.on('dialog', dialog => dialog.accept().catch(() => {}));
  const ctl = patch => page.evaluate(async patch => (await fetch('/__audit/control', patch
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }
    : {})).json(), patch);
  const check = (condition, name) => {
    if (!condition) throw new Error(name);
    results.push(name);
  };
  const primary = () => page.locator('.lesson-editor-actions').getByRole('button').last();
  const pane = () => page.getByRole('complementary', { name: 'Lesson markdown preview' });
  const settled = () => page.waitForFunction(() => {
    const button = document.querySelector('.lesson-editor-actions button:last-child');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  });
  const screenshot = async name => {
    await page.evaluate(() => document.querySelector('main').scrollTop = 0);
    await page.screenshot({ path: `output/playwright/lesson-authoring-check/${name}.png`, fullPage: false });
  };

  await page.goto('http://127.0.0.1:5175/plato/lessons/new');
  await page.getByText('Conversation and course saved automatically.', { exact: true }).waitFor();
  check(await pane().getByRole('note').count() === 0, 'Empty preview does not claim unsaved content');
  check((await pane().innerText()).includes('Describe the skill'), 'Empty preview explains the next step');
  check((await page.getByRole('progressbar').getAttribute('aria-valuenow')) === '1'
    && (await page.getByRole('progressbar').innerText()).includes('1/10'), 'Readiness value is visible and accessible');
  await page.waitForFunction(() => {
    const button = document.querySelector('.lesson-editor-actions button:last-child');
    return button && button.getAttribute('aria-disabled') !== 'true';
  });
  check(await primary().getAttribute('aria-disabled') !== 'true'
    && await pane().getByRole('button').getAttribute('aria-disabled') !== 'true', 'Both preview actions are available at low readiness');
  check((await page.locator('#create-lesson-hint').innerText()).includes('3/10'), 'Readiness requirement stays next to the action');
  await screenshot('empty-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('empty-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await primary().click();
  await page.getByRole('button', { name: 'Create Lesson', exact: true }).waitFor();
  check(await primary().getAttribute('aria-disabled') === 'true', 'Creating a lesson still requires at least 3/10 readiness');
  await ctl({ creatorReply: 'We can teach practical feedback. What scenario should learners use? [READINESS: 6]' });
  await page.goto('http://127.0.0.1:5175/plato/lessons/new');
  await settled();
  await page.getByRole('textbox', { name: 'Your message' }).fill('Teach constructive feedback for workplace conversations.');
  await page.getByRole('textbox', { name: 'Your message' }).press('Control+Enter');
  await page.getByRole('log').getByText('Teach constructive feedback for workplace conversations.', { exact: true }).waitFor();
  await settled();
  check(await primary().innerText() === 'Generate preview', 'Primary action names preview generation');
  await ctl({ delayExtract: 900 });
  await primary().click();
  await pane().getByText('Generating preview…', { exact: true }).waitFor();
  check(await primary().innerText() === 'Generating preview…', 'Primary and pane loading labels agree');
  await page.getByRole('button', { name: 'Create Lesson', exact: true }).waitFor();
  check((await pane().getByRole('note').innerText()).includes('Your new lesson starts private.'), 'New preview explains saving and initial visibility');
  await screenshot('ready-desktop');
  await ctl({ failFinalize: true });
  await primary().click();
  await page.getByRole('button', { name: 'Retry saving lesson', exact: true }).waitFor();
  check((await pane().getByRole('note').innerText()).includes('Saving is not confirmed.'), 'Unknown save outcome does not falsely claim failure or success');
  check((await page.getByText('Saving is not confirmed.', { exact: false }).first().innerText()).includes('Retry saving'), 'Save failure has recovery guidance');
  await screenshot('save-retry');
  const beforeRetry = await ctl();
  await ctl({ failFinalize: false, delayExtract: 0 });
  await page.getByRole('button', { name: 'Retry saving lesson', exact: true }).click();
  await page.waitForURL('**/plato/lessons');
  let state = await ctl();
  const lessonId = Object.keys(state.records).find(id => state.records[id].markdown);
  check(state.extractions === beforeRetry.extractions, 'Saving retry preserves the reviewed preview without another AI call');
  check(state.records[lessonId].status === 'private', 'Private-lesson guidance matches the saved result');

  await page.goto(`http://127.0.0.1:5175/plato/lessons/${lessonId}/edit`);
  await pane().getByRole('note').waitFor();
  check((await pane().getByRole('note').innerText()).startsWith('This is the saved lesson.'), 'Existing lesson is identified as saved');
  check(!(await pane().getByRole('note').getAttribute('class')).includes('bg-warning'), 'Saved content uses neutral styling');
  await screenshot('saved-desktop');
  await page.getByRole('textbox', { name: 'Your message' }).fill('Include a remote team example.');
  await page.getByRole('textbox', { name: 'Your message' }).press('Control+Enter');
  await page.getByRole('log').getByText('Include a remote team example.', { exact: true }).waitFor();
  await settled();
  check(await primary().innerText() === 'Refresh preview', 'Changed conversation requests a fresh preview');
  check(await pane().getByRole('note').count() === 0, 'Stale preview does not show conflicting save instructions');
  check((await pane().innerText()).includes('Refresh the preview to include your changes.'), 'Stale preview explains its cause and recovery');
  const refreshed = state.records[lessonId].markdown.replace('Give constructive feedback', 'Give feedback to a remote team');
  await ctl({ delayExtract: 900, extractionQueue: [refreshed] });
  await primary().click();
  await pane().getByText('Refreshing preview…', { exact: true }).waitFor();
  check(await primary().innerText() === 'Refreshing preview…', 'Refresh operation is named consistently while loading');
  await page.getByRole('button', { name: 'Update Lesson', exact: true }).waitFor();
  check((await pane().getByRole('note').innerText()).includes('“Update Lesson” to save your changes.'), 'Edited preview explains the update step');
  await ctl({ delayExtract: 0, failFinalize: true, failFinalizeStatus: 400 });
  await primary().click();
  await page.getByRole('button', { name: 'Revise lesson', exact: true }).waitFor();
  check((await pane().getByRole('note').innerText()).includes('Choose “Revise lesson”'), 'Rejected preview directs the author to revision');
  check(await primary().innerText() === 'Revise lesson'
    && await page.getByRole('button', { name: 'Retry saving', exact: true }).count() === 0, 'Rejected content presents revision as the primary recovery');
  await page.getByRole('button', { name: 'Revise lesson', exact: true }).click();
  await settled();
  check(await primary().innerText() === 'Refresh preview', 'Revision returns to the refresh step');
  await ctl({ failFinalize: false, failFinalizeStatus: 503, failAi: true });
  await primary().click();
  await pane().getByRole('alert').waitFor();
  check((await pane().getByRole('alert').innerText()).length > 0, 'Preview failure is announced with an actionable error');
  await ctl({ failAi: false });
  await primary().click();
  await page.getByRole('button', { name: 'Update Lesson', exact: true }).waitFor();
  await primary().click();
  await page.waitForURL('**/plato/lessons');
  check(true, 'Updated lesson completes the workflow after revision');

  await ctl({ failAi: true });
  await page.goto('http://127.0.0.1:5175/plato/lessons/new');
  await page.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  check((await page.locator('.lesson-editor-chat').innerText()).includes('The conversation could not start.'), 'Opening failure does not claim a user message was retained');
  await ctl({ failAi: false });
  await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
  await settled();
  await ctl({ failAi: true });
  await page.getByRole('textbox', { name: 'Your message' }).fill('Teach feedback in a project review.');
  await page.getByRole('textbox', { name: 'Your message' }).press('Control+Enter');
  await page.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  check((await page.locator('.lesson-editor-chat').innerText()).includes('Your message is still in the conversation.'), 'Reply failure tells the author where the submitted message remains');
  await ctl({ failAi: false });
  await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
  await settled();
  await primary().click();
  await page.getByRole('button', { name: 'Create Lesson', exact: true }).waitFor();
  state = await ctl();
  check(state.unknown.length === 0, 'All requests stayed inside the synthetic fixture');
  check(errors.length === 0, 'No runtime errors during the verified workflow');
  await page.evaluate(value => { window.__copyResults = value; }, { results, errors, unknown: state.unknown });
}
