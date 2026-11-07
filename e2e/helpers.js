import AxeBuilder from '@axe-core/playwright';

// The fork's sign-in page preloads Google sign-in (client/js/firebaseAuth.js),
// whose Firebase SDK talks to Google's servers and can keep the network busy,
// so `networkidle` would wait on Google. Serve a local stub of that chunk
// instead (as the fork's browser suites do): no e2e test signs in with Google.
const GOOGLE_STUB = `
export const app = {};
export const auth = {};
export function onAuthStateChanged() { return () => {}; }
export async function signInWithGooglePopup() { throw new Error('Google sign-in is stubbed in e2e'); }
export async function signOutFirebase() {}
`;
export async function stubGoogleSignIn(page) {
  await page.context().route('**/assets/firebaseAuth-*.js',
    route => route.fulfill({ contentType: 'text/javascript', body: GOOGLE_STUB }));
}

export async function login(page, { email, password }) {
  await stubGoogleSignIn(page);
  await page.goto('/login');
  await page.getByLabel(/email or username/i).fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/(lessons|plato)/);
}

// The bar: no serious or critical WCAG 2.1 A/AA violations.
export async function expectAccessible(page, { include, label } = {}) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (include) builder = builder.include(include.replaceAll('[role=dialog]', 'dialog[open], [role=dialog]'));
  const { violations } = await builder.analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  if (blocking.length === 0) return;
  const report = blocking.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 5).map((n) => `      ${n.target.join(' ')} — ${(n.any[0]?.message || n.failureSummary || '').split('\n')[0].slice(0, 160)}`).join('\n')}`).join('\n  ');
  throw new Error(`A11Y ${label || page.url()}:\n  ${report}`);
}
