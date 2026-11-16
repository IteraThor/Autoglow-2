// AutoGlow 2 - DOM helpers shared by the core UI modules

// HTML escaping for the ES modules; the classic scripts use window.escapeHtml (web/js/utils.js)
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build an element without innerHTML: h('button', { class: 'ui-btn', onclick: fn }, 'Save')
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Mark an input invalid and show the message right under it
export function showFieldError(input, message) {
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  let hint = input.nextElementSibling;
  if (!hint || !hint.classList.contains('field-error')) {
    hint = h('small', { class: 'field-error', role: 'alert' });
    input.after(hint);
  }
  hint.textContent = message;
  input.addEventListener('input', () => clearFieldError(input), { once: true });
  input.focus();
}

export function clearFieldError(input) {
  if (!input) return;
  input.removeAttribute('aria-invalid');
  const hint = input.nextElementSibling;
  if (hint && hint.classList.contains('field-error')) hint.remove();
}

// Pin a popup (position: fixed) next to its anchor so scrolling side panels cannot clip it.
// Opens below the anchor, or above when there is more room there; call after un-hiding the popup.
export function placePopup(pop, anchor, { matchWidth = false, align = 'left' } = {}) {
  const r = anchor.getBoundingClientRect();
  Object.assign(pop.style, { position: 'fixed', right: 'auto', bottom: 'auto', maxHeight: '' });
  if (matchWidth) pop.style.width = `${r.width}px`;
  const gap = 6;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const below = window.innerHeight - r.bottom - gap - 8;
  const above = r.top - gap - 8;
  const up = height > below && above > below;
  const room = up ? above : below;
  if (height > room) pop.style.maxHeight = `${Math.max(120, room)}px`;
  const shown = Math.min(height, Math.max(120, room));
  const left = align === 'right' ? r.right - width : r.left;
  pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  pop.style.top = `${up ? r.top - gap - shown : r.bottom + gap}px`;
}
