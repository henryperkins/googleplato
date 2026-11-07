import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../output/playwright', import.meta.url));

// PLATO_TEST_EVIDENCE is a run root: suites never write into each other's folder.
export function browserEvidence(suite, browser = 'chromium') {
  const directory = join(process.env.PLATO_TEST_EVIDENCE || root, suite, browser);
  mkdirSync(directory, { recursive: true });
  return directory;
}
