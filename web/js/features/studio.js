// AutoGlow 2 - Studio page: the broadcast as a timeline. Setup (look, players, cameras) comes first, then
// the match in the order it plays on the TV. Picking a step plays it in the preview and lists only what
// that step shows. Changes save by themselves; "Show on TVs" plays the step on every screen.
// The broadcast itself is web/studio/live.html; it reads the same settings from /api/studio.

import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import * as core from './studio-core.js';
import { cue, endDraft, flush, focusText, icon, loadSettings, play, saveMark } from './studio-core.js';
import { layoutPicker, lookPicker, playersPanel, popover, section, statusDots, switchRow, textsEditor } from './studio-parts.js';
import { camerasPanel, stopCameras } from './studio-cameras.js';
import { matchPanel } from './studio-match.js';

const $ = id => document.getElementById(id);

// play: the scene the step shows; spot: a text the preview points at instead; groups: its texts
const STAGES = [
  { id: 'idle', label: 'Idle', icon: 'moon', note: 'Between matches', play: 'idle', groups: ['Event', 'Logo', 'Idle screen'] },
  { id: 'upnext', label: 'Up next', icon: 'users', note: 'Two players in the Autodarts lobby', spot: 'lobby_kicker', groups: ['Up next'], match: true },
  { id: 'bulloff', label: 'Bull-off', icon: 'target', note: 'Who throws first', play: 'bulloff', groups: ['Bull-off'] },
  { id: 'intro', label: 'Intro', icon: 'swords', note: 'The match starts', play: 'intro', groups: ['Player intro'] },
  { id: 'live', label: 'Live', icon: 'play', note: 'During the legs', play: 'live', groups: ['Scoreboard', 'Player card', 'Darts of the visit', 'Mini dartboard', 'Big moments'], live: true },
  { id: 'leg', label: 'Leg', icon: 'flag', note: 'After each leg', play: 'leg', groups: ['Cards'] },
  { id: 'match', label: 'Match end', icon: 'trophy', note: 'The winner', play: 'match', groups: ['Statistics'] }
];
const SETUP = [
  { id: 'look', label: 'Look', icon: 'palette', note: 'Colours of every screen' },
  { id: 'players', label: 'Players', icon: 'users', note: 'Shown when their Autodarts name matches' },
  { id: 'cameras', label: 'Cameras', icon: 'video', note: 'Board and player, as the screens show them', wide: true }
];
// Moments that interrupt the live scoreboard
const MOMENTS = [{ id: '180', label: '180', icon: 'flame' }, { id: 'bust', label: 'Bust', icon: 'x' }, { id: 'stinger', label: 'Transition', icon: 'shuffle' }];
const PLAY_THROUGH_MS = 4500;
const STATUS_MS = 2000;

let page = null;            // the built page; built on the first visit
let currentId = 'idle';     // the step shown, kept between visits
let scene = null;           // what "Show on TVs" plays: the step's scene or a moment
let statusTimer = null;
let playTimer = null;
let lastState = null;
let matchView = null;

const stepOf = id => STAGES.find(s => s.id === id) || SETUP.find(s => s.id === id);

function showStage(stage) {
  if (stage.play) play(stage.play);
  else if (stage.spot) focusText(stage.spot, stage.label);
}

// --- The TV button: the output's address and how to open it ----------------------------------------
function tvButton() {
  const btn = h('button', { type: 'button', class: 'stu-btn', 'data-pop': '', title: 'Output for the TV or OBS' }, icon('tv', 16), 'TV');
  btn.addEventListener('click', () => {
    const url = core.settings.output_url || `${location.origin}/studio/live`;
    const copy = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Copy', 'aria-label': 'Copy the address' }, icon('copy', 16));
    copy.addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast.success('Output address copied.'), () => toast.info(url)));
    popover(btn, h('div', { class: 'stu-tv' },
      h('span', { class: 'stu-h' }, 'Open this on the TV or in OBS'),
      h('div', { class: 'stu-tv-url' }, h('code', {}, url), copy),
      h('div', { class: 'stu-row' },
        h('a', { class: 'stu-btn', href: '/studio/live', target: '_blank', rel: 'noopener' }, icon('external', 14), 'Output'),
        h('a', { class: 'stu-btn', href: '/studio/live?demo=1', target: '_blank', rel: 'noopener', title: 'With a made-up match, for trying looks' }, icon('external', 14), 'Demo')),
      h('small', { class: 'stu-hint' }, '1920×1080. Double-click it for fullscreen; add ?chroma=green for a green background.')));
  });
  return btn;
}

// --- The page ------------------------------------------------------------------------------------
function build(host) {
  const panel = h('div', { class: 'stu-panel' });
  const sendScene = h('span', { class: 'stu-send-scene' });
  const sendBtn = h('button', { type: 'button', class: 'stu-btn stu-send', title: 'Plays on every open output right away, also during a game; the game takes over again after a few seconds' }, icon('tv', 16), 'Show on TVs', sendScene);
  const playBtn = h('button', { type: 'button', class: 'stu-btn stu-play', title: 'Walk through the whole show in the preview' }, icon('play', 16), 'Play through');
  const frame = h('iframe', { src: 'about:blank', title: 'Studio preview (demo match)', allow: 'camera; fullscreen', tabindex: '-1' });
  const dots = statusDots(state => { lastState = state; matchView?.update(state); });

  const groupEl = (items, cls, label) => {
    const el = h('div', { class: `stu-group ${cls}`, role: 'tablist', 'aria-label': label }, h('span', { class: 'stu-pill' }));
    if (cls === 'stu-show') el.append(h('span', { class: 'stu-progress' }));
    el.append(...items.map(it => {
      const b = h('button', { type: 'button', role: 'tab', class: 'stu-stage', 'data-id': it.id, title: it.note }, icon(it.icon, 22), h('span', {}, it.label));
      b.addEventListener('click', () => { stopPlayThrough(); select(it.id); });
      return b;
    }));
    return el;
  };
  const setupEl = groupEl(SETUP, 'stu-setup', 'Setup');
  const showEl = groupEl(STAGES, 'stu-show', 'The show');

  const placePills = () => {
    for (const g of [setupEl, showEl]) {
      const btn = g.querySelector('.stu-stage.is-on');
      g.classList.toggle('has-pill', !!btn);
      if (!btn) continue;
      const pill = g.querySelector('.stu-pill');
      pill.style.left = `${btn.offsetLeft}px`;
      pill.style.width = `${btn.offsetWidth}px`;
      // On a narrow screen the steps scroll sideways: keep the chosen one in view
      if (g.scrollWidth > g.clientWidth) g.scrollTo({ left: btn.offsetLeft - g.clientWidth / 2 + btn.offsetWidth / 2, behavior: 'smooth' });
    }
  };
  const resized = new ResizeObserver(placePills);
  resized.observe(setupEl);
  resized.observe(showEl);

  const setScene = (id, label) => {
    scene = id;
    sendBtn.hidden = !id;
    sendScene.textContent = label ? `· ${label}` : '';
  };

  // Moments under the live step: try one in the preview, then send it with "Show on TVs"
  const moments = () => h('div', { class: 'stu-row' }, MOMENTS.map(m => {
    const b = h('button', { type: 'button', class: 'stu-btn stu-chip' }, icon(m.icon, 14), m.label);
    b.addEventListener('click', () => {
      play(m.id);
      setScene(m.id, m.label);
      b.animate([{ transform: 'scale(.9)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
    });
    return b;
  }));

  const select = id => {
    const item = stepOf(id) || STAGES[0];
    const stage = STAGES.includes(item) ? item : null;
    currentId = item.id;
    for (const g of [setupEl, showEl]) {
      g.querySelectorAll('.stu-stage').forEach(b => {
        const on = b.dataset.id === item.id;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
      });
    }
    placePills();
    const idx = STAGES.indexOf(stage);
    showEl.querySelector('.stu-progress').style.transform = `scaleX(${idx < 0 ? 0 : (idx + 1) / STAGES.length})`;
    host.classList.toggle('is-wide', !!item.wide);
    setScene(stage?.play || null, null);
    stopCameras();
    matchView = null;

    const head = h('div', { class: 'stu-title' }, icon(item.icon, 24), h('div', {}, h('h2', {}, item.label), h('small', {}, item.note)));
    if (stage) {
      showStage(stage);
      if (stage.match) {
        matchView = matchPanel();
        if (lastState) matchView.update(lastState);
      }
      panel.replaceChildren(...[head,
        matchView,
        stage.live ? section('On screen', switchRow('Show overlay (off: only the cameras)', 'show_overlay')) : null,
        stage.live ? section('Cameras on screen', layoutPicker()) : null,
        stage.live ? section('Moments', moments()) : null,
        section('Texts', textsEditor(stage.groups, { onLeave: () => showStage(stage) }))].filter(Boolean));
    } else {
      play('idle');
      panel.replaceChildren(head, item.id === 'look' ? lookPicker() : item.id === 'players' ? playersPanel() : camerasPanel());
    }
  };

  const stopPlayThrough = () => {
    clearInterval(playTimer);
    playTimer = null;
    playBtn.classList.remove('is-on');
    playBtn.replaceChildren(icon('play', 16), 'Play through');
  };
  playBtn.addEventListener('click', () => {
    if (playTimer) { stopPlayThrough(); return; }
    let i = 0;
    select(STAGES[0].id);
    playBtn.classList.add('is-on');
    playBtn.replaceChildren(icon('x', 16), 'Stop');
    playTimer = setInterval(() => {
      i += 1;
      if (i >= STAGES.length) { stopPlayThrough(); return; }
      select(STAGES[i].id);
    }, PLAY_THROUGH_MS);
  });
  sendBtn.addEventListener('click', async () => {
    if (!scene) return;
    sendBtn.animate([{ transform: 'scale(.92)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
    if (await cue(scene)) toast.success('Playing on the screens.');
  });
  // The preview takes scenes once it has loaded
  frame.addEventListener('load', () => {
    if (frame.getAttribute('src') === 'about:blank') return;
    setTimeout(() => { const s = STAGES.find(x => x.id === currentId); if (s) showStage(s); }, 800);
  });

  host.replaceChildren(
    h('div', { class: 'stu-top' }, dots, h('span', { class: 'stu-spacer' }), saveMark(), tvButton()),
    h('div', { class: 'stu-rail' }, setupEl, showEl),
    h('div', { class: 'stu-body' },
      h('div', { class: 'stu-left' },
        h('div', { class: 'stu-screen' }, frame),
        h('div', { class: 'stu-controls' }, playBtn, h('span', { class: 'stu-spacer' }), sendBtn)),
      panel));
  return { select, frame, dots, stopPlayThrough };
}

async function renderStudio() {
  const host = $('studioPage');
  try {
    await loadSettings();
    page ||= build(host);
    page.frame.setAttribute('src', '/studio/live?demo=1');
    page.select(currentId);
    page.dots.refresh();
    clearInterval(statusTimer);
    statusTimer = setInterval(page.dots.refresh, STATUS_MS);
  } catch (err) {
    toast.error(`Could not load the Studio: ${err.message}`);
  }
}

// The preview and camera pictures keep cameras busy: free them when the page is left
function leaveStudio() {
  if (!page) return;
  page.stopPlayThrough();
  clearInterval(statusTimer);
  stopCameras();
  page.frame.setAttribute('src', 'about:blank');
  flush().finally(endDraft);
  document.querySelector('.stu-pop')?.remove();
}

export function initStudio() {
  window.renderStudio = renderStudio;
  window.leaveStudio = leaveStudio;
}
