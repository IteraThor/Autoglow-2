// AutoGlow Local Tournament dashboard: the highlights ticker along the bottom. 180s, the best averages,
// the latest results, upsets and deciding legs, what is up next and the event's own messages run past
// in one line. New highlights wait until the line has gone round once, so it never jumps.

import { esc } from './tournament-model.js';

// rem per second
const SPEED = { slow: 8, normal: 12, fast: 17 };
const fix1 = v => Number(v).toFixed(1);

// The highlights right now: [tag, html]; tag '' is an own message
export function tickerItems(M, cfg) {
  const on = { t180: true, averages: true, results: true, upsets: true, next: true, ...(cfg.ticker_items || {}) };
  const own = String(cfg.ticker_text || '').split('\n').map(s => s.trim()).filter(Boolean).map(s => ['', esc(s)]);
  if (!M || M.lobby) return own;
  const name = id => esc(M.players.get(id)?.name || id || '');
  const sideName = (m, i) => (m.sides[i].player ? name(m.sides[i].player) : '–');
  const st = M.stats;
  const out = [];
  if (on.t180 && st.t180) {
    const who = st.by180.slice(0, 4).map(r => `${name(r.id)} <b>${r.t180}</b>`).join('<i>·</i>');
    out.push(['180', `<b>${st.t180}</b> × 180 so far<i>·</i>${who}`]);
  }
  if (on.averages && st.best) {
    const b = st.best;
    out.push(['Best average', `${name(b.id)} <b>${fix1(b.value)}</b> against ${name(b.opp)} <small>${esc(b.m.id)}</small>`]);
    if (st.byAvg.length > 1) {
      const all = st.byAvg.reduce((a, r) => a + r.avgSum, 0) / st.byAvg.reduce((a, r) => a + r.avgN, 0);
      out.push(['Averages', `${st.byAvg.slice(0, 3).map((r, i) => `${i + 1}. ${name(r.id)} <b>${fix1(r.avg)}</b>`).join('<i>·</i>')}<i>·</i>Overall <b>${fix1(all)}</b>`]);
    }
  }
  if (on.upsets) {
    // A clearly lower seed beating a higher one, among the latest results (4 against 5 is no upset)
    for (const m of M.results.slice(0, 8)) {
      const r = m.result;
      if (r.walkover) continue;
      const w = M.players.get(m.sides[r.winner].player);
      const l = M.players.get(m.sides[1 - r.winner].player);
      if (w?.seed && l?.seed && w.seed - l.seed >= 2) out.push(['Upset', `${esc(w.name)} <small>seed ${w.seed}</small> beats ${esc(l.name)} <small>seed ${l.seed}</small> <b>${r.legs[r.winner]}–${r.legs[1 - r.winner]}</b>`]);
      if (out.filter(x => x[0] === 'Upset').length >= 2) break;
    }
    if (st.deciders) out.push(['Deciders', `<b>${st.deciders}</b> match${st.deciders > 1 ? 'es' : ''} went to the last ${M.sets ? 'set' : 'leg'}`]);
  }
  if (on.results) {
    for (const m of M.results.slice(0, 4)) {
      const r = m.result;
      const score = r.walkover ? 'w/o' : `${r.legs[0]}–${r.legs[1]}`;
      out.push(['Result', `<small>${esc(m.id)}</small> ${sideName(m, 0)} <b>${score}</b> ${sideName(m, 1)}`]);
    }
  }
  if (on.next && M.next.length) {
    out.push(['Up next', M.next.slice(0, 3).map(m => `<small>${esc(m.id)}</small> ${sideName(m, 0)} <i>vs</i> ${sideName(m, 1)}`).join('<i>·</i>')]);
  }
  // Own messages spread between the highlights
  if (!own.length) return out;
  const mixed = [];
  const every = Math.max(1, Math.ceil(out.length / own.length));
  let k = 0;
  out.forEach((x, i) => {
    if (i % every === 0 && k < own.length) mixed.push(own[k++]);
    mixed.push(x);
  });
  return [...mixed, ...own.slice(k)];
}

const itemHTML = ([tag, html]) => `<span class="tk-i${tag ? '' : ' own'}">${tag ? `<em>${esc(tag)}</em>` : '<i class="tk-star"></i>'}<span>${html}</span></span>`;

// The line: the items repeated until they fill the screen, twice, moving left by one copy and over again
export function makeTicker(el) {
  let shown = '';
  let waiting = null;
  let speed = SPEED.normal;
  const track = document.createElement('div');
  track.className = 'tk-run';
  el.replaceChildren(track);

  const lay = html => {
    shown = html;
    track.style.animation = 'none';
    track.innerHTML = `<div class="tk-u">${html}</div>`;
    const unit = track.firstChild;
    const one = unit.scrollWidth || 1;
    const reps = Math.max(1, Math.ceil(el.clientWidth / one));
    unit.innerHTML = html.repeat(reps);
    track.appendChild(unit.cloneNode(true));
    const rem = parseFloat(document.documentElement.style.fontSize) || 10;
    void track.offsetWidth;
    track.style.animation = '';
    track.style.animationDuration = `${(unit.scrollWidth / (speed * rem)).toFixed(2)}s`;
  };
  // A new set of highlights comes in when the line has gone round
  track.addEventListener('animationiteration', () => {
    if (waiting !== null) {
      const w = waiting;
      waiting = null;
      lay(w);
    }
  });

  return {
    update(items, cfg) {
      const sp = SPEED[cfg.ticker_speed] || SPEED.normal;
      const html = items.map(itemHTML).join('');
      el.hidden = !html;
      if (!html) {
        shown = '';
        waiting = null;
        return;
      }
      if (sp !== speed || !shown) {
        speed = sp;
        return lay(html);
      }
      if (html !== shown) waiting = html;
    },
    // After a resize or a new text size, lay it out again
    relayout() {
      if (shown) lay(waiting ?? shown);
      waiting = null;
    }
  };
}
