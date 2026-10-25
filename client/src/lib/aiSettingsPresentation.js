export const AI_PROVIDER_NAMES = {
  bedrock: 'Amazon Bedrock',
  'workers-ai': 'Cloudflare Workers AI',
};

/** Reject incomplete API results before replacing a usable settings form. */
export function requireAiSettingsResponse(value, { connectionRequired = false } = {}) {
  const record = item => Boolean(item) && typeof item === 'object' && !Array.isArray(item);
  const text = item => typeof item === 'string' && item.length > 0;
  const oauth = value?.workersAiOAuth;
  const connectionFlags = ['available', 'connected', 'needsReconnect', 'connectionPending', 'revocationPending'];
  const completeConnection = record(oauth) && connectionFlags.every(key => typeof oauth[key] === 'boolean');
  const connectionValid = oauth == null || (record(oauth)
    && connectionFlags
      .every(key => oauth[key] === undefined || typeof oauth[key] === 'boolean')
    && (!(oauth.connected || oauth.needsReconnect || oauth.connectionPending)
      || (Number.isSafeInteger(oauth.version) && oauth.version >= 0))
    && (oauth.account == null || (record(oauth.account) && (oauth.account.name == null || typeof oauth.account.name === 'string')))
    && (oauth.pendingAccounts == null || (Array.isArray(oauth.pendingAccounts)
      && oauth.pendingAccounts.every(account => record(account) && text(account.id) && text(account.name))
      && (oauth.pendingAccounts.length === 0 || text(oauth.pendingFlowId)))));
  if (!record(value) || !Object.hasOwn(AI_PROVIDER_NAMES, value.provider)
    || !Number.isSafeInteger(value.version) || value.version < 0
    || !text(value.bedrockModel) || !text(value.awsRegion)
    || !Array.isArray(value.workersAiModels)
    || !value.workersAiModels.every(model => record(model) && text(model.id) && text(model.name)
      && (model.description == null || typeof model.description === 'string'))
    || !value.workersAiModels.some(model => model.id === value.workersAiModel)
    || !record(value.workersAiCredentials) || typeof value.workersAiCredentials.configured !== 'boolean'
    || !connectionValid || (connectionRequired && !completeConnection)) {
    throw new Error('The server returned incomplete AI settings. Reload settings and try again.');
  }
  return value;
}

export function aiModelName(settings, provider = settings.provider, modelId) {
  if (provider === 'bedrock') {
    const id = modelId || settings.bedrockModel;
    return id === 'qwen3-vl-235b' ? 'Qwen3-VL 235B A22B' : id;
  }
  const id = modelId || settings.workersAiModel;
  return settings.workersAiModels.find(item => item.id === id)?.name || id;
}

export function aiConfigurationKey(settings) {
  return JSON.stringify(settings.provider === 'bedrock'
    ? ['bedrock', settings.bedrockModel, settings.awsRegion]
    : [settings.provider, settings.workersAiModel]);
}

export function aiConfigurationLabel(settings) {
  const label = `${AI_PROVIDER_NAMES[settings.provider]} · ${aiModelName(settings)}`;
  return settings.provider === 'bedrock' ? `${label} · ${settings.awsRegion}` : label;
}

export function pendingAiSettingsChanges(saved, draft) {
  const changes = [];
  if (saved.provider !== draft.provider) {
    changes.push({ label: 'Provider', before: AI_PROVIDER_NAMES[saved.provider], after: AI_PROVIDER_NAMES[draft.provider] });
  }
  if (saved.workersAiModel !== draft.workersAiModel) {
    const inactive = draft.provider !== 'workers-ai';
    changes.push({
      label: inactive ? 'Cloudflare model for future switches' : 'Cloudflare model',
      before: aiModelName(saved, 'workers-ai'),
      after: aiModelName(saved, 'workers-ai', draft.workersAiModel),
      inactive,
    });
  }
  return changes;
}

export function savedAiSettingsMessage(saved, changes) {
  let message = `AI settings saved. New requests use ${aiConfigurationLabel(saved)}.`;
  if (changes.some(change => change.inactive)) {
    message += ` Cloudflare model ${aiModelName(saved, 'workers-ai')} is saved for future switches.`;
  }
  return message;
}

/**
 * Why Bedrock will likely fail on this server, or null. The server checks only
 * for credential presence and cannot see an instance role, so this warns and
 * never blocks. Servers that predate the check report nothing.
 */
export function bedrockCredentialWarning(settings) {
  if (settings?.bedrockCredentials?.configured !== false) return null;
  return 'No AWS credentials were found on this server, so Bedrock requests will fail unless the server uses an AWS instance role. Ask your server owner to set up AWS access, or use Cloudflare Workers AI.';
}

export function testedAiConfiguration(request, response) {
  const provider = response.provider || request.provider;
  return {
    ...request,
    provider,
    ...(provider === 'bedrock'
      ? { bedrockModel: response.model || request.bedrockModel }
      : { workersAiModel: response.model || request.workersAiModel }),
  };
}
