// AutoGlow 2 - Toast notifications
// Short confirmations disappear on their own. An error with a Retry action stays until handled.

import { h } from './dom.js';

const MAX_VISIBLE = 3;
const DURATION_MS = { info: 3500, success: 3000, warning: 5000, error: 8000 };

let host = null;

function getHost() {
  if (!host || !host.isConnected) {
    host = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

function dismiss(el) {
  if (!el.isConnected || el.classList.contains('is-leaving')) return;
  clearTimeout(el._timer);
  el.classList.add('is-leaving');
  setTimeout(() => el.remove(), 200);
}

function show(message, { type = 'info', duration, action } = {}) {
  const container = getHost();
  const text = String(message ?? '');

  // The same message twice in a row (e.g. a failing poll) refreshes the toast instead of stacking
  const existing = [...container.children].find(el => el._text === text && el.dataset.type === type && !el.classList.contains('is-leaving'));
  if (existing) existing.remove();

  const el = h('div', { class: 'toast-item', dataset: { type }, role: type === 'error' ? 'alert' : null },
    h('span', { class: 'toast-text' }, text),
    action && h('button', {
      class: 'toast-action',
      type: 'button',
      onclick: () => { dismiss(el); action.onClick(); }
    }, action.label),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss(el) }, '×')
  );
  el._text = text;
  container.append(el);

  while (container.children.length > MAX_VISIBLE) dismiss(container.firstElementChild);

  const ms = duration ?? (action ? 0 : DURATION_MS[type] ?? DURATION_MS.info);
  if (ms > 0) el._timer = setTimeout(() => dismiss(el), ms);
  return () => dismiss(el);
}

export const toast = {
  show,
  info: (message, opts) => show(message, { ...opts, type: 'info' }),
  success: (message, opts) => show(message, { ...opts, type: 'success' }),
  warning: (message, opts) => show(message, { ...opts, type: 'warning' }),
  // Accepts a message or an ApiError. Retry is offered only when retrying can help.
  error(errOrMessage, { onRetry, ...opts } = {}) {
    const isText = typeof errOrMessage === 'string';
    const message = isText ? errOrMessage : (errOrMessage?.message || 'Something went wrong');
    const canRetry = onRetry && (isText || errOrMessage?.retryable !== false);
    return show(message, { ...opts, type: 'error', action: canRetry ? { label: 'Retry', onClick: onRetry } : undefined });
  }
};
