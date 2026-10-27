// Thin API client. No timers beyond the single upload retry, no storage, no chrome.*.

const RETRYABLE = new Set([408, 415, 429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 45_000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // HTTP status, 0 for network failure / timeout
    this.code = code; // envelope code, null if body was not JSON
    this.retryable = status === 0 || RETRYABLE.has(status);
  }
}

export function makePaths(target) {
  const api = `${target.base}/api`;
  return {
    courses: () => `${api}/student/courses`,
    weeks: (termId) => `${api}/student/courses/terms/${encodeURIComponent(termId)}/weeks`,
    upload: () => `${api}/files/upload`,
    login: () => `${api}/auth/password/login`,
    submissions: (assignmentId) => `${api}/student/assignments/${encodeURIComponent(assignmentId)}/submissions`,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeApi(target, { fetchImpl = (...a) => fetch(...a), uploadRetryDelayMs = 800 } = {}) {
  const paths = makePaths(target);
  let token = null;

  async function request(method, url, body, { auth = true } = {}) {
    if (auth && !token) throw new ApiError(401, null, 'NO_TOKEN');
    const headers = auth ? { Authorization: `Bearer ${token}` } : {};
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: payload, signal: ctrl.signal });
    } catch (e) {
      throw new ApiError(0, null, e?.name === 'AbortError' ? 'TIMEOUT' : String(e?.message || e));
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) throw new ApiError(res.status, json?.code ?? null, json?.message || `HTTP ${res.status}`);
    if (!json || typeof json !== 'object') throw new ApiError(res.status, null, 'BAD_ENVELOPE');
    if (json.code !== 0) throw new ApiError(res.status, json.code, json.message || `code ${json.code}`);
    return json.data;
  }

  return {
    paths,
    setToken: (t) => { token = t || null; },
    hasToken: () => !!token,
    clearToken: () => { token = null; },

    // Password login (the site shows no captcha for it). Resolves with the session
    // object: { token, userId, displayName, role, roles, ... }.
    login: (account, password) => request('POST', paths.login(), { account, password }, { auth: false }),

    courses: () => request('GET', paths.courses()),
    weeks: (termId) => request('GET', paths.weeks(termId)),

    // Resolves with the server's objectName, which is what the SPA sends as `fileUrl`.
    async upload(blob, filename) {
      const send = () => {
        const fd = new FormData();
        fd.append('file', blob, filename || 'upload');
        fd.append('prefix', target.uploadPrefix);
        return request('POST', paths.upload(), fd);
      };
      let data;
      try {
        data = await send();
      } catch (e) {
        if (!(e instanceof ApiError) || !e.retryable) throw e;
        await sleep(uploadRetryDelayMs);
        data = await send();
      }
      const objectName = typeof data === 'string' ? data : data?.objectName;
      if (!objectName) throw new ApiError(200, null, 'UPLOAD_NO_OBJECT_NAME');
      return { objectName, url: typeof data === 'object' ? data.url ?? null : data };
    },

    createSubmission: (assignmentId, nodeId, fileUrl) =>
      request('POST', paths.submissions(assignmentId), { nodeId: nodeId ?? null, fileUrl }),
    updateSubmission: (assignmentId, nodeId, fileUrl) =>
      request('PUT', paths.submissions(assignmentId), { nodeId: nodeId ?? null, fileUrl }),
    // Deliberately no withdraw: the extension never deletes submissions.
  };
}
