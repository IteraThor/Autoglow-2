// AutoGlow 2 - Unsaved-changes guard for the Lighting pages
// Event Matrix and Flow Matrix edit a draft; leaving the page asks to save or discard it.

import { router } from '../core/router.js';

const PAGES = [
  { pane: 'tab-effects', what: 'event matrix', page: () => window.matrixPage },
  { pane: 'tab-simulator', what: 'flow', page: () => window.flowPage }
];

// page: { isDirty, save() -> bool|Promise<bool>, discard() }
// Also used by the controller page (web/js/features/controller-detail.js)
export async function confirmLeave({ what, save, discard }) {
  const choice = await window.choiceDialog({
    title: 'Unsaved changes',
    body: `You changed the ${what} but did not save. Save now, or discard to go back to the saved version.`,
    choices: [
      { value: 'stay', label: 'Keep editing' },
      { value: 'discard', label: 'Discard', danger: true },
      { value: 'save', label: 'Save', primary: true }
    ]
  });
  if (choice === 'save') return (await save()) === true;
  if (choice === 'discard') {
    await discard();
    return true;
  }
  return false;
}

export function initLightingGuard() {
  window.lightingGuard = { confirmLeave };
  router.addLeaveGuard(from => {
    const entry = PAGES.find(p => p.pane === from.pane);
    const page = entry?.page();
    if (!page?.isDirty()) return true;
    return confirmLeave({ what: entry.what, save: page.save, discard: page.discard });
  });
  window.addEventListener('beforeunload', event => {
    if (PAGES.some(p => p.page()?.isDirty())) event.preventDefault();
  });
}
