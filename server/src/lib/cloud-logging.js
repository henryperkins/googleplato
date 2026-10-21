// Cloud Run's shared log history. No fallback to a single instance's buffer:
// an unavailable or truncated query must remain visible to the operator.
const SCOPES = ['https://www.googleapis.com/auth/logging.read'];
let auth;
async function requestPage(data) {
  const { GoogleAuth } = await import('google-auth-library');
  auth ||= new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const response = await client.request({
    url: 'https://logging.googleapis.com/v2/entries:list', method: 'POST', data,
    timeout: 15_000, retry: false,
  });
  return response.data;
}

export function normalizeCloudLog(entry) {
  const payload = entry.jsonPayload;
  if (!payload || typeof payload.code !== 'string') return null;
  if (!entry.timestamp || !Number.isFinite(Date.parse(entry.timestamp))) throw new Error('Invalid log timestamp');
  const { logId, level, code, severity: _severity, event: _event, timestamp: _timestamp, ...meta } = payload;
  return {
    logId: logId || `${entry.logName}:${entry.insertId}`, ts: entry.timestamp,
    level: ['error', 'warn', 'info'].includes(level) ? level : entry.severity === 'INFO' ? 'info' : entry.severity === 'WARNING' ? 'warn' : 'error',
    code, meta: { ...meta, revision: entry.resource?.labels?.revision_name }, source: 'cloud-logging',
  };
}

export function logEntryIdentity(entry) {
  return entry.meta?.source === 'client' && entry.meta.eventId && entry.meta.actorRef
    ? `client:${entry.meta.actorRef}:${entry.meta.eventId}` : `server:${entry.logId}`;
}

export async function fetchCloudLoggingLogs({
  since = new Date(Date.now() - 86400_000).toISOString(), until = new Date().toISOString(),
  projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
  serviceName = process.env.CLOUD_RUN_SERVICE || process.env.K_SERVICE,
  location = process.env.CLOUD_RUN_REGION,
} = {}, { request = requestPage, maxPages = 100, maxEntries = 10000, maxDurationMs = 30_000 } = {}) {
  const result = { entries: [], projectId, serviceName, location, since, until, complete: false, error: null };
  const deadline = Date.now() + maxDurationMs;
  try {
    const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
    if (!identifier(projectId) || !identifier(serviceName) || (location && !identifier(location))) {
      throw new Error('Cloud Logging requires a valid project, service, and optional region');
    }
    const start = Date.parse(since), end = Date.parse(until);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Invalid Cloud Logging time window');
    const filter = [
      'resource.type="cloud_run_revision"', `resource.labels.service_name=${JSON.stringify(serviceName)}`,
      ...(location ? [`resource.labels.location=${JSON.stringify(location)}`] : []),
      `timestamp>=${JSON.stringify(new Date(start).toISOString())}`, `timestamp<=${JSON.stringify(new Date(end).toISOString())}`,
      '(severity>=WARNING OR jsonPayload.level="warn" OR jsonPayload.level="error" OR jsonPayload.code="client_save_recovered")',
    ].join(' AND ');
    result.filter = filter;
    const seen = new Set();
    const tokens = new Set();
    let pageToken;
    let scanned = 0;
    for (let page = 0; page < maxPages; page++) {
      let timer;
      let response;
      try {
        response = await Promise.race([
          request({ resourceNames: [`projects/${projectId}`], filter,
            orderBy: 'timestamp asc', pageSize: Math.min(1000, maxEntries - scanned), ...(pageToken ? { pageToken } : {}) }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cloud Logging scan timed out')), Math.max(1, deadline - Date.now())); }),
        ]);
      } finally { clearTimeout(timer); }
      if (!response || typeof response !== 'object' || Array.isArray(response)
        || (response.entries !== undefined && !Array.isArray(response.entries))
        || (response.nextPageToken !== undefined && typeof response.nextPageToken !== 'string')) throw new Error('Invalid Cloud Logging response');
      for (const raw of response.entries || []) {
        scanned++;
        if (scanned > maxEntries) throw new Error('Cloud Logging entry limit reached; narrow the time window');
        const entry = normalizeCloudLog(raw);
        if (!entry) continue;
        const key = logEntryIdentity(entry);
        if (seen.has(key)) continue;
        seen.add(key); result.entries.push(entry);
      }
      pageToken = response.nextPageToken;
      if (!pageToken) { result.complete = true; return result; }
      if (typeof pageToken !== 'string' || tokens.has(pageToken)) throw new Error('Cloud Logging pagination did not advance');
      tokens.add(pageToken);
      if (scanned >= maxEntries) throw new Error('Cloud Logging entry limit reached; narrow the time window');
    }
    throw new Error('Cloud Logging page limit reached; narrow the time window');
  } catch (error) {
    // SDK errors may contain request headers/tokens. Never surface their text.
    const status = error.response?.status || error.status;
    const safe = /^(Cloud Logging |Invalid (Cloud Logging|log timestamp))/.test(error.message || '');
    result.error = status ? `Cloud Logging request failed (HTTP ${status})` : safe ? error.message : 'Cloud Logging read failed; check credentials, permissions, and connectivity';
    return result;
  }
}
