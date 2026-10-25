// AutoGlow 2 - In-app confirm and prompt dialogs (replace window.confirm / window.prompt)

import { h, showFieldError } from './dom.js';

function openDialog(content, onSubmit) {
  return new Promise(resolve => {
    let result = null;
    const form = h('form', { class: 'ui-dialog-form', method: 'dialog' }, ...content.children);
    const dialog = h('dialog', { class: 'ui-dialog', 'aria-label': content.title }, form);

    form.addEventListener('submit', event => {
      // The cancel button submits too; only the confirm button runs onSubmit
      if (event.submitter?.value !== 'confirm') return;
      const outcome = onSubmit();
      if (outcome === undefined) {
        event.preventDefault();
        return;
      }
      result = outcome;
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.append(dialog);
    dialog.showModal();
    content.focus?.focus();
  });
}

function actions(confirmLabel, cancelLabel, danger) {
  return h('div', { class: 'ui-dialog-actions' },
    h('button', { class: 'ui-btn', type: 'submit', value: 'cancel', formnovalidate: true }, cancelLabel),
    h('button', { class: `ui-btn ${danger ? 'ui-btn-danger' : 'ui-btn-primary'}`, type: 'submit', value: 'confirm' }, confirmLabel)
  );
}

// Resolves true when confirmed, false when cancelled or dismissed with Esc
export async function confirmDialog({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  const buttons = actions(confirmLabel, cancelLabel, danger);
  const result = await openDialog({
    title,
    children: [
      h('div', { class: 'ui-dialog-title' }, title),
      body && h('div', { class: 'ui-dialog-body' }, body),
      buttons
    ],
    // Destructive actions start on Cancel so Enter never confirms them by accident
    focus: danger ? buttons.firstElementChild : buttons.lastElementChild
  }, () => true);
  return result === true;
}

// Resolves the entered text, or null when cancelled. validate(value) returns an error message or nothing.
export async function promptDialog({ title, body = '', value = '', placeholder = '', confirmLabel = 'Save', cancelLabel = 'Cancel', maxLength, validate }) {
  const input = h('input', { class: 'ui-dialog-input', type: 'text', value, placeholder, maxlength: maxLength, 'aria-label': title });
  return openDialog({
    title,
    children: [
      h('div', { class: 'ui-dialog-title' }, title),
      body && h('div', { class: 'ui-dialog-body' }, body),
      input,
      actions(confirmLabel, cancelLabel, false)
    ],
    focus: input
  }, () => {
    const text = input.value.trim();
    const problem = validate ? validate(text) : null;
    if (problem) {
      showFieldError(input, problem);
      return undefined;
    }
    return text;
  });
}

// Three-way choice. choices: [{ value, label, primary?, danger? }]. Resolves the chosen value, or null when dismissed with Esc.
export function choiceDialog({ title, body = '', choices }) {
  return new Promise(resolve => {
    let result = null;
    const buttons = choices.map(choice => h('button', {
      class: `ui-btn ${choice.danger ? 'ui-btn-danger' : choice.primary ? 'ui-btn-primary' : ''}`.trim(),
      type: 'button',
      onclick: () => { result = choice.value; dialog.close(); }
    }, choice.label));
    const dialog = h('dialog', { class: 'ui-dialog', 'aria-label': title },
      h('div', { class: 'ui-dialog-form' },
        h('div', { class: 'ui-dialog-title' }, title),
        body && h('div', { class: 'ui-dialog-body' }, body),
        h('div', { class: 'ui-dialog-actions' }, ...buttons)));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    buttons.find((_, i) => choices[i].primary)?.focus();
  });
}
