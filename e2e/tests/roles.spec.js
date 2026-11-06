// Roles (#435): what Educators and Testers see, reach, and are refused.
// The server enforces (tests/routes/admin-authorization.test.js); this checks
// the UI matches and stays accessible.
import { test, expect } from '@playwright/test';
import { login, expectAccessible } from '../helpers.js';
import { EDUCATOR, TESTER, LEARNER } from '../fixtures.js';

const nav = (page) => page.getByRole('navigation', { name: 'Admin navigation' });

test.describe('educator', () => {
  test.beforeEach(async ({ page }) => { await login(page, EDUCATOR); });

  test('reaches the dashboard, with Lessons and Users but no Customizer or Plugins', async ({ page }) => {
    await page.goto('/plato');
    await expect(nav(page).getByRole('link', { name: 'Lessons' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Users' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Customizer' })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: 'Plugins' })).toHaveCount(0);
    // Dashboard loaded its stats (an educator's KB 403 must not blank it).
    await expect(page.getByText('Learners', { exact: true })).toBeVisible();
    await expect(page.getByText(/Set up your knowledge base/i)).toHaveCount(0);
    await expectAccessible(page, { label: 'educator dashboard' });
  });

  test('a direct link to Customizer goes back to the dashboard', async ({ page }) => {
    await page.goto('/plato/customizer');
    await expect(page).toHaveURL(/\/plato$/);
  });

  test('Users: can invite, cannot manage groups/fields/wait list or edit accounts', async ({ page }) => {
    await page.goto('/plato/users');
    await expect(page.getByRole('button', { name: 'Invite Users' })).toBeVisible();
    for (const name of ['User Groups', 'User Fields', 'Wait List']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: `Edit ${LEARNER.name}` }).click();
    await expect(page.getByLabel('First name')).toBeDisabled();
    await expect(page.getByLabel(/^Last name/)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByLabel('Role')).toHaveCount(0);
    await expectAccessible(page, { label: 'educator user view' });
  });
});

test.describe('tester', () => {
  test.beforeEach(async ({ page }) => { await login(page, TESTER); });

  test('sees every admin page with a read-only notice', async ({ page }) => {
    await page.goto('/plato');
    for (const name of ['Lessons', 'Users', 'Customizer', 'Plugins']) {
      await expect(nav(page).getByRole('link', { name })).toBeVisible();
    }
    await expect(page.getByText(/Tester \(read-only\)/)).toBeVisible();
    await expectAccessible(page, { label: 'tester dashboard' });
  });

  test('write controls are unavailable while read-only content remains inspectable', async ({ page }) => {
    await page.goto('/plato/users');
    await expect(page.getByRole('button', { name: 'Invite Users' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Manage' })).toHaveCount(0);
    await page.getByRole('button', { name: `Edit ${LEARNER.name}` }).click();
    await expect(page.getByLabel('First name')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await page.goto('/plato/lessons/structure');
    await expect(page.getByRole('button', { name: 'Add course', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Courses & Units' })).toBeVisible();
  });
});
