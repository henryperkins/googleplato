/** Recovery guidance for the admin connection test, without provider internals. */
export function connectionTestErrorMessage(error, provider) {
  const service = provider === 'workers-ai' ? 'Cloudflare Workers AI' : 'Amazon Bedrock';
  const code = error?.data?.code || ({
    400: 'ai_invalid_request',
    408: 'ai_timeout',
    429: 'ai_rate_limited',
    503: 'ai_overloaded',
    504: 'ai_timeout',
  })[error?.status];

  switch (code) {
    case 'ai_rate_limited':
      return `${service} is limiting requests. Wait a moment, then test the connection again.`;
    case 'ai_overloaded':
      return `${service} is busy right now. Wait a moment, then test the connection again.`;
    case 'ai_timeout':
      return `${service} did not respond in time. Try testing the connection again.`;
    case 'ai_unavailable':
      return provider === 'workers-ai'
        ? 'Could not connect to Cloudflare Workers AI. Check the server’s Cloudflare account ID, API token permissions, and model access.'
        : 'Could not connect to Amazon Bedrock. Check the server’s AWS credentials, region, and Bedrock model access.';
    case 'ai_invalid_request':
      return `${service} could not process the connection test. Check the selected model’s supported settings, then test again.`;
    default:
      break;
  }

  if (error?.status === 401 || /session expired|not logged in/i.test(error?.message || '')) {
    return 'Your session expired. Sign in again, then test the connection.';
  }
  if (error?.status === 403) {
    return 'You no longer have access to AI Settings. Sign in with an admin account to test the connection.';
  }
  if (error?.name === 'TypeError' && /failed to fetch|networkerror|load failed/i.test(error.message)) {
    return 'The connection test could not reach the server. Check your connection, then test again.';
  }
  return `${service} connection test failed. Try again. If it keeps failing, check the server logs.`;
}
