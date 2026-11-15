// AutoGlow Local Tournament dashboard: what the screens show, worked out from /api/tournament/local and
// the Studio players (pictures, nicknames). No page elements in here.

export const FORMAT_NAME = { single_ko: 'Single KO', double_ko: 'Double KO', groups: 'Groups → KO', league: 'League', swiss: 'Swiss' };
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const ordinal = n => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
const norm = s => String(s || '').trim().toLowerCase();

// A match that is really played: not skipped, not a bye
export const real = m => m.state !== 'skipped' && !m.sides.some(s => s.bye);

// Where a side's player comes from, while it isn't known
export function sourceText(side) {
  if (side.bye) return 'Bye';
  const f = side.from || '';
  if (f.startsWith('W:')) return `Winner ${f.slice(2)}`;
  if (f.startsWith('L:')) return `Loser ${f.slice(2)}`;
  if (f.startsWith('G:')) return `${ordinal(+f.split(':')[2])} Group ${f.split(':')[1]}`;
  return '–';
}

// Tournament players get picture and nickname from the Studio player they are (club member id, else the name)
function finder(roster) {
  const byId = new Map(roster.map(p => [p.id, p]));
  const byName = new Map();
  for (const p of roster) for (const n of [p.name, p.alias]) if (norm(n)) byName.set(norm(n), p);
  return p => byId.get(p.member) || byName.get(norm(p.name)) || byName.get(norm(p.ad_name)) || null;
}

function tally(results, sets) {
  const rows = new Map();
  const row = id => rows.get(id) || rows.set(id, { id, played: 0, won: 0, legsFor: 0, legsAgainst: 0, avgSum: 0, avgN: 0, t180: 0 }).get(id);
  const out = { best: null, legs: 0, t180: 0, deciders: 0 };
  for (const m of results) {
    const r = m.result;
    if (r.walkover) continue;
    if (!sets) out.legs += r.legs[0] + r.legs[1];
    if (Math.abs(r.legs[0] - r.legs[1]) === 1) out.deciders += 1;
    for (const i of [0, 1]) {
      const id = m.sides[i].player;
      if (!id) continue;
      const p = row(id);
      p.played += 1;
      if (r.winner === i) p.won += 1;
      p.legsFor += r.legs[i];
      p.legsAgainst += r.legs[1 - i];
      const avg = +r.stats?.average?.[i] || 0;
      if (avg > 0) {
        p.avgSum += avg;
        p.avgN += 1;
        if (!out.best || avg > out.best.value) out.best = { value: avg, id, opp: m.sides[1 - i].player, m };
      }
      const n180 = +r.stats?.['180s']?.[i] || 0;
      p.t180 += n180;
      out.t180 += n180;
    }
  }
  const list = [...rows.values()].map(p => ({ ...p, avg: p.avgN ? p.avgSum / p.avgN : 0 }));
  out.byAvg = list.filter(p => p.avg > 0).sort((a, b) => b.avg - a.avg);
  out.by180 = list.filter(p => p.t180 > 0).sort((a, b) => b.t180 - a.t180 || b.avg - a.avg);
  out.rows = rows;
  return out;
}

// The round being played, for the header: "Quarter-finals", "Group stage", "Round 3"
function stageLabel(T, ms, playing, next) {
  const cur = playing[0]?.m || next[0];
  if (!cur) return T.status === 'finished' ? 'Finished' : '';
  if (cur.stage === 'group' && T.format === 'groups') return 'Group stage';
  const many = ms.filter(m => m.stage === cur.stage && m.round === cur.round && real(m)).length > 1;
  return many && /-final$/.test(cur.label) ? `${cur.label}s` : cur.label;
}

export function derive(body, roster) {
  const T = body?.tournament;
  if (!T) return null;
  const find = finder(roster || []);
  const who = p => {
    const s = find(p);
    return { id: p.id || '', name: p.name || '', seed: p.seed || 0, withdrawn: !!p.withdrawn, nick: s?.nickname || '', img: s?.image ? `/api/studio/images/${encodeURIComponent(s.image)}` : '' };
  };
  const players = new Map((T.players || []).map(p => [p.id, who(p)]));
  const boards = (T.boards || []).filter(b => b.approved && !b.left).sort((a, b) => a.number - b.number);
  const sets = (T.settings?.sets || 0) > 0;
  const M = { T, players, boards, sets, lobby: T.status === 'lobby' || !(T.matches || []).length, finished: T.status === 'finished' };
  if (M.lobby) {
    M.entrants = (T.lobby?.players || T.players || []).map(who);
    M.settings = T.lobby?.settings || T.settings || {};
    M.format = T.lobby?.format || T.format;
    return M;
  }
  M.settings = T.settings || {};
  M.format = T.format;
  const ms = T.matches;
  const byId = new Map(ms.map(m => [m.id, m]));
  const boardOf = m => (T.boards || []).find(b => b.node_id === m.board);
  // The host knows every board's score; a joined board gets them as last_live
  const liveOf = m => {
    const b = boardOf(m);
    return b?.status?.match === m.id && b.status.live ? b.status.live : m.last_live || null;
  };
  M.matches = ms;
  M.byId = byId;
  M.playing = ms.filter(m => m.state === 'live' || m.state === 'assigned')
    .map(m => ({ m, board: boardOf(m)?.number || 0, live: m.state === 'live' ? liveOf(m) : null }))
    .sort((a, b) => a.board - b.board);
  M.next = (T.up_next || []).map(id => byId.get(id)).filter(Boolean);
  M.results = ms.filter(m => m.state === 'done' && m.result && real(m)).sort((a, b) => b.done_seq - a.done_seq);
  M.stats = tally(M.results, sets);
  const all = ms.filter(real);
  M.progress = { total: all.length, done: all.filter(m => m.state === 'done').length, live: all.filter(m => m.state === 'live').length };
  M.stage = stageLabel(T, ms, M.playing, M.next);
  M.champion = T.champion ? players.get(T.champion) || null : null;
  return M;
}

// "501 · Double out · First to 3"
export function rulesOf(M) {
  const s = M.settings || {};
  const out = [];
  if (s.base_score) out.push(`${s.base_score} ${norm(s.out_mode) || 'double'} out`);
  if (s.sets > 0) out.push(`First to ${s.sets} sets`);
  else if (s.legs) out.push(`First to ${s.legs}`);
  return out;
}
