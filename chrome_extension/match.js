// Local Tournament match screen: while this board plays a tournament match, Autodarts' match page
// gets a tournament look around its own controls (they stay as they are): the stage and the legs
// race above the player cards, seeds and each player's run so far on them, what's at stake and
// what's next below them, a walk-on intro when the match starts and a banner for the winner.
// Everything sits in one overlay that never takes a click, except the intro (a click skips it).
// tournament.js hands over AutoGlow's /api/tournament/local answer with window.autoglowMatch(data).
(() => {
  if (window.autoglowMatch) return;
  // `t` is the tournament here, so the translator is tr
  const { tn, srv } = window.agI18n;
  const tr = window.agI18n.t;
  const de = () => window.agI18n.lang() === 'de';
  /** "first to 3 legs" */
  const firstTo = (n, sets) => (sets ? tn(n, 'first to {n} set', 'first to {n} sets') : tn(n, 'first to {n} leg', 'first to {n} legs'));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const host = document.createElement('div');
  host.setAttribute('data-autoglow', 'match');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  :host{all:initial}
  *{box-sizing:border-box}
  .ov{position:fixed;inset:0;pointer-events:none;z-index:40;font:500 14px/1.4 Manrope,system-ui,sans-serif;color:#fafafa;
    --gold:#f7d458;--blue:#4a89ff;--live:#ff6b84;--glass:rgb(9 13 24 / .78);--line:rgb(255 255 255 / .12);--muted:#b5b5b5}
  .box{position:absolute;opacity:0;transition:opacity .35s}
  .box.on{opacity:1}
  .disp{font-family:"Bebas Neue",Manrope,sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.02em}
  .tag{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
    background:linear-gradient(90deg,#f7d45833,#f7d45811);color:var(--gold);border:1px solid #f7d45855}
  .hdr .name{font-size:13px;color:var(--muted);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hdr .stage{font-size:52px;line-height:.95;margin-top:2px;background:linear-gradient(180deg,#fff 40%,#c9d6ff);-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hdr .meta{color:var(--muted);font-size:13px;font-weight:600}
  .race{background:var(--glass);border:1px solid var(--line);border-radius:14px;padding:10px 16px;backdrop-filter:blur(6px)}
  .race .top{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
  .race .row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;margin-top:6px}
  .race .pn{font-size:24px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .race .pn.act{color:#fff}.race .pn:not(.act){color:#cfd3dc}
  .race .turn{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--gold);box-shadow:0 0 8px var(--gold);margin:0 8px 4px 0;vertical-align:middle}
  .race .sc{font-size:34px;line-height:1;min-width:26px;text-align:right}
  .pips{display:flex;gap:5px;margin-top:4px;grid-column:1 / -1}
  .pips i{flex:1;max-width:38px;height:6px;border-radius:3px;background:#ffffff1c}
  .pips i.w{background:linear-gradient(90deg,var(--gold),#ffb648);box-shadow:0 0 8px #f7d45866}
  .frame{border:2px solid #f7d45866;border-radius:16px;box-shadow:0 0 0 1px #00000055,0 0 26px #f7d45822 inset}
  .frame.act{border-color:var(--gold);box-shadow:0 0 0 1px #00000055,0 0 30px #f7d45855,0 0 26px #f7d45833 inset}
  .seed{position:absolute;top:-13px;left:18px;background:#0b0f19;border:1px solid #f7d45888;color:var(--gold);border-radius:999px;padding:2px 10px;font-size:11px;font-weight:800;letter-spacing:.1em}
  .card{background:var(--glass);border:1px solid var(--line);border-radius:14px;padding:12px 14px;backdrop-filter:blur(6px)}
  .card h4{margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .run{display:flex;flex-wrap:wrap;gap:6px}
  .run span{font-size:12px;font-weight:700;padding:3px 8px;border-radius:7px;background:#ffffff10;white-space:nowrap}
  .run span.w{background:#2fbf7122;color:#7ee2a8}.run span.l{background:#ff6b8422;color:#ff9fb0}
  .stat{display:flex;gap:16px;margin-top:8px;color:var(--muted);font-size:12px;font-weight:700}.stat b{color:#fff;font-size:14px}
  .stake{font-size:22px;line-height:1.1}.stake small{display:block;font:600 12px Manrope,sans-serif;color:var(--muted);text-transform:none;letter-spacing:0;margin-top:4px}
  .ln{display:flex;gap:8px;align-items:center;padding:5px 0;border-top:1px solid #ffffff12;font-size:13px}.ln:first-of-type{border-top:0}
  .ln .id{color:var(--muted);font-weight:800;min-width:28px}.ln .r{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}
  .ln.me{color:var(--gold)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--live);box-shadow:0 0 8px var(--live);display:inline-block}
  table{border-collapse:collapse;width:100%;font-size:13px}td{padding:3px 4px}td.n{text-align:right;color:var(--muted)}tr.me td{color:var(--gold);font-weight:800}
  /* Walk-on intro */
  .intro{position:fixed;inset:0;z-index:5;pointer-events:auto;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
    background:radial-gradient(ellipse at 50% 45%,#13306ff5,#01040bfa 70%);animation:fadeout .6s ease 3.4s forwards}
  .intro .t1{animation:rise .5s ease both}
  .intro .st{font-size:min(13vw,120px);line-height:.9;animation:zoom .6s cubic-bezier(.2,1.4,.4,1) .15s both;background:linear-gradient(180deg,#fff 35%,var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent}
  .intro .vs{display:flex;align-items:center;gap:min(4vw,48px);margin-top:10px}
  .intro .p{font-size:min(8vw,76px);line-height:1;text-align:center}
  .intro .p small{display:block;font:800 12px Manrope,sans-serif;letter-spacing:.14em;color:var(--gold);margin-top:6px}
  .intro .p.a{animation:inl .55s cubic-bezier(.2,1,.3,1) .55s both}.intro .p.b{animation:inr .55s cubic-bezier(.2,1,.3,1) .55s both}
  .intro .x{font-size:min(5vw,44px);color:#8a91a0;animation:rise .4s ease .9s both}
  .intro .ft{color:var(--muted);font-weight:700;letter-spacing:.06em;animation:rise .4s ease 1.1s both}
  .win{position:fixed;z-index:4;left:0;right:0;margin:0 auto;width:max-content;bottom:120px;pointer-events:auto;cursor:default;text-align:center;padding:18px 40px;border-radius:18px;
    background:linear-gradient(135deg,#1b1f29f2,#0b1630f2);border:1px solid #f7d45899;box-shadow:0 10px 50px #000a,0 0 40px #f7d45833;animation:zoom .5s cubic-bezier(.2,1.4,.4,1) both;max-width:92vw}
  .win .cl{position:absolute;top:4px;right:12px;cursor:pointer;color:#8a91a0;font-size:22px;line-height:1}.win .cl:hover{color:#fff}
  .win .nx{margin-top:10px;color:#cfd3dc;font-size:13px}
  .win .go{margin-top:12px;background:#0b55df;color:#fff;border:0;border-radius:10px;padding:10px 20px;font:800 14px Manrope,sans-serif;cursor:pointer}.win .go:hover{background:#2f6ff0}.win .go:disabled{opacity:.6;cursor:default}
  .win .w1{font-size:46px;line-height:1;color:var(--gold)}.win .w2{color:#e6e8ee;font-weight:700;margin-top:6px}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
  @keyframes zoom{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:none}}
  @keyframes inl{from{opacity:0;transform:translateX(-40vw)}to{opacity:1;transform:none}}
  @keyframes inr{from{opacity:0;transform:translateX(40vw)}to{opacity:1;transform:none}}
  @keyframes fadeout{to{opacity:0;visibility:hidden}}
  </style><div class="ov" id="ov"></div>`;
  const ov = root.getElementById('ov');

  let data = null;
  let ctx = null;       // { ad, mid, tid }: the tournament match on this Autodarts match page
  let introDone = '';
  let winShown = '';    // the match whose winner banner was closed
  const cards = {};     // player name -> the element of Autodarts' player card

  const T = () => data && data.tournament;
  const player = (id) => ((T() && T().players) || []).find(p => p.id === id) || null;
  const pname = (id) => (player(id) || {}).name || '';

  /** Autodarts' card of a player: the box around their name that is big enough to be a card */
  function cardFor(names) {
    const key = names.join('|');
    const old = cards[key];
    if (old && old.isConnected && old.checkVisibility()) return old;
    const want = names.map(n => n.trim().toUpperCase()).filter(Boolean);
    const leaf = [...document.body.querySelectorAll('span, div, p, h1, h2, h3')].find(e => e.childElementCount === 0
      && want.includes((e.textContent || '').trim().toUpperCase()) && !e.closest('[data-autoglow]') && e.checkVisibility());
    // The outermost box around the name that still holds one player only and isn't half the screen
    let el = leaf, card = null;
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.width >= window.innerWidth * (window.innerWidth < 1000 ? 0.98 : 0.45) || r.height >= window.innerHeight * 0.8 || (card && others(el, want))) break;
      if (r.width >= 200 && r.height >= 150) card = el;
      el = el.parentElement;
    }
    cards[key] = card;
    return card;
  }
  /** Another player's name inside: the box is wider than one card */
  const others = (el, want) => [...el.querySelectorAll('span, div, p')].some(e => e.childElementCount === 0 && /\S/.test(e.textContent)
    && !want.includes(e.textContent.trim().toUpperCase()) && ctx.a.players.some(p => [p.ad_name, p.name].some(n => n && n.trim().toUpperCase() === e.textContent.trim().toUpperCase())));

  function legsToWin(m, a) {
    return m && m.legs_to_win ? m.legs_to_win : (a.settings.sets || a.settings.legs || 1);
  }

  /** What the players see in each round, short: "QF" for Quarter-final (German: "VF" for Viertelfinale) */
  const short = (label) => {
    let l = String(label || ''), pre = '';
    const g = de();
    if (/^winners /i.test(l)) { pre = g ? 'G' : 'W'; l = l.slice(8); }
    if (/^grand final/i.test(l)) return g ? 'GF' : 'GF';
    if (/^final/i.test(l)) return `${pre}F`;
    if (/^semi/i.test(l)) return `${pre}${g ? 'HF' : 'SF'}`;
    if (/^quarter/i.test(l)) return `${pre}${g ? 'VF' : 'QF'}`;
    let m = /round of (\d+)/i.exec(l);
    if (m) return `${pre}R${m[1]}`;
    m = /^losers round (\d+)/i.exec(l);
    if (m) return `${g ? 'VR' : 'LR'}${m[1]}`;
    m = /round (\d+)$/i.exec(l);
    return m ? `R${m[1]}` : srv(l).slice(0, 10);
  };

  /** A player's matches so far, and their average and 180s in this tournament */
  function runOf(pid, except) {
    const t = T();
    const done = t.matches.filter(m => m.state === 'done' && m.id !== except && m.sides.some(s => s.player === pid)).sort((a, b) => (a.done_seq || 0) - (b.done_seq || 0));
    let sum = 0, n = 0, t180 = 0;
    const chips = done.map(m => {
      const i = m.sides[0].player === pid ? 0 : 1;
      const r = m.result || {};
      const won = r.winner === i;
      const avg = r.stats && r.stats.average && r.stats.average[i];
      if (typeof avg === 'number' && avg > 0) { sum += avg; n++; }
      t180 += (r.stats && r.stats['180s'] && r.stats['180s'][i]) || 0;
      const opp = pname(m.sides[1 - i].player) || tr('bye');
      const score = r.walkover ? tr('w/o') : `${r.legs[i]}–${r.legs[1 - i]}`;
      return `<span class="${won ? 'w' : 'l'}">${esc(short(m.label))} ${won ? '✓' : '✗'} ${esc(opp)} ${esc(score)}</span>`;
    });
    return { chips, avg: n ? sum / n : 0, t180, played: done.length, won: done.filter(m => m.result && m.sides[m.result.winner].player === pid).length };
  }

  /** What the winner (and the loser) go on to */
  function stakes(m) {
    const t = T();
    const next = (tag) => t.matches.find(x => x.sides.some(s => s.from === `${tag}:${m.id}`));
    const other = (x, tag) => {
      const s = x.sides.find(y => y.from !== `${tag}:${m.id}`);
      if (!s) return '';
      if (s.player) return pname(s.player);
      const f = s.from || '';
      return f.startsWith('W:') ? tr('the winner of {m}', { m: f.slice(2) }) : f.startsWith('L:') ? tr('the loser of {m}', { m: f.slice(2) }) : '';
    };
    const w = next('W'), l = next('L');
    if (m.stage === 'group' || m.stage === 'swiss') return null;
    if (!w) return { big: tr('For the title'), small: tr('The winner takes {name} 🏆', { name: esc(t.name) }) };
    const vs = other(w, 'W');
    return { big: tr('Winner → {round}', { round: esc(srv(w.label)) }), small: `${vs ? tr('against {name}', { name: esc(vs) }) : ''}${l ? `${vs ? ' · ' : ''}${tr('the loser goes on in the {round}', { round: esc(srv(l.label)) })}` : m.stage === 'lb' || m.stage === 'main' || m.stage === 'ko' ? `${vs ? ' · ' : ''}${tr('the loser is out')}` : ''}` };
  }

  /** Groups and league: the table with both players marked */
  function tableFor(m, a) {
    const t = T();
    const tb = (t.tables || []).find(x => x.name === m.group) || (m.stage === 'swiss' || t.format === 'league' ? (t.tables || [])[0] : null);
    if (!tb) return '';
    const mine = new Set(a.players.map(p => p.id));
    let rows = tb.rows.map((r, i) => ({ ...r, pos: i + 1 }));
    if (rows.length > 6) {
      const keep = new Set(rows.filter(r => mine.has(r.player) || r.pos <= 3).map(r => r.pos));
      rows = rows.filter(r => keep.has(r.pos));
    }
    return `<h4>${esc(tb.name.length === 1 ? tr('Group {name}', { name: tb.name }) : srv(tb.name))}</h4><table>${rows.map(r => `<tr class="${mine.has(r.player) ? 'me' : ''}"><td class="n">${r.pos}</td><td>${esc(r.name)}</td><td class="n">${r.won}–${r.lost}</td><td class="n">${r.legs_for - r.legs_against > 0 ? '+' : ''}${r.legs_for - r.legs_against}</td></tr>`).join('')}</table>`;
  }

  /** The next matches, and what the other boards play */
  function upNext(m) {
    const t = T();
    const byId = Object.fromEntries(t.matches.map(x => [x.id, x]));
    const board = (id) => { const b = (t.boards || []).find(x => x.node_id === id); return b ? tr('Board {n}', { n: b.number }) : ''; };
    const me = data.node && data.node.id;
    const line = (x, r) => `<div class="ln"><span class="id">${esc(x.id)}</span><span>${esc(pname(x.sides[0].player))} – ${esc(pname(x.sides[1].player))}</span><span class="r">${r}</span></div>`;
    const live = t.matches.filter(x => (x.state === 'live' || x.state === 'assigned') && x.id !== m.id && x.board !== me).sort((a, b) => (a.state === 'live' ? 0 : 1) - (b.state === 'live' ? 0 : 1)).slice(0, 3).map(x => {
      const b = (t.boards || []).find(y => y.node_id === x.board);
      const l = x.state === 'live' && b && b.status && b.status.match === x.id && b.status.live;
      return line(x, `${x.state === 'live' ? '<span class="dot"></span> ' : `${tr('setting up')} · `}${l && l.legs ? `${l.legs[0]}–${l.legs[1]} · ` : ''}${esc(board(x.board))}`);
    });
    // This board's next match (set once this one has its result), then the queue
    const here = t.matches.filter(x => x.state === 'assigned' && x.id !== m.id && x.board === me).map(x => line(x, tr('next on this board')));
    const next = here.concat((t.up_next || []).map(id => byId[id]).filter(x => x && x.id !== m.id).slice(0, 3 - here.length).map((x, i) => line(x, i === 0 && !here.length ? tr('next') : esc(short(x.label)))));
    if (!live.length && !next.length) return '';
    return `${live.length ? `<h4>${tr('Other boards')}</h4>${live.join('')}` : ''}${next.length ? `<h4 style="${live.length ? 'margin-top:10px' : ''}">${tr('Up next')}</h4>${next.join('')}` : ''}`;
  }

  const STAGE_EN = { wb: 'Winners bracket', lb: 'Losers bracket', gf: 'Grand final', group: 'Group stage', ko: 'Knockout', swiss: 'Swiss system', main: 'Knockout' };
  const STAGE = new Proxy(STAGE_EN, { get: (o, k) => (o[k] ? tr(o[k]) : undefined) });

  function place(el, x, y, w, on = true) {
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    if (w) el.style.width = `${Math.round(w)}px`;
    el.classList.toggle('on', on);
  }

  function box(id, cls) {
    let el = root.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = `box ${cls || ''}`;
      ov.appendChild(el);
    }
    return el;
  }
  const html = (el, h) => { if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; } };

  function clear() {
    if (host.isConnected) host.remove();
    ov.innerHTML = '';
  }

  /** The tournament match on this page, if this page is one: also after its result went to the host */
  function current() {
    const b = data && data.board;
    const a = b && b.assignment;
    const t = T();
    if (!t || !/^\/matches\//.test(location.pathname)) return null;
    const ad = location.pathname.split('/')[2];
    if (a && b.linked && b.linked === ad) ctx = { ad, mid: a.match, tid: t.id, a };
    if (!ctx || ctx.ad !== ad || ctx.tid !== t.id) return null;
    const m = t.matches.find(x => x.id === ctx.mid);
    if (!m) return null;
    const linked = !!(a && a.match === ctx.mid && b.linked === ad);
    return { m, a: ctx.a, live: linked ? b.live || {} : null };
  }

  function render() {
    const cur = current();
    if (!cur) { clear(); return; }
    const { m, a, live } = cur;
    if (!host.isConnected) document.documentElement.appendChild(host);
    const t = T();
    const sets = !!a.settings.sets;
    const need = legsToWin(m, a);
    const result = m.state === 'done' && m.result;
    const score = result ? result.legs : live && (sets ? live.sets : live.legs) || [0, 0];
    const active = live ? live.active : null;
    const names = a.players.map(p => [p.ad_name || p.name, p.name]);
    const els = [cardFor(names[0]), cardFor(names[1])];
    const rects = els.map(e => e && e.getBoundingClientRect());
    const wide = rects[0] && rects[1] && Math.abs(rects[0].top - rects[1].top) < 40 && window.innerWidth >= 1000;

    // Walk-on: once per match, when it starts
    const introKey = `${t.id}:${m.id}`;
    let seen = false;
    try { seen = sessionStorage.getItem('autoglow-intro') === introKey; } catch { /* private mode */ }
    // Decided once, when the page first sees the match: a fresh match (nothing scored yet) gets it
    const fresh = live && ![live.legs, live.sets].some(x => x && (x[0] || x[1])) && !(live.remaining || []).some(r => r != null && r !== a.settings.base_score);
    if (live && introDone !== introKey) introDone = introKey; else seen = true;
    if (!seen && fresh) {
      try { sessionStorage.setItem('autoglow-intro', introKey); } catch { /* private mode */ }
      const p = (i) => player(a.players[i].id) || {};
      const intro = document.createElement('div');
      intro.className = 'intro';
      intro.innerHTML = `<div class="tag t1">🏆 ${esc(t.name)}</div><div class="st disp">${esc(srv(m.label))}</div>
        <div class="vs"><div class="p a disp">${esc(a.players[0].name)}<small>${p(0).seed ? tr('SEED {n}', { n: p(0).seed }) : ''}</small></div><div class="x disp">vs</div><div class="p b disp">${esc(a.players[1].name)}<small>${p(1).seed ? tr('SEED {n}', { n: p(1).seed }) : ''}</small></div></div>
        <div class="ft">${STAGE[m.stage] && m.stage !== 'gf' ? `${esc(STAGE[m.stage])} · ` : ''}${cap(firstTo(need, sets))} · X01 ${a.settings.base_score}</div>`;
      intro.addEventListener('click', () => intro.remove());
      setTimeout(() => intro.remove(), 4200);
      ov.appendChild(intro);
    }

    // The match is won: a banner for the winner, until it is clicked away
    const won = result ? result.winner : live && score[0] >= need ? 0 : live && score[1] >= need ? 1 : -1;
    let win = root.getElementById('win');
    if (won >= 0 && winShown !== m.id) {
      const st = stakes(m);
      const nxt = t.matches.find(x => x.sides.some(s => s.from === `W:${m.id}`));
      const champ = !nxt && !!st;
      const sc = result && !result.walkover ? `${score[won]}–${score[1 - won]}` : '';
      const msg = champ ? `${tr('Wins {name}', { name: esc(t.name) })}${sc ? ` · ${tr('{score} in the {round}', { score: sc, round: esc(srv(m.label)) })}` : ''}` : nxt ? tr('Into the {round}', { round: esc(srv(nxt.label)) }) : tr('Wins {name}', { name: esc(srv(m.label)) });
      // Once the result is in: what this board plays next, one click to start it
      const na = result && data.board && data.board.assignment && data.board.assignment.match !== m.id ? data.board.assignment : null;
      const after = !result ? '' : na ? `<div class="nx">${tr('Next on this board')} · ${esc(na.match)} · <b>${esc(na.players[0].name)} vs ${esc(na.players[1].name)}</b></div><button class="go" data-go="start">▶ ${tr('Start next match')}</button>`
        : t.status === 'finished' ? `${!champ && t.champion ? `<div class="nx">🏆 ${tr('<b>{player}</b> wins {name}', { player: esc(pname(t.champion)), name: esc(t.name) })}</div>` : ''}<button class="go" data-go="page">${tr('Tournament page')}</button>`
        : `<div class="nx">${tr('This board gets its next match when one is ready')}</div>`;
      const h = `<span class="cl" data-go="close" title="${tr('Close')}">×</span><div class="w1 disp">🏆 ${esc(a.players[won].name)} ${champ ? `· ${tr('Champion')}` : sc}</div><div class="w2">${msg}</div>${after}`;
      if (!win) {
        win = document.createElement('div');
        win.id = 'win';
        win.className = 'win';
        win.addEventListener('click', (e) => {
          const go = (e.target.closest('[data-go]') || {}).dataset;
          if (!go) return;
          if (go.go === 'close') { winShown = win.dataset.m; win.remove(); }
          if (go.go === 'page') window.autoglowShowPage();
          if (go.go === 'start' && window.autoglowStartNext) { e.target.textContent = tr('Starting…'); e.target.disabled = true; window.autoglowStartNext(); }
        });
        ov.appendChild(win);
      }
      win.dataset.m = m.id;
      html(win, h);
    } else if (win && won < 0) win.remove();

    // Gold frames and seeds on Autodarts' cards
    for (const i of [0, 1]) {
      const f = box(`f${i}`, 'frame');
      const r = rects[i];
      if (!r) { f.classList.remove('on'); continue; }
      f.classList.toggle('act', active === i);
      f.style.height = `${Math.round(r.height)}px`;
      const p = player(a.players[i].id);
      html(f, p && p.seed ? `<span class="seed">${tr('SEED {n}', { n: p.seed })}</span>` : '');
      place(f, r.left, r.top, r.width);
    }

    const hdr = box('hdr', 'hdr');
    const race = box('race', 'race');
    const runs = [box('run0', 'card'), box('run1', 'card')];
    const stake = box('stake', 'card');
    const next = box('next', 'card');
    if (!wide) {
      // Narrow screens: Autodarts' cards fill the width; only the frames, seeds and the stage
      for (const el of [race, runs[0], runs[1], stake, next]) el.classList.remove('on');
      html(hdr, `<span class="tag">🏆 ${esc(srv(m.label))} · ${tr('first to {n}', { n: need })}</span>`);
      const r = rects[0];
      if (r) place(hdr, r.left + 110, r.top - 13, 0); else hdr.classList.remove('on');
      hdr.style.width = '';
      return;
    }
    const [L, R] = rects[0].left < rects[1].left ? [rects[0], rects[1]] : [rects[1], rects[0]];
    const leftSide = rects[0].left < rects[1].left ? 0 : 1;

    // Above the left card: tournament, stage, match
    const room = L.top - 90;
    html(hdr, `<span class="tag">🏆 ${tr('Local Tournament')}</span><div class="name">${esc(t.name)}${STAGE[m.stage] && m.stage !== 'gf' ? ` · ${esc(STAGE[m.stage])}` : ''}</div>
      <div class="stage disp">${esc(srv(m.label))}</div><div class="meta">${tr('Match {id}', { id: esc(m.id) })} · ${firstTo(need, sets)}</div>`);
    place(hdr, L.left, Math.max(84, L.top - 16 - (hdr.offsetHeight || 120)), L.width, room > 110);

    // Above the right card: the race to the winning leg
    const row = (i) => `<div class="row"><span class="pn disp ${active === i ? 'act' : ''}">${active === i ? '<i class="turn"></i>' : ''}${esc(a.players[i].name)}</span><span class="sc disp">${score[i] || 0}</span>
      <div class="pips">${Array.from({ length: Math.min(need, 13) }, (_, k) => `<i class="${k < (score[i] || 0) ? 'w' : ''}"></i>`).join('')}</div></div>`;
    html(race, `<div class="top"><span>${sets ? 'Sets' : 'Legs'}</span><span>${tr('first to {n}', { n: need })}</span></div>${row(leftSide)}${row(1 - leftSide)}`);
    place(race, R.left, Math.max(84, R.top - 16 - (race.offsetHeight || 110)), R.width, room > 100);

    // Below each card: the player's run in this tournament
    let below = 0;
    for (const i of [0, 1]) {
      const r = rects[i];
      const run = runOf(a.players[i].id, m.id);
      html(runs[i], `<h4>${tr('Tournament run')}</h4>${run.chips.length ? `<div class="run">${run.chips.join('')}</div>` : `<div class="muted" style="color:var(--muted);font-size:13px">${tr('First match in this tournament')}</div>`}
        ${run.played ? `<div class="stat"><span>${tr('Won')} <b>${run.won}/${run.played}</b></span>${run.avg ? `<span>${tr('Avg')} <b>${run.avg.toFixed(1)}</b></span>` : ''}${run.t180 ? `<span>${tr('180s')} <b>${run.t180}</b></span>` : ''}</div>` : ''}`);
      place(runs[i], r.left, r.bottom + 14, r.width);
      below = Math.max(below, r.bottom + 14 + (runs[i].offsetHeight || 80));
    }

    // Further down: what's at stake (or the table) on the left, what's next on the right
    const st = stakes(m);
    const tb = st ? '' : tableFor(m, a);
    html(stake, st ? `<h4>${tr('At stake')}</h4><div class="stake disp">${st.big}<small>${st.small}</small></div>` : tb);
    place(stake, L.left, below + 12, L.width, !!(st || tb) && below + 12 + (stake.offsetHeight || 90) < window.innerHeight - 8);
    const nx = upNext(m);
    html(next, nx);
    place(next, R.left, below + 12, R.width, !!nx && below + 12 + (next.offsetHeight || 90) < window.innerHeight - 8);
  }

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  window.autoglowMatch = (d) => { data = d; render(); };
  window.agI18n.onChange(() => { if (data) render(); });
  // Autodarts moves its cards around (window size, its own menus): follow them
  setInterval(() => { if (data && /^\/matches\//.test(location.pathname)) render(); else if (host.isConnected) clear(); }, 400);
})();
