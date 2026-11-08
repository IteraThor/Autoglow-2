// AutoGlow Studio output - director. Polls the game state and moves between scenes:
//   idle (blurred camera + title; with two players picked in the Autodarts lobby: versus and player cards)
//   -> intro (versus) -> stinger -> live (cameras + scoreboard)
//   -> leg summary -> ... -> match end (winner + stats) -> idle
// Scenes can also be cued from AutoGlow › Studio. URL options: ?demo=1 scripted match, ?chroma=green.

import { ctx, displayName, t, tn, el } from './ctx.js';
import { initCameras, applyCameras, setLayout, setBlur, setMockupPlayer } from './cameras.js';
import { onDarts, outputDelay } from './darts.js';
import { renderBoard, renderVisit, renderPlayerCard } from './scoreboard.js';
import { MiniBoard } from './dartboard.js';
import {
  stinger, startIdle, stopIdle, playIntro, hideIntro, showLegCard, hideLegCard, showMatchCard, hideMatchCard,
  showMoment, hideMoment, showIdleSlide, setLobby, lobbyReady
} from './scenes.js';
import { DemoFeed, sampleState, sampleBullOff } from './demo.js';
import { renderBullOff, resetBullOff, tieView } from './bulloff.js';

const params = new URLSearchParams(location.search);
ctx.demo = params.get('demo') === '1';
const CHROMA = params.get('chroma') === 'green';

const POLL_MS = 400;
const SETTINGS_MS = 5000;
const IDLE_AFTER_MS = 4000;      // no match for this long -> idle
const MATCH_CARD_MS = 20000;
const LAYOUT_DWELL_MS = 1500;    // a camera layout stays at least this long (no flapping)
const CUE_HOLD_MS = 15000;       // a cued scene is not overridden by the game state for this long
const TIE_SHOW_MS = 3500;        // the darts of a tied bull-off round stay on screen this long

const $ = id => document.getElementById(id);
const stage = $('stage');

// --- Stage scaling -----------------------------------------------------------------------------
function fit() {
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(${(innerWidth - 1920 * scale) / 2}px, ${(innerHeight - 1080 * scale) / 2}px) scale(${scale})`;
}
addEventListener('resize', fit);
fit();
document.addEventListener('dblclick', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
if (window.self !== window.top) $('hint').hidden = true;
setTimeout(() => $('hint').classList.add('gone'), 4000);
if (CHROMA) document.body.dataset.chroma = 'green';

initCameras($('cams'), $('blur'));
const miniBoard = new MiniBoard($('miniBoard'));
const demoFeed = ctx.demo ? new DemoFeed() : null;

// --- Director state ------------------------------------------------------------------------------
let scene = null;
let busy = false;           // a scripted sequence (intro, cards, transitions) is playing
let holdUntil = 0;
let prev = null;            // previous state of the same match
let lastState = null;
let seenMatch = null;       // match that already got its intro / transition
let emptySince = 0;
let matchCardTimer = null;
let lastCueId = null;
let layoutOverride = null;
let currentLayout = '';
let layoutSince = 0;
let prevBullOff = null;     // previous bull-off state (tie and winner detection)
let lastBullOff = null;     // newest bull-off state, drawn when its scene comes on
let tieUntil = 0;

const session = { matchId: null, throws: new Map(), throwIds: new Set(), legStartDarts: [], visitStart: [], bestCheckout: [] };

function setScene(name) {
  scene = name;
  stage.dataset.scene = name;
  if (name === 'idle') {
    startIdle();
    setBlur(ctx.settings?.idle_blur !== false);
  } else {
    stopIdle();
    setBlur(false);
  }
  if (name !== 'match') { hideMatchCard(); clearTimeout(matchCardTimer); }
  if (name !== 'intro') hideIntro();
  if (name !== 'bulloff') resetBullOff();
  else if (lastBullOff && Date.now() >= holdUntil) renderBullOff(lastBullOff);
}

// Sequences play one after another: one arriving while another plays (a cue, a leg end) waits its turn
let queue = Promise.resolve();
let queued = 0;

function run(sequence) {
  queued++;
  busy = true;
  queue = queue.then(sequence).catch(err => console.error('[Studio]', err)).finally(() => {
    queued--;
    busy = queued > 0;
  });
  return queue;
}

const transitionTo = name => stinger(() => setScene(name));

async function introSequence(state, next = 'live') {
  let intro = Promise.resolve();
  await stinger(() => { setScene('intro'); intro = playIntro(state); });
  await intro;
  await transitionTo(next);
}

// --- Bull-off before the first leg -----------------------------------------------------------------
// The intro plays when the lobby starts the match, then the bull-off scene stays until the first leg
const bullOffIntro = bo => ({ players: bo.players, variant: bo.variant, base_score: bo.base_score, target: bo.target });

function showBullOff(bo) {
  lastBullOff = bo;
  // Drawn only while on screen (its entrance plays when it appears); the tied round's darts stay for the banner
  if (scene !== 'bulloff' || Date.now() < tieUntil) return;
  renderBullOff(bo);
}

// A tie (a new round) or the winner, between two states of the same bull-off
function detectBullOff(bo) {
  const old = prevBullOff;
  prevBullOff = bo;
  if (!old || old.match_id !== bo.match_id || scene !== 'bulloff') return;
  if (bo.round > old.round) {
    // Autodarts clears the darts of the tied round at once: keep them on screen for the banner
    renderBullOff(tieView(bo));
    tieUntil = Date.now() + TIE_SHOW_MS;
    showMoment('tie', t('bulloff_tie'), t('bulloff_again'));
    setTimeout(() => { if (scene === 'bulloff' && prevBullOff) renderBullOff(prevBullOff); }, TIE_SHOW_MS + 50);
    return;
  }
  if (bo.decided && !old.decided && bo.winner !== null) {
    const w = bo.players[bo.winner];
    if (w) showMoment('bulloff', displayName(w), t('bulloff_first'), w);
  }
}

// Scene choice while a bull-off runs; true when it took care of the state
function directBullOff(bo) {
  if (!bo) return false;
  if (bo.match_id !== seenMatch) {
    seenMatch = bo.match_id;
    prevBullOff = bo;
    const fresh = bo.round === 1 && !bo.players.some(p => p.thrown);
    if (ctx.settings?.show_intro !== false && fresh && bo.players.length) run(() => introSequence(bullOffIntro(bo), 'bulloff'));
    else if (scene === null) setScene('bulloff');
    else run(() => transitionTo('bulloff'));
    return true;
  }
  if (scene !== 'bulloff') run(() => transitionTo('bulloff'));
  return true;
}

async function matchSequence(state, winner) {
  await showMoment('match', t('moment_match'), winner ? displayName(winner) : '', winner);
  await stinger(() => { setScene('match'); showMatchCard(state, { bestCheckout: session.bestCheckout }); });
  matchCardTimer = setTimeout(() => {
    if (scene === 'match') run(() => transitionTo('idle'));
  }, MATCH_CARD_MS);
}

// --- Session tracking (heatmap, leg summary data) --------------------------------------------------
const totalDarts = state => state.players.reduce((sum, p) => sum + (p.match_stats?.dartsThrown || 0), 0);

function resetSession(state) {
  session.matchId = state.match_id;
  session.throws = new Map();
  session.throwIds = new Set();
  session.legStartDarts = state.players.map(p => p.match_stats?.dartsThrown || 0);
  session.visitStart = state.players.map(p => p.remaining);
  session.bestCheckout = state.players.map(() => null);
}

function trackSession(state) {
  if (session.matchId !== state.match_id) resetSession(state);
  const turn = state.turn || {};
  const owner = state.players[turn.player];
  if (owner) {
    const list = session.throws.get(owner.name) || [];
    for (const t of turn.throws || []) {
      if (t.id && !session.throwIds.has(t.id)) {
        session.throwIds.add(t.id);
        list.push(t);
      }
    }
    session.throws.set(owner.name, list);
    // Score at the start of this visit: the checkout if the visit wins the leg
    session.visitStart[turn.player] = owner.remaining + (turn.busted ? 0 : (turn.points || 0));
  }
  if (prev && (prev.leg !== state.leg || prev.set !== state.set)) {
    session.legStartDarts = state.players.map(p => p.match_stats?.dartsThrown || 0);
  }
}

function legInfo(state, winner) {
  const old = prev.players[winner.index];
  const darts = (winner.match_stats?.dartsThrown || 0) - (session.legStartDarts[winner.index] || 0);
  const checkout = session.visitStart[winner.index] ?? old.remaining;
  if (checkout && checkout > (session.bestCheckout[winner.index] || 0)) session.bestCheckout[winner.index] = checkout;
  return {
    label: state.uses_sets && winner.sets > old.sets ? tn('board_set', prev.set) : tn('board_leg', prev.leg ?? ''),
    title: winner.sets > old.sets ? t('set_title') : t('leg_title'),
    setWon: winner.sets > old.sets,
    player: winner,
    darts: darts > 0 ? darts : null,
    average: darts > 0 && state.base_score ? (state.base_score / darts * 3).toFixed(2) : null,
    checkout: checkout || null,
    oneEighties: old.leg_stats?.total180 ?? null,
    nine: darts === 9 && state.base_score === 501
  };
}

// --- Events between two states of the same match --------------------------------------------------
function detectEvents(state) {
  if (!prev || prev.match_id !== state.match_id || scene !== 'live') return;
  const turn = state.turn || {};
  const oldTurn = prev.turn || {};
  const turnChanged = turn.id !== oldTurn.id || (turn.darts || []).length !== (oldTurn.darts || []).length;

  const legWinner = state.players.find((p, i) => prev.players[i] && (p.legs > prev.players[i].legs || p.sets > prev.players[i].sets));
  const info = legWinner ? legInfo(state, legWinner) : null;

  if (state.finished && !prev.finished && state.winner !== null) {
    run(() => matchSequence(state, state.players[state.winner]));
    return;
  }
  if (info) {
    run(async () => {
      if (info.nine) await showMoment('nine', t('moment_nine'), displayName(info.player), info.player);
      else await showMoment('leg', info.setWon ? t('moment_set') : t('moment_game_shot'), displayName(info.player));
      await showLegCard(info);
    });
    return;
  }
  if (turnChanged && turn.busted && !oldTurn.busted) {
    const p = state.players[turn.player];
    showMoment('bust', t('moment_bust'), p ? displayName(p) : '');
    return;
  }
  if (turnChanged && turn.points === 180 && (turn.darts || []).length === 3) {
    const p = state.players[turn.player];
    showMoment('max', t('moment_180'), p ? displayName(p) : '');
  }
}

// --- Camera direction --------------------------------------------------------------------------------
function directLayout(state) {
  let want = ctx.settings?.layout || 'split';
  if (layoutOverride) {
    want = layoutOverride;
  } else if (ctx.settings?.auto_direct !== false && scene === 'bulloff') {
    // The bull-off is about the board: the board camera in full view
    want = 'board';
  } else if (ctx.settings?.auto_direct !== false && scene === 'live') {
    // Board in full view while darts fly, split screen while the darts are pulled
    const phase = state?.phase || '';
    if (phase === 'throw') want = 'board';
    else if (phase.startsWith('takeout')) want = 'split';
  }
  if (want === currentLayout || Date.now() - layoutSince < LAYOUT_DWELL_MS) return;
  currentLayout = want;
  layoutSince = Date.now();
  setLayout(want);
  stage.dataset.layout = want;
}

// --- Rendering of the live overlays ---------------------------------------------------------------
function renderLive(state) {
  renderBoard(state, prev);
  renderPlayerCard(state);
  renderVisit(state);
  const turn = state.turn || {};
  const owner = state.players[turn.player] || state.players[state.active];
  // The mockup camera shows whoever is at the board
  setMockupPlayer(state.players[state.active] || owner);
  const show = ctx.settings?.show_dartboard !== false && owner;
  $('miniBoard').hidden = !show;
  if (show) {
    const current = new Set((turn.throws || []).map(t => t.id));
    const history = (session.throws.get(owner.name) || []).filter(t => !current.has(t.id));
    miniBoard.update(displayName(owner), turn.throws || [], history);
  }
}

// --- Scene choice from the game state -------------------------------------------------------------
function direct(state) {
  const hasMatch = state.players?.length > 0;
  if (Date.now() < holdUntil) return;
  if (directBullOff(state.bull_off)) return;
  // The next players are picked in Autodarts: leave the finished match for the pre-match slides
  if (lobbyReady() && (scene === 'match' || (scene === 'live' && (!hasMatch || state.finished)))) {
    run(() => transitionTo('idle'));
    return;
  }
  if (!hasMatch) {
    if (scene === null) setScene('idle');
    else if (scene !== 'idle' && scene !== 'match' && Date.now() - emptySince > IDLE_AFTER_MS) run(() => transitionTo('idle'));
    return;
  }
  if (state.match_id !== seenMatch) {
    seenMatch = state.match_id;
    if (state.finished) {
      // Opened after the match ended: nothing to replay
      if (scene === null) setScene('idle');
      return;
    }
    const fresh = totalDarts(state) <= 3;
    if (ctx.settings?.show_intro !== false && fresh) run(() => introSequence(state));
    else if (scene === null) setScene('live');
    else run(() => transitionTo('live'));
    return;
  }
  // The first leg begins after the bull-off (same match: no second intro)
  if (!state.finished && (scene === 'idle' || scene === null || scene === 'bulloff')) run(() => transitionTo('live'));
}

// --- Cues from AutoGlow › Studio --------------------------------------------------------------------
function cueState() {
  return lastState?.players?.length ? lastState : sampleState();
}

function playCue(name) {
  if (name.startsWith('overlay:')) {
    // Instant here; the server also saved it for outputs opened later
    if (ctx.settings) ctx.settings.show_overlay = name === 'overlay:show';
    stage.classList.toggle('no-overlay', name === 'overlay:hide');
    return;
  }
  if (name.startsWith('layout:')) {
    const layout = name.slice(7);
    layoutOverride = layout === 'auto' ? null : layout;
    layoutSince = 0;
    return;
  }
  holdUntil = Date.now() + CUE_HOLD_MS;
  const state = cueState();
  const first = state.players[0];
  switch (name) {
    case 'idle': run(() => transitionTo('idle')); break;
    case 'live': run(() => transitionTo('live')); break;
    case 'intro': run(() => introSequence(state)); break;
    case 'stinger': run(() => stinger()); break;
    case 'leg': run(() => showLegCard({ label: tn('board_leg', state.leg || 1), title: t('leg_title'), player: first, darts: 15, average: '100.20', checkout: 121, oneEighties: 1 })); break;
    case 'match': run(() => matchSequence({ ...state, finished: true, winner: state.winner ?? 0 }, state.players[state.winner ?? 0])); break;
    case '180': showMoment('max', t('moment_180'), first ? displayName(first) : ''); break;
    case 'bust': showMoment('bust', t('moment_bust'), first ? displayName(first) : ''); break;
    case 'bulloff': run(() => bullOffCue()); break;
  }
}

// The bull-off scene with sample players: a dart each, then the winner
async function bullOffCue() {
  await stinger(() => { setScene('bulloff'); renderBullOff(sampleBullOff('running')); });
  await new Promise(resolve => setTimeout(resolve, 2500));
  if (scene !== 'bulloff') return;
  const bo = sampleBullOff('decided');
  renderBullOff(bo);
  await showMoment('bulloff', displayName(bo.players[bo.winner]), t('bulloff_first'), bo.players[bo.winner]);
}

function handleCue(cue) {
  if (lastCueId === null) {
    lastCueId = cue?.id ?? 0; // Cues sent before this page opened are not replayed
    return;
  }
  if (cue && cue.id !== lastCueId) {
    lastCueId = cue.id;
    playCue(cue.scene);
  }
}

// --- Idle status line -------------------------------------------------------------------------------
function renderIdleStatus(state) {
  const src = state.source || {};
  $('idleStatus').textContent = !src.connected
    ? 'Waiting for the AutoGlow Bridge extension in Chrome'
    : src.tab_attached === false ? 'Open play.autodarts.com in Chrome to start'
      : lobbyReady() ? t('lobby_status') : t('idle_ready');
}

// --- Main loop ----------------------------------------------------------------------------------------
function onState(state) {
  if (showcaseKey) return; // The preview shows where a text appears until the Studio page lets go
  handleCue(state.cue);
  const hasMatch = state.players?.length > 0;
  // Players picked in the Autodarts lobby (only sent while no match runs)
  setLobby(hasMatch && !state.finished ? null : state.lobby || null);
  const bo = state.bull_off || null;
  if (bo && Date.now() >= holdUntil) {
    detectBullOff(bo);
    showBullOff(bo);
  } else if (!bo) {
    prevBullOff = null;
    lastBullOff = null;
  }
  if (hasMatch) {
    emptySince = 0;
    if (session.matchId === state.match_id) detectEvents(state);
    trackSession(state);
    renderLive(state);
    lastState = state;
  } else {
    if (!emptySince) emptySince = Date.now();
    setMockupPlayer(null);
  }
  renderIdleStatus(state);
  if (!busy) direct(state);
  directLayout(hasMatch ? state : null);
  prev = hasMatch ? state : prev;
}

// Dart zoom: the cameras run `delay` seconds late, so the scoreboard, banners and scenes follow the
// same delay (else they would show a dart before the picture does). Darts and the Studio's scene
// buttons (cues) are handled at once.
const delayed = [];

function flushDelayed() {
  const now = Date.now();
  while (delayed.length && (delayed[0].at <= now || !outputDelay())) onState(delayed.shift().state);
}
setInterval(flushDelayed, 50);

async function poll() {
  let state = null;
  try {
    const res = await fetch(`/api/studio/state${ctx.demo ? '?demo=1' : ''}`, { cache: 'no-store' });
    if (res.ok) state = await res.json();
  } catch {
    // AutoGlow restarting; try again on the next tick
  }
  if (demoFeed) state = { ...demoFeed.current(), cue: state?.cue ?? null };
  if (state) {
    if (!demoFeed) onDarts(state.darts, state.server_time);
    const delay = outputDelay();
    if (delay > 0) {
      if (!showcaseKey) handleCue(state.cue);
      delayed.push({ at: Date.now() + delay * 1000, state });
    } else {
      flushDelayed();
      onState(state);
    }
  }
  setTimeout(poll, POLL_MS);
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * (1 + amount))));
  return `#${[16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

function applySettings(settings) {
  ctx.settings = settings;
  const accent = settings.accent || '#3b82f6';
  const root = document.documentElement;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-dark', shade(accent, -0.25));
  root.dataset.theme = settings.theme || 'autodarts';
  // Logo wording (Texts) and whether any graphics are shown at all
  document.querySelectorAll('.brand').forEach(brand => {
    brand.querySelector('b').textContent = t('brand_main');
    brand.querySelector('span').textContent = t('brand_accent');
  });
  document.title = `${t('brand_main')} ${t('brand_accent')}`.trim();
  stage.classList.toggle('no-overlay', settings.show_overlay === false);
  applyCameras(CHROMA);
}

// --- Text preview: where an editable text appears (Studio › Broadcast › Texts) ---------------------
// Focusing a text field shows its scene with sample data and highlights the text, until the field is left.
const SHOWCASE = {
  event_title: { view: 'idle-brand', sel: '.sb-title' },
  event_subtitle: { view: 'idle-brand', sel: '.sb-sub' },
  brand_main: { view: 'idle-brand', sel: '.idle-top .logo b' },
  brand_accent: { view: 'idle-brand', sel: '.idle-top .logo span' },
  idle_kicker: { view: 'idle-brand', sel: '.sb-kicker' },
  idle_tagline: { view: 'idle-brand', sel: '.sb-sub' },
  idle_ready: { view: 'idle-brand', sel: '#idleStatus' },
  idle_player_kicker: { view: 'idle-player', sel: '.sp-kicker' },
  lobby_kicker: { view: 'idle-versus', sel: '.slide-versus .sb-kicker' },
  lobby_status: { view: 'idle-versus', sel: '#idleStatus' },
  fact_from: { view: 'idle-player', sel: '.fact', text: true },
  fact_throws: { view: 'idle-player', sel: '.fact', text: true },
  fact_darts: { view: 'idle-player', sel: '.fact', text: true },
  fact_since: { view: 'idle-player', sel: '.fact', text: true },
  board_sets: { view: 'live', sel: '#boardSetsLabel' },
  board_legs: { view: 'live', sel: '#boardLegsLabel' },
  board_set: { view: 'live', sel: '#boardTitle' },
  board_leg: { view: 'live', sel: '#boardTitle' },
  card_avg: { view: 'live', sel: '.pc-values small' },
  card_round: { view: 'live', sel: '.pc-foot' },
  visit_checkout: { view: 'live', sel: '.visit .checkout' },
  visit_bust: { view: 'live', sel: '.visit .total' },
  visit_nine: { view: 'live', sel: '.visit .nine' },
  moment_180: { view: 'moment', kind: 'max', sel: '.moment .m-big' },
  moment_game_shot: { view: 'moment', kind: 'leg', sel: '.moment .m-big' },
  moment_set: { view: 'moment', kind: 'leg', sel: '.moment .m-big' },
  moment_bust: { view: 'moment', kind: 'bust', sel: '.moment .m-big' },
  moment_nine: { view: 'moment', kind: 'nine', sel: '.moment .m-big' },
  moment_match: { view: 'moment', kind: 'match', sel: '.moment .m-big' },
  intro_vs: { view: 'intro', sel: '.intro-vs' },
  bulloff_title: { view: 'bulloff', sample: 'running', sel: '.bo-kicker' },
  bulloff_rule_normal: { view: 'bulloff', sample: 'running', sel: '.bo-rule' },
  bulloff_rule_official: { view: 'bulloff', sample: 'official', sel: '.bo-rule' },
  bulloff_round: { view: 'bulloff', sample: 'tie', sel: '.bo-round' },
  bulloff_turn: { view: 'bulloff', sample: 'running', sel: '.bo-row.active .bo-badge' },
  bulloff_leader: { view: 'bulloff', sample: 'running', sel: '.bo-row.leader .bo-badge' },
  bulloff_first: { view: 'bulloff', sample: 'decided', sel: '.bo-row.winner .bo-badge' },
  bulloff_tie: { view: 'bulloff', sample: 'tie', kind: 'tie', sel: '.moment .m-big' },
  bulloff_again: { view: 'bulloff', sample: 'tie', kind: 'tie', sel: '.moment .m-sub' },
  stat_fav_double: { view: 'intro', sel: '.is-label', text: true },
  leg_title: { view: 'leg', sel: '.lc-head strong' },
  set_title: { view: 'leg', set: true, sel: '.lc-head strong' },
  stat_darts: { view: 'leg', sel: '.lc-cell', text: true },
  stat_leg_average: { view: 'leg', sel: '.lc-cell', text: true },
  stat_checkout: { view: 'leg', sel: '.lc-cell', text: true },
  match_winner: { view: 'match', sel: '.mc-kicker' },
  stat_average: { view: 'match', sel: '.mc-row span', text: true },
  stat_first9: { view: 'match', sel: '.mc-row span', text: true },
  stat_180s: { view: 'match', sel: '.mc-row span', text: true },
  stat_140: { view: 'match', sel: '.mc-row span', text: true },
  stat_100: { view: 'match', sel: '.mc-row span', text: true },
  stat_checkout_pct: { view: 'match', sel: '.mc-row span', text: true },
  stat_best_checkout: { view: 'match', sel: '.mc-row span', text: true }
};
let showcaseKey = null;
let showcaseLabel = '';
let highlightTimer = null;

// A match in progress that shows every scoreboard text: 141 left after six darts (checkout and 9-darter
// alert), sets and legs, a round; a bust when the bust text is edited
function liveSample(key) {
  const s = sampleState();
  s.finished = false;
  s.winner = null;
  s.uses_sets = true;
  s.set = 2;
  s.leg = 3;
  s.round = 4;
  s.active = 0;
  s.players[0].remaining = 141;
  s.players[0].leg_stats = { ...s.players[0].leg_stats, dartsThrown: 6 };
  s.players[1].remaining = 220;
  s.turn = key === 'visit_bust'
    ? { id: 'preview', player: 0, darts: ['T20', 'T20', 'S20'], throws: [], points: 0, busted: true }
    : { id: 'preview', player: 0, darts: [], throws: [], points: 0, busted: false };
  return s;
}

function clearHighlight() {
  clearTimeout(highlightTimer);
  document.querySelectorAll('.text-focus').forEach(e => e.classList.remove('text-focus'));
  document.querySelectorAll('.text-focus-tag').forEach(e => e.remove());
}

function highlight(key) {
  clearHighlight();
  const spec = SHOWCASE[key];
  let els = [...document.querySelectorAll(spec.sel)];
  if (spec.text) {
    const want = t(key).toLowerCase();
    els = els.filter(e => e.textContent.toLowerCase().includes(want));
  }
  els.forEach(e => e.classList.add('text-focus'));
  if (!els.length) return;
  // Name tag above the first place the text appears (stage coordinates: the stage is scaled)
  const stageRect = stage.getBoundingClientRect();
  const scale = stageRect.width / 1920;
  const r = els[0].getBoundingClientRect();
  const tag = el('div', 'text-focus-tag', showcaseLabel || 'This text');
  tag.style.left = `${Math.max(8, (r.left - stageRect.left) / scale)}px`;
  tag.style.top = `${Math.max(8, (r.top - stageRect.top) / scale - 52)}px`;
  stage.append(tag);
}

function showcase(key, inPlace = false) {
  const spec = SHOWCASE[key];
  if (!spec) return;
  showcaseKey = key;
  stage.classList.toggle('no-anim', inPlace);
  hideMoment();
  if (spec.view !== 'leg') hideLegCard();
  const sample = sampleState();
  const live = liveSample(key);
  // The text preview always shows split; the director takes over again when it ends (endShowcase)
  currentLayout = 'split';
  setLayout('split');
  stage.dataset.layout = 'split';
  if (spec.view.startsWith('idle-')) {
    setScene('idle');
    showIdleSlide(spec.view.slice(5), sample);
    $('idleStatus').textContent = spec.view === 'idle-versus' ? t('lobby_status') : t('idle_ready');
  } else if (spec.view === 'intro') {
    setScene('intro');
    playIntro(sample);
  } else if (spec.view === 'bulloff') {
    const bo = sampleBullOff(spec.sample);
    currentLayout = 'board';
    setLayout('board');
    stage.dataset.layout = 'board';
    setScene('bulloff');
    resetBullOff();
    renderBullOff(spec.kind === 'tie' ? tieView(bo) : bo);
    if (spec.kind === 'tie') showMoment('tie', t('bulloff_tie'), t('bulloff_again'), null, { hold: true });
  } else if (spec.view === 'match') {
    setScene('match');
    showMatchCard(sample, { bestCheckout: [121, 96] });
  } else {
    setScene('live');
    renderLive(live);
    const first = live.players[0];
    if (spec.view === 'leg') {
      showLegCard({ label: tn('board_leg', 3), title: spec.set ? t('set_title') : t('leg_title'), player: first,
        darts: 15, average: '100.20', checkout: 121, oneEighties: 1 }, { hold: true });
    } else if (spec.view === 'moment') {
      showMoment(spec.kind, t(key), displayName(first), first, { hold: true });
    }
  }
  // Highlight once the scene has settled (the intro slides in)
  clearHighlight();
  // (the intro slides in; the scoreboard may still be moving from another camera layout: 0.8 s)
  highlightTimer = setTimeout(() => highlight(key), inPlace ? 30 : spec.view === 'intro' ? 1700 : 950);
}

function endShowcase() {
  if (!showcaseKey) return;
  showcaseKey = null;
  stage.classList.remove('no-anim');
  clearHighlight();
  hideMoment();
  hideLegCard();
  // Back to the demo where it is
  layoutSince = 0;
  if (lastState?.players?.length) {
    setScene('live');
    renderLive(lastState);
  } else {
    setScene('idle');
  }
}

// Unsaved changes from AutoGlow › Studio in this browser; demo outputs show them until saved or left
let draft = null;
let idleRefresh = null;

function showDraft(settings) {
  applySettings(settings);
  if (showcaseKey) {
    // Typing in a text field: show the change in place, without replaying the animations
    showcase(showcaseKey, true);
    return;
  }
  if (lastState?.players?.length) renderLive(lastState);
  layoutSince = 0; // A new camera layout shows right away
  directLayout(lastState?.players?.length ? lastState : null);
  if (scene === 'idle') {
    // Title or player changes: rebuild the slides once typing pauses
    clearTimeout(idleRefresh);
    idleRefresh = setTimeout(() => { if (scene === 'idle') setScene('idle'); }, 400);
  }
}

if (ctx.demo && 'BroadcastChannel' in window) {
  new BroadcastChannel('autoglow-studio-draft').onmessage = ({ data }) => {
    if (data?.type === 'draft' && data.settings) {
      draft = data.settings;
      showDraft(draft);
    } else if (data?.type === 'clear') {
      draft = null;
      endShowcase();
      loadSettings().then(() => showDraft(ctx.settings));
    } else if (data?.type === 'play' && data.scene) {
      // A scene played only in this browser's demo outputs (Studio test pages), not on the TVs
      endShowcase();
      playCue(data.scene);
    } else if (data?.type === 'focus-text') {
      if (data.key) {
        showcaseLabel = data.label || '';
        showcase(data.key, data.key === showcaseKey);
      } else {
        endShowcase();
      }
    }
  };
}

async function loadSettings() {
  try {
    const res = await fetch('/api/studio', { cache: 'no-store' });
    if (!res.ok) return;
    const saved = await res.json();
    if (!draft) applySettings(saved);
  } catch {
    // Keep the previous settings
  }
}

loadSettings().then(() => {
  currentLayout = ctx.settings?.layout || 'split';
  setLayout(currentLayout);
  stage.dataset.layout = currentLayout;
  poll();
  setInterval(loadSettings, SETTINGS_MS);
});
