// User Groups (#434): add, rename (with duplicate check), delete with confirm.
import { test, expect } from '@playwright/test';
import { login, expectAccessible } from '../helpers.js';
import { ADMIN } from '../fixtures.js';

test('admins add, rename, and delete groups; errors show in the dialog', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/plato/users');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('menuitem', { name: 'User Groups' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Groups' });
  const list = dialog.getByRole('list', { name: 'Groups' });

  await dialog.getByLabel('New group name').fill('Temp Group');
  await dialog.getByLabel('New group name').press('Enter');
  await expect(list.getByRole('listitem').filter({ hasText: 'Temp Group' })).toBeVisible();
  const names = await list.getByRole('listitem').allInnerTexts();
  expect(names.map((n) => n.split('\n')[0])).toEqual([...names.map((n) => n.split('\n')[0])].sort((a, b) => a.localeCompare(b)));
  await expectAccessible(page, { include: '[role=dialog]', label: 'groups dialog' });

  await dialog.getByRole('button', { name: 'Rename group Temp Group' }).click();
  const input = dialog.getByLabel('New name for Temp Group');
  await expect(input).toBeFocused();
  await input.fill('cohort a');
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('A group with that name already exists');
  await input.fill('Renamed Group');
  await input.press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('Renamed Temp Group to Renamed Group.');

  await dialog.getByRole('button', { name: 'Delete group Renamed Group' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('will no longer be in a group');
  await confirm.getByRole('button', { name: 'Delete group' }).click();
  await expect(list.getByRole('listitem').filter({ hasText: 'Renamed Group' })).toHaveCount(0);
});

function deferred() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), resolve: () => release() };
}
async function openGroups(page) {
  await login(page, ADMIN);
  await page.goto('/plato/users');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('menuitem', { name: 'User Groups' }).click();
  return page.getByRole('dialog', { name: 'User Groups' });
}

test('group keyboard focus survives pending work, failed rename, cancel, successful rename and deletion', async ({ page }) => {
  const dialog = await openGroups(page);
  const add = dialog.getByLabel('New group name');
  await add.fill('Focus Alpha');
  await add.press('Enter');
  const renameAlpha = dialog.getByRole('button', { name: 'Rename group Focus Alpha', exact: true });
  await expect(renameAlpha).toBeVisible();
  let releaseRename = deferred();
  let renameRequests = 0;
  let failRename = true;
  await page.route('**/v1/admin/groups', async route => {
    if (route.request().postDataJSON().oldName !== 'Focus Alpha') return route.fallback();
    renameRequests++;
    await releaseRename.promise;
    if (failRename) return route.fulfill({ status: 409, json: { error: 'Rename conflict; keep these edits.' } });
    return route.fulfill({ response: await route.fetch() });
  });
  await renameAlpha.focus();
  await renameAlpha.press('Enter');
  let input = dialog.getByLabel('New name for Focus Alpha');
  await input.fill('Focus Gamma');
  await input.press('Enter');
  await expect.poll(() => renameRequests).toBe(1);
  await expect(input).toBeFocused();
  await expect(input).not.toBeEditable();
  await input.press('Enter');
  expect(renameRequests).toBe(1);
  releaseRename.resolve();
  await expect(dialog.getByRole('alert')).toHaveText('Rename conflict; keep these edits.');
  await expect(input).toHaveValue('Focus Gamma');
  await expect(input).toBeFocused();
  releaseRename = deferred();
  failRename = false;
  await input.press('Enter');
  await expect.poll(() => renameRequests).toBe(2);
  await expect(input).toBeFocused();
  releaseRename.resolve();
  const renameGamma = dialog.getByRole('button', { name: 'Rename group Focus Gamma', exact: true });
  await expect(renameGamma).toBeFocused();
  await renameGamma.press('Enter');
  await dialog.getByLabel('New name for Focus Gamma').press('Escape');
  await expect(renameGamma).toBeFocused();
  await expect(dialog).toBeVisible();
  await renameGamma.press('Enter');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(renameGamma).toBeFocused();

  const remove = dialog.getByRole('button', { name: 'Delete group Focus Gamma', exact: true });
  const releaseDelete = deferred();
  let deleteRequests = 0;
  await page.route('**/v1/admin/groups/Focus%20Gamma', async route => {
    deleteRequests++;
    await releaseDelete.promise;
    return route.fulfill({ response: await route.fetch() });
  });
  await remove.focus();
  await remove.press('Enter');
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Delete group', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => deleteRequests).toBe(1);
  await expect(remove).toBeFocused();
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  releaseDelete.resolve();
  await expect(remove).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('completed group rename preserves deliberate focus movement and does not refocus a closed dialog', async ({ page }) => {
  const dialog = await openGroups(page);
  await dialog.getByLabel('New group name').fill('Focus Movement');
  await dialog.getByLabel('New group name').press('Enter');
  let hold = deferred();
  let calls = 0;
  await page.route('**/v1/admin/groups', async route => {
    if (!route.request().postDataJSON().oldName?.startsWith('Focus Movement')) return route.fallback();
    calls++;
    await hold.promise;
    return route.fulfill({ response: await route.fetch() });
  });
  await dialog.getByRole('button', { name: 'Rename group Focus Movement', exact: true }).press('Enter');
  await dialog.getByLabel('New name for Focus Movement').fill('Focus Movement New');
  await dialog.getByLabel('New name for Focus Movement').press('Enter');
  await expect.poll(() => calls).toBe(1);
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await close.focus();
  hold.resolve();
  await expect(dialog.getByRole('status')).toHaveText('Renamed Focus Movement to Focus Movement New.');
  await expect(close).toBeFocused();
  hold = deferred();
  await dialog.getByRole('button', { name: 'Rename group Focus Movement New', exact: true }).press('Enter');
  await dialog.getByLabel('New name for Focus Movement New').fill('Focus Movement Final');
  await dialog.getByLabel('New name for Focus Movement New').press('Enter');
  await expect.poll(() => calls).toBe(2);
  await close.click();
  const outside = page.getByRole('button', { name: 'Columns', exact: true });
  await outside.focus();
  const response = page.waitForResponse(res => res.request().method() === 'PUT' && res.url().endsWith('/v1/admin/groups'));
  hold.resolve();
  await response;
  await expect(dialog).toHaveCount(0);
  await expect(outside).toBeFocused();
});
