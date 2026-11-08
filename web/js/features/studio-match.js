// AutoGlow 2 - Studio › Up next: the players picked in Autodarts (in the lobby, then in the match) and
// the Studio player each one is shown as. A wrong or unknown one is chosen here once and remembered.
// AutoGlow never starts matches itself: Autodarts allows that only for its own apps.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import * as core from './studio-core.js';
import { avatar, icon } from './studio-core.js';

const MATCH_LABEL = { name: 'same name', alias: 'Autodarts name', similar: 'similar name' };
const studioPlayer = id => core.settings.players.find(p => p.id === id);

async function remember(player, autodartsName) {
  try {
    const saved = await api('/api/studio/remember-name', { body: { player_id: player.id, autodarts_name: autodartsName } });
    core.settings.players = saved.players;
    toast.success(`${player.name} is now recognised as "${autodartsName}" in Autodarts.`);
  } catch (err) {
    toast.error(err.message);
  }
}

// The panel; update(state) fills it from /api/studio/state (the page reads it every few seconds)
export function matchPanel() {
  const rows = h('div', { class: 'stu-match-rows' });
  const lastData = h('span', { class: 'stu-last-data' });
  const root = h('div', { class: 'stu-card stu-match' },
    h('div', { class: 'stu-match-head' }, h('strong', {}, 'Players in Autodarts'),
      h('a', { class: 'stu-link', href: 'https://play.autodarts.com/', target: '_blank', rel: 'noopener', title: 'Open a lobby and add the players, in any order' }, icon('external', 14), 'Open a lobby')),
    rows,
    h('div', { class: 'stu-match-foot' }, lastData,
      h('a', { class: 'stu-link', href: '/api/studio/raw', download: 'autoglow-match-data.json', title: 'Match data exactly as received from Autodarts' }, icon('download', 14), 'Match data')));

  root.update = state => {
    const ago = state?.source?.updated_ago;
    lastData.textContent = typeof ago === 'number' ? `Last data ${Math.round(ago)} s ago` : 'Nothing received yet';
    lastData.classList.toggle('is-warn', typeof ago !== 'number');

    // Lobby players while one is open in Autodarts (the server sends it only while no match runs), else the match
    const lobby = state?.lobby?.players?.length ? state.lobby : null;
    const source = lobby || state;
    const players = source?.players || [];
    // Rebuilt only when the players or their mapping change, so an open dropdown is not reset by polling
    const key = JSON.stringify([lobby ? `lobby:${lobby.id}` : state?.match_id, players.map(p => [p.name, p.studio_id, p.match]), core.settings.players.length]);
    if (rows.dataset.key === key) return;
    rows.dataset.key = key;
    if (!players.length) {
      rows.replaceChildren(h('p', { class: 'stu-empty' }, 'No players picked yet. Open a lobby on play.autodarts.com and add two players: the screens show them face to face.'));
      return;
    }
    const status = lobby ? 'In the lobby' : state.live ? 'Running' : 'Last match';
    const format = [source.variant, source.base_score, source.target].filter(Boolean).join(' · ');
    rows.replaceChildren(...[
      h('div', { class: 'stu-match-status' }, [status, format].filter(Boolean).join(' · ')),
      ...players.map(p => {
        const shown = studioPlayer(p.studio_id);
        const select = h('select', { class: 'stu-select', 'aria-label': `Studio player for ${p.name}` },
          h('option', { value: '' }, '– not recognised –'),
          core.settings.players.map(sp => h('option', { value: sp.id, selected: sp.id === p.studio_id }, sp.name)));
        select.addEventListener('change', () => {
          const chosen = studioPlayer(select.value);
          if (chosen) remember(chosen, p.name);
        });
        return h('div', { class: 'stu-match-row' },
          h('code', { title: 'Name in Autodarts' }, p.name),
          icon('play', 10),
          shown ? avatar(shown, 'is-small') : h('span', { class: 'stu-avatar is-small is-unknown' }, '?'),
          select,
          h('span', { class: `studio-badge ${p.match ? 'ok' : 'bad'}`, title: 'How the Studio found this player' }, p.match ? MATCH_LABEL[p.match] || p.match : 'unknown'));
      }),
      lobby && players.length !== 2
        && h('p', { class: 'stu-hint is-warn' }, `${players.length} players picked: the screens show the players before the match only for two.`),
      players.some(p => !p.match)
        && h('p', { class: 'stu-hint' }, 'Choosing a player saves the Autodarts name with them, so the next match recognises them by name.')
    ].filter(Boolean));
  };
  return root;
}
