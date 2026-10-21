/**
 * AutoGlow 2 - State & Utility Store
 * Centralized shared UI state, constants, and routing maps.
 */

var appState = {
  device: {},
  devices: [],
  profile: {
    events: {}
  },
  profiles: [],
  active_profile: 'Default',
  autodarts: {},
  raw: {}
};

var matrixDirty = false;
var lastFetchedLiveDeviceData = {};
var activeInlineEdits = {};
var selectedMatrixDeviceIp = (typeof localStorage !== 'undefined' ? localStorage.getItem('autoglow_selected_matrix_device') : null) || null;
var selectedMatrixSegmentId = null;

var idlePresetState = {
  ip: (typeof localStorage !== 'undefined' ? localStorage.getItem('autoglow_selected_power_device') : null) || null,
  loaded: false,
  presetId: 1,
  name: 'AutoGlow Default',
  loadedPreset: null,
  deviceInfo: null,
  segments: [],
  cachedWledEffects: null
};

var ROUTE_MAP = {
  '/': 'tab-dashboard',
  '/hub': 'tab-dashboard',
  '/dashboard': 'tab-dashboard',
  '/devices': 'tab-devices',
  '/wled-devices': 'tab-devices',
  '/autodarts': 'tab-autodarts',
  '/autodarts-account': 'tab-autodarts',
  '/matrix': 'tab-effects',
  '/event-matrix': 'tab-effects',
  '/power': 'tab-power',
  '/power-timers': 'tab-power',
  '/idle': 'tab-power',
  '/idle-mode': 'tab-power',
  '/simulator': 'tab-simulator',
  '/led-simulator': 'tab-simulator',
  '/settings': 'tab-settings',
  '/updates': 'tab-settings',
  '/updates-backups': 'tab-settings',
  '/backups': 'tab-settings'
};

const TAB_TO_ROUTE = {
  'tab-dashboard': '/hub',
  'tab-devices': '/devices',
  'tab-autodarts': '/autodarts',
  'tab-effects': '/matrix',
  'tab-power': '/power',
  'tab-simulator': '/simulator',
  'tab-settings': '/settings'
};


const EVENT_CATEGORIES = [
  {
    id: "victories",
    label: "Match & Victories",
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.45 1-1 1H7v4h10v-4h-2c-.55 0-1-.45-1-1v-2.34c3.27-.67 5.75-3.37 5.97-6.66H4.03C4.25 11.29 6.73 13.99 10 14.66z"/></svg>`
  },
  {
    id: "throws",
    label: "Hits & Throws",
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>`
  },
  {
    id: "flow",
    label: "Game Flow & Transitions",
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`
  },
  {
    id: "players",
    label: "Throw - Players",
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
  }
];

const EVENT_DEFS = [
  { key: "match_won", category: "victories", label: "Match Won", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "leg_won", category: "victories", label: "Leg Won", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "180", category: "throws", label: "180 (3xT20)", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "single", category: "throws", label: "Single Hit", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "double", category: "throws", label: "Double Hit", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "triple", category: "throws", label: "Triple Hit", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "bullseye", category: "throws", label: "Bullseye (50)", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "bust", category: "throws", label: "Bust / Miss", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "game_start", category: "flow", label: "Game Started", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "throw", category: "flow", label: "Throw - Any Player", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "takeout_in_progress", category: "flow", label: "Takeout in Progress", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "takeout", category: "flow", label: "Takeout", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "manual_reset", category: "flow", label: "Manual Reset", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false },
  { key: "calibrating", category: "flow", label: "Calibrating", defaultAnim: "solid", defaultCol: "#000000", defaultDur: 0.0, defaultSpeed: 1.0, defaultEnabled: false }
];

const DEFAULT_PLAYER_SLOTS = [
  { id: 1, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 2, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 3, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 4, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 5, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 6, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 7, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 8, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 9, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false },
  { id: 10, name_filter: "", match_type: "contains", effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false }, enabled: false }
];

const ANIMATION_OPTIONS = [
  { value: "solid", label: "Solid" },
  { value: "chase", label: "Circular Chase" },
  { value: "rainbow", label: "Rainbow" },
  { value: "pastel_rainbow", label: "Pastel Rainbow" },
  { value: "flash", label: "Flash" },
  { value: "curtain", label: "Split Curtain" },
  { value: "heartbeat", label: "Heartbeat" },
  { value: "dual_comet", label: "Dual Comet" },
  { value: "sparkle", label: "Sparkle" },
  { value: "fire", label: "Fire" },
  { value: "radar", label: "Radar" },
  { value: "breathe", label: "Breathe" }
];


// Attach all to window for global access
if (typeof window !== "undefined") {
  window.appState = appState;
  window.lastFetchedLiveDeviceData = lastFetchedLiveDeviceData;
  window.activeInlineEdits = activeInlineEdits;
  window.selectedMatrixDeviceIp = selectedMatrixDeviceIp;
  window.selectedMatrixSegmentId = selectedMatrixSegmentId;
  window.idlePresetState = idlePresetState;
  window.ROUTE_MAP = ROUTE_MAP;
  window.TAB_TO_ROUTE = TAB_TO_ROUTE;
  window.EVENT_CATEGORIES = EVENT_CATEGORIES;
  window.EVENT_DEFS = EVENT_DEFS;
  window.DEFAULT_PLAYER_SLOTS = DEFAULT_PLAYER_SLOTS;
  window.ANIMATION_OPTIONS = ANIMATION_OPTIONS;
  window.matrixDirty = matrixDirty;
}
