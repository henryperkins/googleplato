import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import db from './db.js';
import { cloudflareCredentialStatus, environmentCredentialStatus } from './cloudflare-oauth.js';

export const BEDROCK_MODEL = 'qwen3-vl-235b';
export const WORKERS_AI_MODELS = [
  { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', description: 'Text and images. Maximum reasoning. Requires Workers Paid or prepaid AI Gateway credits.' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B', description: 'Text and images. No reasoning mode.' },
];
export const DEFAULT_WORKERS_AI_MODEL = WORKERS_AI_MODELS[0].id;

export function validateAiSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'AI settings must be an object.';
  if (!['bedrock', 'workers-ai'].includes(value.provider)) return 'Choose Amazon Bedrock or Cloudflare Workers AI.';
  if (!WORKERS_AI_MODELS.some(model => model.id === value.workersAiModel)) return 'Choose a supported Cloudflare-hosted model.';
  if (Object.keys(value).some(key => !['provider', 'workersAiModel', 'version'].includes(key))) return 'Only provider and model settings can be saved. Configure credentials on the server.';
  return null;
}

export async function readAiSettings() {
  const item = await db.getSyncData('_system', 'ai-settings', { consistentRead: true });
  const settings = {
    provider: item?.data?.provider ?? process.env.AI_PROVIDER ?? 'bedrock',
    workersAiModel: item?.data?.workersAiModel ?? process.env.WORKERS_AI_MODEL ?? DEFAULT_WORKERS_AI_MODEL,
  };
  if (validateAiSettings(settings)) {
    throw Object.assign(new Error('Invalid server AI settings.'), { name: 'AiConfigurationError', aiStage: 'settings', reason: 'invalid-settings' });
  }
  return { ...settings, version: item?.version || 0 };
}

export const workersAiCredentialStatus = environmentCredentialStatus;

const AWS_CREDENTIAL_VARIABLES = [
  ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], ['AWS_PROFILE'], ['AWS_WEB_IDENTITY_TOKEN_FILE'],
  ['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'], ['AWS_CONTAINER_CREDENTIALS_FULL_URI'], ['AWS_BEARER_TOKEN_BEDROCK'],
];

/**
 * Whether this server shows any AWS credential source for Bedrock. Presence
 * only: no network call and no instance-metadata lookup, so an EC2 instance
 * role cannot be seen. AI Settings warns on a miss but never blocks Bedrock.
 */
export function bedrockCredentialStatus(env = process.env) {
  const present = name => Boolean(env[name]?.trim());
  if (AWS_CREDENTIAL_VARIABLES.some(names => names.every(present))) return { configured: true };
  let home = env.HOME || env.USERPROFILE;
  try { home ||= homedir(); } catch { /* No home directory to search. */ }
  const files = [env.AWS_SHARED_CREDENTIALS_FILE, env.AWS_CONFIG_FILE,
    ...(home ? [join(home, '.aws', 'credentials'), join(home, '.aws', 'config')] : [])];
  return { configured: files.some(file => file && existsSync(file)) };
}

export async function adminAiSettings(settings, userId) {
  return {
    ...settings,
    bedrockModel: BEDROCK_MODEL,
    awsRegion: process.env.AWS_REGION || 'us-east-2',
    bedrockCredentials: bedrockCredentialStatus(),
    workersAiModels: WORKERS_AI_MODELS,
    ...await cloudflareCredentialStatus(userId),
  };
}
