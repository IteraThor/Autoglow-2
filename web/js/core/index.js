// AutoGlow 2 - Core UI entry point
// Loaded as the first deferred script, so the classic scripts after it can use these through window.

import { api, ApiError } from './api.js';
import { connection } from './connection.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { esc, h, showFieldError, clearFieldError } from './dom.js';
import { router } from './router.js';
import { appStore } from './store.js';
import { toast } from './toast.js';
import { initModeSwitch, setLightingMode } from '../components/mode-switch.js';
import { initShell } from '../components/shell.js';
import { initStatusPills } from '../components/status-pills.js';
import { initControllers } from '../features/controllers.js';

Object.assign(window, {
  api,
  ApiError,
  toast,
  confirmDialog,
  promptDialog,
  appStore,
  connection,
  router,
  switchLightingMode: setLightingMode,
  dom: { esc, h, showFieldError, clearFieldError }
});

initShell();
initModeSwitch();
initStatusPills();
initControllers();
