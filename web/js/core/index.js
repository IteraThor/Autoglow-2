// AutoGlow 2 - Core UI entry point
// Loaded as the first deferred script, so the classic scripts after it can use these through window.

import { api, ApiError } from './api.js';
import { connection } from './connection.js';
import { choiceDialog, confirmDialog, promptDialog } from './dialog.js';
import { esc, h, showFieldError, clearFieldError } from './dom.js';
import { router } from './router.js';
import { appStore } from './store.js';
import { toast } from './toast.js';
import { initShell } from '../components/shell.js';
import { initControllers } from '../features/controllers.js';
import { initFlowMatrix } from '../features/flow-matrix.js';
// import { initReadiness } from '../features/readiness.js';
import { initLightingGuard } from '../features/lighting-guard.js';
import { initSettings } from '../features/settings.js';
import { initStudio } from '../features/studio.js';
import { initDashboard } from '../features/dashboard.js';
import { initOverlay } from '../features/overlay.js';
import { initPlayers } from '../features/players.js';
import { initNetwork } from '../features/network.js';
import { initClassic } from '../features/classic.js';

Object.assign(window, {
  api,
  ApiError,
  toast,
  confirmDialog,
  choiceDialog,
  promptDialog,
  appStore,
  connection,
  router,
  dom: { esc, h, showFieldError, clearFieldError }
});

initShell();
initControllers();
// Hidden for now (flawed, planned for later): initReadiness();
initSettings();
initStudio();
initDashboard();
initOverlay();
initPlayers();
initNetwork();
initClassic();
initFlowMatrix();
initLightingGuard();
