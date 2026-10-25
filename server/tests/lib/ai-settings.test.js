import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bedrockCredentialStatus } from '../../src/lib/ai-settings.js';

const emptyHome = mkdtempSync(join(tmpdir(), 'plato-aws-empty-'));
const configuredHome = mkdtempSync(join(tmpdir(), 'plato-aws-configured-'));
mkdirSync(join(configuredHome, '.aws'));
writeFileSync(join(configuredHome, '.aws', 'credentials'), '[default]\n');
after(() => {
  rmSync(emptyHome, { recursive: true, force: true });
  rmSync(configuredHome, { recursive: true, force: true });
});

describe('Bedrock credential presence', () => {
  it('finds each AWS SDK credential source from the environment alone', () => {
    for (const env of [
      { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret' },
      { AWS_PROFILE: 'plato' },
      { AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token' },
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/id' },
      { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials' },
      { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-api-key' },
    ]) assert.deepEqual(bedrockCredentialStatus({ HOME: emptyHome, ...env }), { configured: true }, Object.keys(env).join(' '));
  });

  it('finds shared credential files in the home directory or at a configured path', () => {
    assert.deepEqual(bedrockCredentialStatus({ HOME: configuredHome }), { configured: true });
    assert.deepEqual(bedrockCredentialStatus({ HOME: emptyHome, AWS_SHARED_CREDENTIALS_FILE: join(configuredHome, '.aws', 'credentials') }), { configured: true });
  });

  it('reports a server without AWS credentials, such as Cloud Run', () => {
    assert.deepEqual(bedrockCredentialStatus({ HOME: emptyHome, AWS_REGION: 'us-east-2' }), { configured: false });
    assert.deepEqual(bedrockCredentialStatus({ HOME: emptyHome, AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: ' ' }), { configured: false });
    assert.deepEqual(bedrockCredentialStatus({ HOME: emptyHome, AWS_SHARED_CREDENTIALS_FILE: join(emptyHome, 'missing') }), { configured: false });
  });
});
