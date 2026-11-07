/**
 * Guards on server/template.yaml that only a real deploy would otherwise catch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
// Each function's block, from its logical id to the next top-level resource.
const fn = (name) => template.split(new RegExp(`^  ${name}:$`, 'm'))[1].split(/^ {2}\S/m)[0];

describe('template.yaml', () => {
  for (const name of ['PlatoApiFunction', 'PlatoStreamFunction']) {
    it(`${name} may send raw email (notifications use SES SendRawEmail)`, () => {
      assert.match(fn(name), /- ses:SendRawEmail/);
      assert.match(fn(name), /- ses:SendEmail/);
    });
    it(`${name} may run DynamoDB transactions (lesson turns, branding)`, () => {
      // SAM's DynamoDBCrudPolicy does not grant the Transact APIs, but
      // db-dynamodb.js issues TransactGet/TransactWrite on the sync-data
      // table for every lesson save.
      assert.match(fn(name), /dynamodb:TransactGetItems/);
      assert.match(fn(name), /dynamodb:TransactWriteItems/);
      assert.match(fn(name), /Resource: !GetAtt SyncDataTable\.Arn/);
    });
    it(`${name} pins DB_BACKEND=dynamodb instead of relying on the default`, () => {
      assert.match(fn(name), /DB_BACKEND: dynamodb/);
    });
  }
  // Same table guards as upstream (b4da71a / #515).
  for (const name of ['UsersTable', 'InvitesTable', 'RefreshTokensTable', 'SyncDataTable', 'AuditLogTable']) {
    it(`${name} is kept if the resource is removed or replaced`, () => {
      assert.match(fn(name), /DeletionPolicy: Retain/);
      assert.match(fn(name), /UpdateReplacePolicy: Retain/);
    });
  }
  it('creates no EventBridge rules (the deploy role in docs/DEPLOY.md cannot)', () => {
    assert.doesNotMatch(template, /Type: Schedule|AWS::Events::Rule/);
  });
  it('leaves PITR to the console, as upstream does (the deploy role cannot manage continuous backups)', () => {
    assert.doesNotMatch(template, /PointInTimeRecovery/);
  });
  it('deploys the handlers server/src/index.js exports on the current runtime', () => {
    assert.match(template, /Handler: src\/index\.handler/);
    assert.match(template, /Handler: src\/index\.streamHandler/);
    assert.match(template, /Runtime: nodejs24\.x/);
  });
});

describe('Lambda artifact bundling', () => {
  const bundle = readFileSync(new URL('../../../scripts/bundle-lambda-artifacts.sh', import.meta.url), 'utf8');
  const buildSh = readFileSync(new URL('../../../scripts/build.sh', import.meta.url), 'utf8');
  const rootPkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

  it('bundles the SPA, prompts, plugins, and version into both functions', () => {
    for (const asset of ['client-dist', 'client-content', 'plugins', 'version.json']) {
      assert.ok(bundle.includes(asset), `bundle script must copy ${asset}`);
    }
    assert.match(bundle, /PlatoApiFunction/);
    assert.match(bundle, /PlatoStreamFunction/);
  });
  it('is invoked by every scripted deploy path', () => {
    assert.match(buildSh, /bundle-lambda-artifacts\.sh/);
    assert.match(rootPkg.scripts.deploy, /bundle-lambda-artifacts\.sh/);
  });
});
