// AutoGlow Studio output - shared helpers: DOM building, number formats and Studio player lookup

export const ctx = {
  settings: null,   // /api/studio (players, cameras, overlay options)
  demo: false
};

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Editable wording (Studio › Broadcast › Texts): the changed text, else the default the server sends.
// A text switched off in the Studio is empty; callers leave out the line, row or banner it labels.
const hiddenText = key => (ctx.settings?.hidden_texts || []).includes(key);
export const t = key => (hiddenText(key) ? '' : ctx.settings?.texts?.[key] || ctx.settings?.text_defaults?.[key] || '');
// A text with a number after it ("Leg 3"), or nothing when the text is switched off
export const tn = (key, n) => (t(key) ? `${t(key)} ${n}` : '');
export const eventTitle = (fallback = 'AutoGlow Darts Studio') => (hiddenText('event_title') ? '' : ctx.settings?.title || fallback);
export const eventSubtitle = () => (hiddenText('event_subtitle') ? '' : ctx.settings?.subtitle || '');
export const fmt = v => (v === null || v === undefined ? '' : String(Math.round(v)));
export const fmtAvg = v => (typeof v === 'number' && v > 0 ? v.toFixed(2) : '–');
const norm = s => String(s || '').trim().toLowerCase();

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

// Studio player for a match player: the one AutoGlow mapped it to (studio_id: by name, Autodarts name
// or prepared throwing order), else by name or Autodarts name, case-insensitive. Also takes a plain name.
export function studioPlayer(player) {
  const players = ctx.settings?.players || [];
  if (player && typeof player === 'object') {
    const mapped = player.studio_id && players.find(p => p.id === player.studio_id);
    if (mapped) return mapped;
    player = player.name;
  }
  const key = norm(player);
  return players.find(p => norm(p.name) === key || (p.alias && norm(p.alias) === key)) || null;
}

export const displayName = player => studioPlayer(player)?.name || player.name;

// Picture uploaded in the Studio, else the player's Autodarts avatar
export function pictureUrl(player) {
  const sp = studioPlayer(player);
  if (sp?.image) return `/api/studio/images/${encodeURIComponent(sp.image)}`;
  return player.avatar_url || '';
}

// Photo shown by the "mockup" player camera for this player, if one was uploaded
export function mockupUrl(player) {
  const sp = player && studioPlayer(player);
  return sp?.mockup ? `/api/studio/images/${encodeURIComponent(sp.mockup)}` : '';
}

export function avatar(player, cls = 'avatar') {
  const src = pictureUrl(player);
  const fallback = () => el('span', `avatar ${cls}`, initials(displayName(player)));
  if (!src) return fallback();
  const img = el('img', cls);
  img.src = src;
  img.alt = '';
  img.onerror = () => img.replaceWith(fallback());
  return img;
}

// Everything the intro and player cards show about a player; Studio profile first, Autodarts second
export function profile(player) {
  const sp = studioPlayer(player) || {};
  const accountAvg = typeof player.account_average === 'number' ? player.account_average.toFixed(1) : '';
  return {
    name: displayName(player),
    nickname: sp.nickname || '',
    club: sp.club || '',
    hometown: sp.hometown || '',
    country: sp.country || player.country || '',
    hand: sp.hand || '',
    dartWeight: sp.dart_weight || '',
    favouriteDouble: sp.favourite_double || '',
    playingSince: sp.playing_since || '',
    average: sp.stat_average || accountAvg,
    oneEighties: sp.stat_180s || '',
    bestCheckout: sp.stat_best_checkout || ''
  };
}

// Studio players as scoreboard-like players (for the idle cards and demo data)
export function studioPlayersAsPlayers() {
  return (ctx.settings?.players || []).map((p, index) => ({ index, name: p.name, avatar_url: '', country: p.country }));
}
