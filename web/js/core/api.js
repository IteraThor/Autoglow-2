// AutoGlow 2 - API client
// Every call either returns the parsed JSON body or throws an ApiError with a message the UI can show.

import { connection } from './connection.js';

const DEFAULT_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  constructor({ code = 'ERROR', message = 'Request failed', field = null, retryable = false, status = 0, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.field = field;
    this.retryable = retryable;
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method, body, timeout = DEFAULT_TIMEOUT_MS, signal, headers = {} } = {}) {
  const init = { method: method || (body === undefined ? 'GET' : 'POST'), headers: { ...headers }, cache: 'no-store' };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = timeout > 0 ? setTimeout(() => controller.abort('timeout'), timeout) : null;
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  init.signal = controller.signal;

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (controller.signal.reason === 'timeout') {
      throw new ApiError({ code: 'TIMEOUT', message: 'AutoGlow took too long to answer.', retryable: true });
    }
    if (signal?.aborted) throw err;
    connection.reportDown();
    throw new ApiError({ code: 'NETWORK', message: 'Cannot reach AutoGlow.', retryable: true });
  } finally {
    clearTimeout(timer);
  }
  connection.reportUp();

  const isJson = (res.headers.get('Content-Type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (res.ok && !(data && (data.ok === false || data.status === 'error'))) return data;

  if (res.status === 401 && data?.auth_required && typeof window.showPinPrompt === 'function') {
    window.showPinPrompt();
  }
  const err = data?.error || {};
  throw new ApiError({
    code: err.code || (res.ok ? 'ERROR' : `HTTP_${res.status}`),
    message: err.message || data?.message || res.statusText || 'Request failed',
    field: err.field || null,
    retryable: err.retryable ?? res.status >= 500,
    status: res.status,
    details: err.details || null
  });
}

api.get = (path, opts) => api(path, { ...opts, method: 'GET' });
api.post = (path, body = {}, opts) => api(path, { ...opts, method: 'POST', body });
api.del = (path, body, opts) => api(path, { ...opts, method: 'DELETE', body });
