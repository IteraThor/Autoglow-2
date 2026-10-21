// AutoGlow 2 - Core UI entry point
// Loaded as the first deferred script, so the classic scripts after it can use these through window.

import { api, ApiError } from './api.js';
import { connection } from './connection.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { esc, h, showFieldError, clearFieldError } from './dom.js';
import { appStore } from './store.js';
import { toast } from './toast.js';

Object.assign(window, {
  api,
  ApiError,
  toast,
  confirmDialog,
  promptDialog,
  appStore,
  connection,
  dom: { esc, h, showFieldError, clearFieldError }
});
