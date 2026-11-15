// AutoGlow Local Tournament dashboard: the HTML of every part of the screen. Boards with their scores,
// up next, and the scenes a panel rotates through (bracket, tables, results, leaders), each made to fit
// the space it gets: sizes are in rem, where the screen is 192 x 108 rem (see tournament.js).

import { esc, real, sourceText, rulesOf, FORMAT_NAME } from './tournament-model.js';

const hue = n => [...n].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const initials = n => (n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fix1 = v => Number(v).toFixed(1);

// A player's picture, or a monogram in a colour made from the name
export function av(p) {
  if (!p) return '<span class="av tbd"></span>';
  return p.img ? `<span class="av pic"><img src="${esc(p.img)}" alt="" decoding="async"></span>` : `<span class="av" style="--h:${hue(p.name)}">${esc(initials(p.name))}</span>`;
}

// A number the page animates (tournament-dom.js syncNums); pad: digits when shown as split-flap tiles
const num = (v, cls = '', pad = 0, pop = false) => `<span class="num ${cls}" data-num="${esc(v)}"${pad ? ` data-pad="${pad}"` : ''}${pop ? ' data-pop' : ''}></span>`;

function sideOf(M, m, i) {
  const s = m.sides[i];
  const p = s.player ? M.players.get(s.player) || { name: s.player } : null;
  return { p, text: p ? esc(p.name) : `<span class="src">${esc(sourceText(s))}</span>` };
}
const nick = p => (p?.nick ? `<small>${esc(p.nick)}</small>` : '');
const liveEntry = (M, m) => M.playing.find(e => e.m.id === m.id);

// --- Header ------------------------------------------------------------------------------------------------
export function header(M, cfg, clock) {
  const { done, total, live } = M.progress;
  const facts = [FORMAT_NAME[M.format] || '', `${[...M.players.values()].filter(p => !p.withdrawn).length} players`, ...rulesOf(M)].filter(Boolean);
  // A dot per match while they fit in one line, else a bar
  const pips = total <= 15
    ? `<div class="pips">${Array.from({ length: total }, (_, i) => `<i class="${i < done ? 'd' : i < done + live ? 'l' : ''}"></i>`).join('')}</div>`
    : `<div class="bar"><i style="transform:scaleX(${total ? done / total : 0})"></i></div>`;
  return `<div class="hd-logo">${cfg.logo ? `<img src="${esc(cfg.logo)}" alt="">` : '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3"><circle cx="16" cy="16" r="12"/><circle cx="16" cy="16" r="4.5" fill="currentColor" stroke="none"/></svg>'}</div>
    <div class="hd-t"><h1>${esc(cfg.title || M.T.name || 'Tournament')}</h1><div class="hd-s">${(cfg.subtitle ? [cfg.subtitle] : facts).map(f => `<span>${esc(f)}</span>`).join('')}</div></div>
    ${M.stage ? `<div class="hd-stage"><div><small>${M.finished ? 'Tournament' : 'Now playing'}</small><b>${esc(M.stage)}</b></div></div>` : ''}
    <div class="hd-prog"><div><b>${num(done)}</b><span>of ${total} matches</span></div>${pips}</div>
    ${cfg.clock ? `<div class="hd-clock">${num(clock, 'clk', 5)}</div>` : ''}`;
}

// --- Boards: the matches being played ------------------------------------------------------------------------
const scoreOf = (M, live, i) => (live ? (M.sets ? live.sets : live.legs)?.[i] ?? 0 : '');

// Two rows, like a TV scorebug
export function bug(M, e) {
  const { m, live } = e;
  const row = i => {
    const { p, text } = sideOf(M, m, i);
    return `<div class="pr${live && live.active === i ? ' act' : ''}"><i class="thr"></i>${av(p)}<div class="pn"><b>${text}</b>${nick(p)}</div>` +
      (live ? `${M.sets ? num(live.legs?.[i] ?? 0, 'sub') : ''}${num(scoreOf(M, live, i), 'lg', 1, true)}${num(live.remaining?.[i] ?? '', 'rm', 3)}` : '') + '</div>';
  };
  return `<div class="mc ${live ? 'live' : 'setup'}" data-k="mc-${m.id}" data-flip="mc-${m.id}" data-in>
    <div class="mh"><span class="bd"><small>Board</small>${e.board ? ` ${e.board}` : ''}</span><span class="ml">${esc(m.label)}</span>` +
    (live ? `<span class="cl l">${M.sets ? 'Sets' : 'Legs'}</span><span class="cl r">Left</span>` : '<span class="call">Players to the board</span>') + `</div>${row(0)}${row(1)}</div>`;
}

// One row, the two players facing each other
export function hrow(M, e) {
  const { m, live } = e;
  const act = i => (live && live.active === i ? ' act' : '');
  const pl = i => {
    const { p, text } = sideOf(M, m, i);
    return `<div class="pl${i ? ' r' : ''}${act(i)}">${av(p)}<div><b>${text}</b>${nick(p)}</div><i class="arr"></i></div>`;
  };
  const rem = i => num(live ? live.remaining?.[i] ?? '' : '', `rm${act(i)}`, 3);
  const sc = i => num(scoreOf(M, live, i), 'lg', 1, true);
  const sub = i => (M.sets && live ? num(live.legs?.[i] ?? 0, 'sub') : '');
  return `<div class="br ${live ? 'live' : 'setup'}" data-k="br-${m.id}" data-flip="br-${m.id}" data-in><div class="bno">${e.board || ''}</div>${pl(0)}${rem(0)}` +
    `<div class="lgs">${sub(0)}${sc(0)}<em>:</em>${sc(1)}${sub(1)}</div>${rem(1)}${pl(1)}<div class="stt"><b>${live ? '<i></i>Live' : 'Players to board'}</b><small>${esc(m.label)}</small></div></div>`;
}

export function boards(M, rows) {
  if (!M.playing.length) return `<div class="mnote" data-k="none">${M.finished ? 'All matches played' : 'No match on a board right now'}</div>`;
  return M.playing.map(e => (rows ? hrow(M, e) : bug(M, e))).join('');
}

export function upNext(M, max) {
  return M.next.slice(0, max).map(m => `<div class="nx" data-k="nx-${m.id}" data-flip="nx-${m.id}" data-in><span class="id">${esc(m.id)}</span>` +
    `<span class="who">${sideOf(M, m, 0).text}<i>vs</i>${sideOf(M, m, 1).text}</span><span class="lb">${m.held ? 'On hold' : esc(m.label)}</span></div>`).join('');
}

// --- Bracket -------------------------------------------------------------------------------------------------
// Any knockout as a tree: a match's children are the matches its players come from. Laid out by the
// tree, so byes, the losers bracket and group winners all line up. When the tree is too tall or too
// wide for the space, it is shown in pages: the early rounds in parts, then the late rounds.
const MIN_PITCH = 7.6;   // rem per match down the screen: two rows of at least 3.2rem and a gap
const MIN_COL = 19;      // rem per round across

function treeOf(M, stages) {
  const allowed = new Set(stages);
  // The reset of a grand final only shows once it is known to be played
  const shown = m => allowed.has(m.stage) && real(m) && !(m.stage === 'gf' && m.round === 2 && m.state === 'pending');
  const ms = M.matches.filter(shown);
  const kidsOf = m => [...new Set(m.sides.map(s => s.from || '').filter(f => /^[WL]:/.test(f)).map(f => M.byId.get(f.slice(2))))].filter(k => k && shown(k));
  const fed = new Set(ms.flatMap(m => kidsOf(m).map(k => k.id)));
  const root = ms.filter(m => !fed.has(m.id)).pop();
  const node = m => ({ m, kids: kidsOf(m).map(node) });
  return root ? node(root) : null;
}

function measure(n, cut, d = 0) {
  if (d >= cut || !n.kids.length) return { leaves: 1, depth: 0 };
  const parts = n.kids.map(k => measure(k, cut, d + 1));
  return { leaves: parts.reduce((a, p) => a + p.leaves, 0), depth: 1 + Math.max(...parts.map(p => p.depth)) };
}

function bracketPages(root, size) {
  const maxLeaves = Math.max(2, Math.floor((size.h - 3.2) / MIN_PITCH));
  const maxCols = Math.max(2, Math.floor(size.w / MIN_COL));
  const fits = (n, cut = Infinity) => {
    const s = measure(n, cut);
    return s.leaves <= maxLeaves && s.depth + 1 <= maxCols;
  };
  if (fits(root)) return [{ root, cut: Infinity, last: true }];
  const levels = [[root]];
  while (levels[levels.length - 1].some(n => n.kids.length)) levels.push(levels[levels.length - 1].flatMap(n => n.kids));
  let s = 1;
  while (s < levels.length - 1 && !levels[s].every(n => fits(n))) s += 1;
  let c = levels.length - 1;
  while (c > 1 && !fits(root, c)) c -= 1;
  const pages = levels[s].filter(n => n.kids.length).map(n => ({ root: n, cut: Infinity }));
  pages.push({ root, cut: c, last: true });
  return pages;
}

function place(root, cut) {
  const nodes = [];
  const links = [];
  let leaf = 0;
  const walk = (n, d) => {
    const kids = d < cut ? n.kids : [];
    const ys = kids.map(k => walk(k, d + 1));
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : leaf++;
    nodes.push({ m: n.m, d, y });
    kids.forEach((k, i) => links.push({ d, y, ky: ys[i], done: k.m.state === 'done' }));
    return y;
  };
  walk(root, 0);
  return { nodes, links, leaves: leaf, depth: Math.max(...nodes.map(n => n.d)) };
}

function matchBox(M, m, tags) {
  const done = m.state === 'done' && m.result;
  const e = m.state === 'live' ? liveEntry(M, m) : null;
  const row = i => {
    const s = m.sides[i];
    const { p, text } = sideOf(M, m, i);
    const cls = done ? (m.result.winner === i ? 'win' : 'lose') : e?.live?.active === i ? 'act' : '';
    const sc = done ? (m.result.walkover ? (i === m.result.winner ? 'W' : '–') : m.result.legs[i]) : e?.live ? scoreOf(M, e.live, i) : '';
    return `<div class="bp ${cls}" data-slot="${m.id}:${i}" data-p="${esc(s.player || '')}" data-from="${esc((s.from || '').slice(2))}">${av(p)}<span class="n">${text}</span>${num(sc, 'lg', 0, true)}</div>`;
  };
  const board = e?.board || M.playing.find(x => x.m.id === m.id)?.board;
  const tag = !tags ? '' : m.state === 'live' ? `<span class="bm-tag">${board ? `Board ${board} · ` : ''}Live</span>` : m.state === 'assigned' ? `<span class="bm-tag">Next${board ? ` · Board ${board}` : ''}</span>` : '';
  return `<div class="bm ${m.state}">${tag}${row(0)}${row(1)}</div>`;
}

const colTitle = ms => {
  const l = ms[0].label.replace(/^Winners /, '').replace(/^Losers round/, 'Round');
  return ms.length > 1 && /-final$/.test(l) ? `${l}s` : l;
};

// One page of a bracket. wide: both halves run towards the final in the middle.
function bracketHTML(M, page, size) {
  const { root, cut } = page;
  const split = size.w >= 150 && root.kids.length === 2 && cut > 0;
  let nodes;
  let links;
  let cols;
  let leaves;
  if (split) {
    const [a, b] = root.kids.map(k => place(k, cut - 1));
    const D = Math.max(a.depth, b.depth) + 1;
    cols = 2 * D + 1;
    leaves = Math.max(a.leaves, b.leaves);
    const half = (h, right) => ({
      nodes: h.nodes.map(n => ({ m: n.m, col: right ? D + 1 + n.d : D - 1 - n.d, y: (n.y + 0.5) / h.leaves })),
      links: h.links.map(l => ({ col: right ? D + 1 + l.d : D - 1 - l.d, y: (l.y + 0.5) / h.leaves, ky: (l.ky + 0.5) / h.leaves, right, done: l.done }))
    });
    const [l, r] = [half(a, false), half(b, true)];
    nodes = [...l.nodes, { m: root.m, col: D, y: 0.5, fin: true }, ...r.nodes];
    links = [...l.links, ...r.links,
      { col: D, y: 0.5, ky: (a.nodes[a.nodes.length - 1].y + 0.5) / a.leaves, done: root.kids[0].m.state === 'done' },
      { col: D, y: 0.5, ky: (b.nodes[b.nodes.length - 1].y + 0.5) / b.leaves, right: true, done: root.kids[1].m.state === 'done' }];
  } else {
    const p = place(root, cut);
    cols = p.depth + 1;
    leaves = p.leaves;
    nodes = p.nodes.map(n => ({ m: n.m, col: p.depth - n.d, y: (n.y + 0.5) / p.leaves }));
    links = p.links.map(l => ({ col: p.depth - l.d, y: (l.y + 0.5) / p.leaves, ky: (l.ky + 0.5) / p.leaves, done: l.done }));
  }
  const bodyH = size.h - 3.2;
  const pitch = bodyH / leaves;
  // A small bracket on a big screen keeps boxes of a sensible width, in the middle
  const W = Math.min(size.w, cols * 50);
  const cw = W / cols;
  const bh = clamp(Math.min((pitch - 2.8) / 2, cw * 0.16), 3.2, 6.4);
  const g = clamp(cw * 0.06, 0.8, 2);
  // The text fits the longest name in the box (a condensed capital is about half an em wide); longer
  // than 18 letters gets cut
  const longest = Math.min(18, Math.max(6, ...nodes.flatMap(n => n.m.sides.map(s => (M.players.get(s.player)?.name || sourceText(s) || '').length))));
  const nameW = cw - 2 * g - 1.94 * bh;
  const bf = clamp(Math.min(bh * 0.5, nameW / (longest * 0.52)), 1.8, 3.2);
  const tags = pitch - 2 * bh >= 2.6;
  // Lines: from a match's edge to the middle between two rounds, up or down, on to the next match
  const gx = (g / W) * 1000;
  const paths = links.map(l => {
    const edge = (l.right ? l.col + 1 : l.col) / cols * 1000;
    const dir = l.right ? 1 : -1;
    return `<path class="${l.done ? 'on' : ''}" vector-effect="non-scaling-stroke" d="M${(edge + dir * gx).toFixed(1)} ${(l.ky * 1000).toFixed(1)}H${edge.toFixed(1)}V${(l.y * 1000).toFixed(1)}H${(edge - dir * gx).toFixed(1)}"/>`;
  }).join('');
  const heads = Array.from({ length: cols }, (_, c) => nodes.filter(n => n.col === c).map(n => n.m)).map((ms, c) => (ms.length ? `<span style="left:${(c / cols) * 100}%;width:${100 / cols}%">${esc(colTitle(ms))}</span>` : '')).join('');
  const boxes = nodes.map(n => `<div class="bn${n.fin ? ' fin' : ''}" data-k="bn-${n.m.id}" style="left:${(n.col / cols) * 100}%;width:${100 / cols}%;top:calc(${(n.y * 100).toFixed(3)}% - ${bh}rem)">${matchBox(M, n.m, tags)}</div>`).join('');
  return `<div class="bk${split ? ' split' : ''}" style="width:${W.toFixed(2)}rem;margin:0 auto;--bh:${bh.toFixed(2)}rem;--g:${g.toFixed(2)}rem;--bf:${bf.toFixed(2)}rem"><div class="bk-h">${heads}</div>` +
    `<div class="bk-b"><svg class="bk-l" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${boxes}</div></div>`;
}

function bracketScenes(M, size) {
  const sets = M.format === 'double_ko' ? [['Winners', ['wb', 'gf']], ['Losers', ['lb']]] : M.format === 'groups' ? [['Knockout', ['ko']]] : [['Bracket', ['main']]];
  const out = [];
  for (const [name, stages] of sets) {
    const root = treeOf(M, stages);
    if (!root) continue;
    const pages = bracketPages(root, size);
    // A part that is played out is left out: the late rounds show who came through
    const open = pages.filter(p => p.last || !allDone(p.root));
    open.forEach((p, i) => out.push({ id: `bracket:${stages[0]}:${p.root.m.id}:${p.last ? 'x' : ''}`, kind: 'bracket', name, part: open.length > 1 ? `${i + 1}/${open.length}` : '', html: () => bracketHTML(M, p, size) }));
  }
  return out;
}
const allDone = n => n.m.state === 'done' && n.kids.every(allDone);

// --- Tables: groups, league, Swiss ---------------------------------------------------------------------------
function tableHTML(M, t, rows, from, rh, title, narrow) {
  const swiss = M.format === 'swiss';
  const adv = M.format === 'groups' ? M.T.advance || 0 : 0;
  const head = `<div class="tr th"><span></span><span></span>${narrow ? '' : '<span>P</span>'}<span>W</span><span>L</span><span>Legs</span>${narrow ? '' : `<span>${swiss ? 'Buch' : '180'}</span>`}<span>Avg</span></div>`;
  const body = rows.map((r, i) => {
    const rank = from + i;
    const cls = adv ? (rank < adv ? ' q' : '') + (rank === adv - 1 && t.rows.length > adv ? ' cut' : '') : rank === 0 && r.played ? ' q' : '';
    return `<div class="tr${cls}" data-k="tr-${esc(t.name)}-${esc(r.player)}" data-flip="tr-${esc(t.name)}-${esc(r.player)}"><span class="rk">${rank + 1}</span><span class="nm">${av(M.players.get(r.player))}<b>${esc(r.name)}</b></span>` +
      `${narrow ? '' : `<span>${r.played}</span>`}<span>${r.won}</span><span>${r.lost}</span><span>${r.legs_for}:${r.legs_against}</span>${narrow ? '' : `<span>${swiss ? r.buchholz : r.t180 || 0}</span>`}<span class="avg">${r.average ? fix1(r.average) : '–'}</span></div>`;
  }).join('');
  return `<div class="tb${narrow ? ' nar' : ''}" style="--rh:${rh.toFixed(2)}rem">${title ? `<h3>${title}</h3>` : ''}${head}${body}</div>`;
}

// A row height that also leaves the name room in a table this wide: the number columns take 12.2 (narrow)
// or 16.5 times the text size (--e, 0.52 of the row), the name with its picture at least 8
const widthRh = (rh, tw, narrow) => Math.min(rh, tw / ((narrow ? 12.2 : 16.5) + 1 + 8) / 0.52);

// "3/6" played in a group
function groupTally(M, name) {
  const ms = M.matches.filter(m => m.stage === 'group' && m.group === name && real(m));
  const done = ms.filter(m => m.state === 'done').length;
  return done === ms.length ? 'done' : `${done}/${ms.length}`;
}

function tableScenes(M, size) {
  const tables = M.T.tables || [];
  if (!tables.length) return [];
  const name = M.format === 'swiss' ? 'Standings' : M.format === 'league' ? 'Table' : 'Groups';
  const scene = (i, n, html) => ({ id: `tables:${i}`, kind: 'tables', name, part: n > 1 ? `${i + 1}/${n}` : '', html });
  const MIN_RH = 3.6;
  if (tables.length === 1) {
    const t = tables[0];
    const n = t.rows.length;
    const fitRows = Math.floor((size.h - 3.4) / MIN_RH);
    const cols = n > fitRows && size.w >= 110 ? 2 : 1;
    const perCol = Math.min(Math.ceil(n / cols), fitRows);
    const perPage = perCol * cols;
    const pages = Math.ceil(n / perPage);
    const narrow = size.w / cols < 62;
    const rh = widthRh(clamp((size.h - 3.4) / perCol, MIN_RH, 6.6), (size.w - (cols - 1) * 2.4) / cols, narrow);
    return Array.from({ length: pages }, (_, pg) => scene(pg, pages, () => {
      const parts = Array.from({ length: cols }, (_, c) => t.rows.slice(pg * perPage + c * perCol, pg * perPage + (c + 1) * perCol)).filter(r => r.length);
      return `<div class="tbs" style="grid-template-columns:repeat(${parts.length}, minmax(0, 1fr))">${parts.map((rows, c) => tableHTML(M, t, rows, pg * perPage + c * perCol, rh, '', narrow)).join('')}</div>`;
    }));
  }
  // Several groups: the number of columns that gives the biggest rows, on as few pages as possible
  const maxRows = Math.max(...tables.map(t => t.rows.length));
  const rhFor = r => ((size.h - (r - 1) * 2) / r - 7.4) / maxRows;
  let best = null;
  for (let c = 1; c <= Math.min(tables.length, 4); c += 1) {
    let gridRows = Math.ceil(tables.length / c);
    while (gridRows > 1 && rhFor(gridRows) < MIN_RH) gridRows -= 1;
    const narrow = size.w / c < 62;
    const rh = widthRh(clamp(rhFor(gridRows), 3, 6), (size.w - (c - 1) * 2.4) / c, narrow);
    const pages = Math.ceil(tables.length / (gridRows * c));
    if (!best || pages < best.pages || (pages === best.pages && rh > best.rh + 0.05)) best = { cols: c, perPage: gridRows * c, pages, rh, narrow };
  }
  const { cols, perPage, pages, rh, narrow } = best;
  return Array.from({ length: pages }, (_, pg) => scene(pg, pages, () => {
    const part = tables.slice(pg * perPage, (pg + 1) * perPage);
    return `<div class="tbs" style="grid-template-columns:repeat(${Math.min(cols, part.length)}, minmax(0, 1fr))">${part.map(t => tableHTML(M, t, t.rows, 0, rh, `Group ${esc(t.name)}<small>${groupTally(M, t.name)}</small>`, narrow)).join('')}</div>`;
  }));
}

// --- Results -------------------------------------------------------------------------------------------------
function resultRow(M, m) {
  const r = m.result;
  const p = i => {
    const { p: pl, text } = sideOf(M, m, i);
    const avg = +r.stats?.average?.[i] || 0;
    const t = +r.stats?.['180s']?.[i] || 0;
    const note = [avg ? `avg ${fix1(avg)}` : '', t ? `${t} × 180` : ''].filter(Boolean).join(' · ');
    return `<span class="rs-p${r.winner === i ? ' win' : ''}${i ? ' r' : ''}">${av(pl)}<span><b>${text}</b>${note ? `<small>${note}</small>` : ''}</span></span>`;
  };
  const score = r.walkover ? (r.winner === 0 ? 'W<i>–</i>L' : 'L<i>–</i>W') : `${r.legs[0]}<i>–</i>${r.legs[1]}`;
  return `<div class="rs-row" data-k="rs-${m.id}" data-flip="rs-${m.id}" data-in><div class="rs-k">${esc(m.id)} · ${esc(m.label)}${r.walkover ? ' · walkover' : ''}</div><div class="rs-r">${p(0)}<b class="rs-s">${score}</b>${p(1)}</div></div>`;
}

function resultScenes(M, size) {
  if (!M.results.length) return [];
  const u = clamp(size.w / 95, 0.7, 1);
  const cols = size.w >= 150 ? 2 : 1;
  const n = Math.max(1, Math.floor((size.h + 1.6 * u) / (13.2 * u))) * cols;
  return [{ id: 'results', kind: 'results', name: 'Results', part: '', html: () => `<div class="rs" style="--u:${u.toFixed(3)}rem;grid-template-columns:repeat(${cols}, minmax(0, 1fr))">${M.results.slice(0, n).map(m => resultRow(M, m)).join('')}</div>` }];
}

// --- Leaders: the best of the evening -------------------------------------------------------------------------
export function leaderTiles(M) {
  const st = M.stats;
  const tiles = [];
  if (st.best) tiles.push(['Best match average', fix1(st.best.value), M.players.get(st.best.id)]);
  if (st.by180[0]) tiles.push(['Most 180s', st.by180[0].t180, M.players.get(st.by180[0].id)]);
  const record = [...st.rows.values()].sort((a, b) => b.won - a.won || (b.legsFor - b.legsAgainst) - (a.legsFor - a.legsAgainst))[0];
  if (record?.won) tiles.push(['Most wins', record.won, M.players.get(record.id)]);
  return tiles;
}

function leaderScenes(M, size) {
  const st = M.stats;
  if (!st.byAvg.length && !st.by180.length) return [];
  const u = clamp(size.w / 95, 0.62, 1);
  return [{
    id: 'leaders', kind: 'leaders', name: 'Leaders', part: '', html: () => {
      const tiles = leaderTiles(M).slice(0, size.w >= 150 ? 3 : 2);
      const rows = Math.max(0, Math.floor((size.h - 21 * u - 4 * u) / (7 * u)));
      const list = st.byAvg.slice(0, rows);
      return `<div class="ld" style="--u:${u.toFixed(3)}rem"><div class="ld-tiles" style="grid-template-columns:repeat(${tiles.length}, minmax(0, 1fr))">` +
        tiles.map(([k, v, p]) => `<div class="ld-t" data-k="ld-${k}" data-in>${av(p)}<div><small>${k}</small><b>${num(v)}</b><span>${esc(p?.name || '')}</span></div></div>`).join('') + '</div>' +
        (list.length ? `<div class="ld-tb"><div class="ld-h"><span>Tournament average</span><span>Won</span><span>Legs</span><span>180</span><span>Avg</span></div>` +
          list.map((r, i) => `<div class="ld-r" data-k="ld-${r.id}" data-flip="ld-${r.id}" data-in><i>${i + 1}</i>${av(M.players.get(r.id))}<b>${esc(M.players.get(r.id)?.name || r.id)}</b><span>${r.won}/${r.played}</span><span>${r.legsFor}:${r.legsAgainst}</span><span>${r.t180}</span><em>${fix1(r.avg)}</em></div>`).join('') + '</div>' : '') + '</div>';
    }
  }];
}

// --- Boards as a scene of their own (when the screen shows one scene at a time) --------------------------------
function boardScenes(M) {
  if (!M.playing.length) return [];
  return [{ id: 'boards', kind: 'boards', name: 'Live', part: '', html: () => `<div class="bgrid" data-n="${Math.min(M.playing.length, 9)}">${boards(M, false)}</div>` }];
}

// The scenes this tournament has right now, in the order of cfg.scenes; each takes its seconds
export function scenes(M, size, cfg) {
  const make = { boards: () => boardScenes(M), bracket: () => bracketScenes(M, size), tables: () => tableScenes(M, size), results: () => resultScenes(M, size), leaders: () => leaderScenes(M, size) };
  let order = cfg.scenes.filter(s => make[s.id] && s.secs > 0);
  // Groups: the tables lead until the knockout has started
  const koOn = M.matches.some(m => m.stage === 'ko' && m.state !== 'pending');
  if (M.format === 'groups' && !koOn) order = [...order.filter(s => s.id === 'tables'), ...order.filter(s => s.id !== 'tables')];
  return order.flatMap(s => make[s.id]().map(sc => ({ ...sc, secs: s.secs })));
}

// --- Whole screens: nothing running, the lobby, the champion ----------------------------------------------------
export function idle() {
  return '<div class="ct"><div class="ct-k">AutoGlow</div><h1>No tournament running</h1><div class="ct-s">Start one from Autodarts › Local Tournament</div></div>';
}

export function lobby(M, cfg) {
  const n = M.entrants.length;
  const size = n <= 8 ? 'l' : n <= 18 ? 'm' : 's';
  const facts = [FORMAT_NAME[M.format] || '', ...rulesOf(M), n ? `${n} players` : ''].filter(Boolean);
  return `<div class="ct lobby">${cfg.logo ? `<img class="ct-logo" src="${esc(cfg.logo)}" alt="">` : ''}<div class="ct-k">Starting soon</div><h1>${esc(cfg.title || M.T.name || 'Tournament')}</h1>${cfg.subtitle ? `<div class="ct-sub">${esc(cfg.subtitle)}</div>` : ''}
    <div class="ct-f">${facts.map(f => `<span>${esc(f)}</span>`).join('')}</div>
    <div class="lb-p ${size}">${M.entrants.map(p => `<div class="lb-pl" data-k="lp-${esc(p.name)}" data-flip="lp-${esc(p.name)}" data-in>${av(p)}<b>${esc(p.name)}</b></div>`).join('')}</div>
    <div class="lb-b">${M.boards.map(b => `<span class="${b.online === false ? 'off' : ''}" data-k="lb-${b.number}" data-in><i></i>Board ${b.number}</span>`).join('')}<em>${M.boards.length ? `${M.boards.length} board${M.boards.length > 1 ? 's' : ''} ready` : 'Boards are joining'}</em></div></div>`;
}

export function champion(M) {
  const c = M.champion;
  if (!c) return '';
  const mine = M.results.filter(m => m.sides.some(s => s.player === c.id));
  const last = mine[0];
  const side = last ? last.sides.findIndex(s => s.player === c.id) : -1;
  const final = last && /final/i.test(last.label) && !last.result.walkover
    ? `<div class="ch-f">${esc(last.label)} <b>${last.result.legs[side]} – ${last.result.legs[1 - side]}</b> against ${sideOf(M, last, 1 - side).text}</div>` : '';
  const st = M.stats.rows.get(c.id);
  const facts = [];
  if (st?.avgN) facts.push([fix1(st.avgSum / st.avgN), 'Tournament average']);
  if (st) facts.push([`${st.won}/${st.played}`, 'Matches won'], [`${st.legsFor}:${st.legsAgainst}`, M.sets ? 'Sets' : 'Legs']);
  if (st?.t180) facts.push([st.t180, '180s']);
  const road = mine.slice(0, 6).reverse().map(m => {
    const i = m.sides.findIndex(s => s.player === c.id);
    return `<span>${esc(m.label)} <b>${m.result.walkover ? 'w/o' : `${m.result.legs[i]} – ${m.result.legs[1 - i]}`}</b> ${sideOf(M, m, 1 - i).text}</span>`;
  }).join('');
  return `<div class="ch"><div class="ch-pic" data-in>${av(c)}</div><div class="ch-txt"><div class="ch-k" data-in>Champion</div><h1 data-in>${esc(c.name)}</h1>${c.nick ? `<div class="ch-n" data-in>“${esc(c.nick)}”</div>` : ''}${final}
    <div class="ch-s">${facts.map(([v, k]) => `<div data-in><b>${v}</b><small>${k}</small></div>`).join('')}</div><div class="ch-road" data-in>${road}</div></div></div>`;
}
