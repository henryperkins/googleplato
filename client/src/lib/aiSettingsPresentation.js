export const AI_PROVIDER_NAMES = {
  bedrock: 'Amazon Bedrock',
  'workers-ai': 'Cloudflare Workers AI',
};

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
