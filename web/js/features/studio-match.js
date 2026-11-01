// AutoGlow 2 - Studio › Match: the players picked in Autodarts (in the lobby, then in the match) and
// the Studio player each one is shown as. A wrong or unknown one is chosen here once and remembered.
// AutoGlow never starts matches itself: Autodarts allows that only for its own apps.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';

const $ = id => document.getElementById(id);
const MATCH_LABEL = { name: 'same name', alias: 'Autodarts name', similar: 'similar name' };

let settings = null;

const studioPlayer = id => settings.players.find(p => p.id === id);

async function remember(player, autodartsNameValue) {
  try {
    const saved = await api('/api/studio/remember-name', { body: { player_id: player.id, autodarts_name: autodartsNameValue } });
    settings.players = saved.players;
    toast.success(`${player.name} is now recognised as "${autodartsNameValue}" in Autodarts.`);
  } catch (err) {
    toast.error(err.message);
  }
}

// Lobby players while one is open in Autodarts (the server sends it only while no match runs), else the match
export function renderLiveMatch(state) {
  const host = $('studioLiveMatch');
  if (!host || !settings) return;
  const lobby = state?.lobby?.players?.length ? state.lobby : null;
  const source = lobby || state;
  const players = source?.players || [];
  if (!players.length) {
    host.replaceChildren(h('div', { class: 'studio-empty' }, 'No players picked. Open a lobby on play.autodarts.com and add the players; they appear here.'));
    host.dataset.key = '';
    return;
  }
  // Rebuild only when the players or their mapping change, so an open dropdown is not reset by polling
  const key = JSON.stringify([lobby ? `lobby:${lobby.id}` : state.match_id, players.map(p => [p.name, p.studio_id, p.match]), settings.players.length]);
  if (host.dataset.key === key) return;
  host.dataset.key = key;

  const rows = players.map(p => {
    const select = h('select', { class: 'select-ide', 'aria-label': `Studio player for ${p.name}` },
      h('option', { value: '' }, '– not recognised –'),
      settings.players.map(sp => h('option', { value: sp.id, selected: sp.id === p.studio_id }, sp.name)));
    select.addEventListener('change', () => {
      const chosen = studioPlayer(select.value);
      if (chosen) remember(chosen, p.name);
    });
    return h('div', { class: 'studio-live-row' },
      h('code', { title: 'Name in Autodarts' }, p.name),
      h('span', { class: 'studio-live-arrow' }, '→'),
      select,
      h('span', { class: `studio-badge ${p.match ? 'ok' : 'bad'}` }, p.match ? MATCH_LABEL[p.match] || p.match : 'unknown')
    );
  });
  const status = lobby ? 'In the lobby' : state.live ? 'Running' : 'Last match';
  const format = [source.variant, source.base_score, source.target].filter(Boolean).join(' · ');
  host.replaceChildren(...[
    h('div', { class: 'studio-live-head' }, [status, format].filter(Boolean).join(' · ')),
    ...rows,
    lobby && players.length !== 2
      && h('p', { class: 'studio-note studio-warn' }, `${players.length} players picked: the screens show the players before the match only for two.`),
    players.some(p => !p.match)
      && h('p', { class: 'studio-note' }, 'Choosing a player saves the Autodarts name with them, so the next match recognises them by name.')
  ].filter(Boolean));
}

export function renderMatch(current) {
  settings = current;
}
