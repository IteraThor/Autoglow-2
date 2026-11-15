// AutoGlow Bridge - club Players in play.autodarts.com. Adds a "Local Players" item under the Local
// Tournament item: one table of every member's stats, ranked by any column, and each member's
// profile, from the local AutoGlow (on a board PC those are the club host's); members are edited in AutoGlow. After each finished game a toast says
// whose stats it went to. In a lobby, a "Club members" menu adds members as guests.
(() => {
  const HASH = '#autoglow-players';
  const STATE_EVERY_MS = 5000;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 1) => (typeof v === 'number' && v > 0 ? v.toFixed(d) : '–');
  const when = s => (s ? new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  /** "Updated" only when it was: any other failure means the extension's background did not answer */
  const bridgeError = m => (/context invalidated/i.test(m || '') ? 'AutoGlow Bridge was updated. Reload this page.' : 'AutoGlow Bridge did not answer. Restart the browser, or reload the extension in chrome://extensions.');

  function api(path) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'club', path }, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(bridgeError(chrome.runtime.lastError.message)));
          if (r && r.ok) resolve(r.data); else reject(new Error(r ? r.error : 'AutoGlow is not reachable'));
        });
      } catch {
        reject(new Error('AutoGlow Bridge was updated. Reload this page.'));
      }
    });
  }

  const CSS = (window.__autoglowCSS || '') + `
  .av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#0b55df33;color:var(--blue2);font-weight:800;font-size:12px;flex:none}
  .av.big{width:64px;height:64px;font-size:24px}
  /* The players table: one row per member, sorted by the picked column */
  .tools{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.tools input{width:min(320px,100%)}
  .tw{padding:6px 8px;overflow-x:auto}
  .pt{min-width:760px}.pt th,.pt td{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .pt th:nth-child(-n+2),.pt td:nth-child(-n+2){text-align:left}
  .pt th button{all:unset;cursor:pointer;color:var(--muted);font-weight:700;font-size:12px}.pt th button:hover{color:#fff}
  .pt th.on button{color:#5eead4}.pt td.on{color:#5eead4;font-weight:800}
  .pt tbody tr{cursor:pointer}.pt tbody tr:hover td{background:#ffffff08}.pt tbody tr:focus-visible{outline:2px solid var(--blue2);outline-offset:-2px}
  .pt td{border-bottom:0;border-top:1px solid var(--line)}.pt tr.none td{color:#707580}
  .pt .rk{width:28px;color:var(--muted);font-weight:800;font-size:12px}.pt .rk.g1{color:var(--yellow)}.pt .rk.g2{color:#d3d7de}.pt .rk.g3{color:#d8a06a}
  .who{display:flex;align-items:center;gap:10px}.who b{font-weight:700;color:#fff}.who small{color:var(--muted);font-size:12px;margin-left:6px}
  /* A member's profile */
  .back{all:unset;cursor:pointer;color:#cacfd9;font-weight:700;margin-bottom:14px;display:inline-block}.back:hover{color:#fff}
  .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}
  .tile{background:var(--chipbg);border-radius:12px;padding:12px}.tile small{display:block;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
  .tile b{font-family:"Bebas Neue",sans-serif;font-weight:400;font-size:34px;line-height:1.1}.tile span{display:block;color:var(--muted);font-size:11px}
  .res{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;font-size:11px;font-weight:800;background:#ffffff14;color:#cacfd9}.res.w{background:#12cf8126;color:var(--green)}
  .form svg{width:100%;height:auto;display:block}.form .ln{fill:none;stroke:var(--blue2);stroke-width:2;stroke-linejoin:round}
  .form .dt{fill:var(--card);stroke:var(--blue2);stroke-width:2}.form .dt.w{fill:var(--blue2)}.form .gl{stroke:var(--line)}.form text{fill:var(--muted);font-size:11px}
  td a{color:inherit;cursor:pointer;text-decoration:underline;text-decoration-color:#ffffff40}td a:hover{color:#fff}
  `;

  // ---------------------------------------------------------------------------
  // Sidebar item, right under Local Tournament
  // ---------------------------------------------------------------------------
  const navHost = document.createElement('div');
  navHost.setAttribute('data-autoglow', 'players-nav');
  const navRoot = navHost.attachShadow({ mode: 'open' });
  navRoot.innerHTML = `<style>
    :host{display:block}:host(.top){display:flex}
    a{display:flex;align-items:center;gap:10px;text-decoration:none;cursor:pointer;color:inherit;font:inherit;border-radius:8px;white-space:nowrap}
    a:hover{background:#ffffff0d}a.on{background:#ffffff14;color:#fff}
    :host(.compact) span{display:none}
    :host(.top) a{position:relative;border-radius:0;background:none;gap:7px}:host(.top) a:hover,:host(.top) a.on{color:#fff!important}
    :host(.top) a.on::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:#fff}
    :host(.bottom) a{flex-direction:column;gap:4px;justify-content:center}:host(.bottom) svg{width:20px;height:20px}
    svg{width:18px;height:18px;flex:none}
    /* AutoGlow's teal, like Local Tournament */
    a{color:#2dd4bf!important}:host(.top) a:hover,:host(.top) a.on,a:hover,a.on{color:#5eead4!important}
    :host(.top) a.on::after{background:#2dd4bf!important}
  </style><a id="item" title="Local Players"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6"/></svg><span>Local Players</span></a>`;
  const navItem = navRoot.getElementById('item');
  navItem.addEventListener('click', (e) => { e.preventDefault(); openPage(); });

  function placeNav() {
    const t = document.querySelector('[data-autoglow="tournament-nav"]');
    if (!t || !t.parentElement) {
      if (navHost.isConnected) navHost.remove();
      return;
    }
    if (t.nextElementSibling !== navHost) t.after(navHost);
    navHost.className = t.className;
    const sample = t.shadowRoot && t.shadowRoot.getElementById('item');
    if (sample) navItem.style.cssText = sample.style.cssText;
  }

  // ---------------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------------
  const pageHost = document.createElement('div');
  pageHost.setAttribute('data-autoglow', 'players-page');
  const root = pageHost.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><div class="pg" id="pg"></div><div id="toast"></div>`;
  const pg = root.getElementById('pg');

  let view = { member: null, period: 'season', sort: 'average', flip: false, q: '' };
  let state = null;
  let seq = 0;

  const isOpen = () => location.hash === HASH;
  function openPage() {
    if (!isOpen()) history.pushState(null, '', location.pathname + location.search + HASH);
    sync();
  }

  const placePage = () => window.__autoglowMount.mountPage(pageHost, pg);

  /** While our page is open, Autodarts' own active entry and its underline must not look active too */
  function dimNative() {
    const box = navHost.parentElement;
    if (!box) return;
    const open = isOpen();
    for (const a of box.querySelectorAll('a[aria-current]')) a.style.color = open ? 'var(--color-black-20, #cacfd9)' : '';
    for (const d of box.querySelectorAll(':scope > div[aria-hidden="true"]')) d.style.opacity = open ? '0' : '';
  }

  function sync() {
    const open = isOpen();
    navItem.classList.toggle('on', open);
    dimNative();
    if (open && !pageHost.isConnected) { data = null; placePage(); render(); }
    if (!open && pageHost.isConnected) window.__autoglowMount.unmountPage(pageHost);
    if (open) placePage();
  }

  const subtabs = (items, cur, act) => `<div class="subtabs">${items.map(([k, n]) => `<button data-act="${act}" data-v="${k}" class="${k === cur ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  const PERIODS = [['season', 'This year'], ['month', 'This month'], ['all', 'All time']];

  // Table columns: [key, header, format, kind]. 'rate' ranks after min_games games, 'count' and
  // 'low' (fewest darts first) rank anyone who has one.
  const COLS = [['average', 'Average', v => v.toFixed(2), 'rate'], ['first9', 'First 9', v => v.toFixed(2), 'rate'], ['checkout_pct', 'Checkout', v => `${v.toFixed(1)}%`, 'rate'],
    ['t180', '180s', String, 'count'], ['best_checkout', 'Best checkout', String, 'count'], ['best_leg', 'Best leg', v => `${v} darts`, 'low'],
    ['games', 'Games', String, 'count'], ['win_pct', 'Win %', v => `${Math.round(v)}%`, 'rate']];
  let data = null; // { period, members, lb }

  async function render() {
    const mine = ++seq;
    const club = state && state.role === 'board' ? `the club host ${esc(state.club_name || state.address)}` : esc((state && state.node_name) || 'this PC');
    const head = `<div class="ph"><div><h1>Local Players</h1><div class="sub">Stats from every local game, kept by ${club}. Members are edited in AutoGlow.</div></div>
      <div class="r">${subtabs(PERIODS, view.period, 'period')}</div></div>`;
    if (!view.member && data && data.period === view.period) { pg.innerHTML = head + tablePage(); return; }
    if (!pg.innerHTML) pg.innerHTML = head + '<div class="card muted">Loading…</div>';
    let body;
    try {
      if (view.member) body = await memberPage(view.member);
      else {
        const [m, lb] = await Promise.all([api('members'), api(`leaderboards?period=${view.period}`)]);
        data = { period: view.period, members: m.players || [], lb };
        body = tablePage();
      }
    } catch (e) {
      body = `<div class="err">${esc(e.message)}</div>`;
    }
    if (mine === seq) pg.innerHTML = head + body;
  }

  function tablePage() {
    const { members, lb } = data;
    if (!members.length) return '<div class="card">No members yet. Add them in AutoGlow under <b>Players</b>.</div>';
    if (!lb.rows) return '<div class="err">The club host runs an older AutoGlow. Update it to see the players table.</div>';
    const by = Object.fromEntries(lb.rows.map(r => [r.member, r]));
    const rows = members.map(p => ({ ...(by[p.id] || { games: 0 }), id: p.id, name: p.name, nickname: p.nickname || '' }));
    const col = COLS.find(c => c[0] === view.sort);
    const ranked = r => col && (col[3] === 'rate' ? r.games >= lb.min_games : r[col[0]] > 0);
    const byName = (a, b) => a.name.localeCompare(b.name);
    rows.sort((a, b) => {
      if (!col) return byName(a, b) * (view.flip ? -1 : 1);
      if (ranked(a) !== ranked(b)) return ranked(a) ? -1 : 1;
      if (!ranked(a)) return b.games - a.games || byName(a, b);
      const d = col[3] === 'low' ? a[col[0]] - b[col[0]] : b[col[0]] - a[col[0]];
      return (view.flip ? -d : d) || byName(a, b);
    });
    const q = view.q.trim().toLowerCase();
    const th = (k, n, tip) => `<th class="${view.sort === k ? 'on' : ''}"${tip ? ` title="${tip}"` : ''}><button data-act="sort" data-v="${k}">${n}${view.sort === k ? (view.flip ? ' ▴' : ' ▾') : ''}</button></th>`;
    let rank = 0;
    return `<div class="tools"><input id="q" type="search" placeholder="Search members" value="${esc(view.q)}"><span class="muted small">${members.length} member${members.length === 1 ? '' : 's'} · click a column to rank by it</span></div>
      <div class="card tw"><table class="pt"><thead><tr><th></th>${th('name', 'Player')}${COLS.map(([k, n, , kind]) => th(k, n, kind === 'rate' ? `Ranked after ${lb.min_games} games` : kind === 'low' ? 'Fewest darts in a leg' : '')).join('')}</tr></thead><tbody>
      ${rows.map((r) => {
        const n = ranked(r) ? ++rank : 0;
        const hide = q && ![r.name, r.nickname].some(v => v.toLowerCase().includes(q));
        return `<tr data-act="member" data-v="${esc(r.id)}" data-q="${esc(`${r.name} ${r.nickname}`.toLowerCase())}" tabindex="0" class="${r.games ? '' : 'none'}"${hide ? ' hidden' : ''}>
          <td class="rk${n && n < 4 ? ` g${n}` : ''}">${n || ''}</td><td><span class="who"><span class="av">${esc(initials(r.name))}</span><b>${esc(r.name)}</b>${r.nickname ? `<small>“${esc(r.nickname)}”</small>` : ''}</span></td>
          ${COLS.map(([k, , f]) => `<td class="${view.sort === k ? 'on' : ''}">${k === 'games' ? r.games : r.games && r[k] > 0 ? esc(f(r[k])) : r.games && k === 't180' ? '0' : '–'}</td>`).join('')}</tr>`;
      }).join('')}</tbody></table></div>
      <div class="note">Every finished local game counts for the members in it, on any board of the club. Games against a bot don’t count. Average, First 9, Checkout and Win % rank members once they have ${lb.min_games} games.</div>`;
  }

  function formChart(form) {
    if (form.length < 2) return '<div class="muted small">The form line starts after the second game.</div>';
    const W = 520, H = 140, L = 30, R = 8, T = 10, B = 18;
    const vals = form.map(f => f.average);
    const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 10) * 10), hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
    const x = i => L + (i * (W - L - R)) / (form.length - 1), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
    return `<div class="form"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average of the last ${form.length} games">
      ${[lo, (lo + hi) / 2, hi].map(t => `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 5}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
      <polyline class="ln" points="${form.map((f, i) => `${x(i)},${y(f.average)}`).join(' ')}"/>
      ${form.map((f, i) => `<circle class="dt${f.won ? ' w' : ''}" cx="${x(i)}" cy="${y(f.average)}" r="4.5"><title>${f.average.toFixed(2)} · ${f.won ? 'won' : 'lost'} · ${when(f.at)}</title></circle>`).join('')}</svg></div>`;
  }

  async function memberPage(id) {
    const r = await api(`member?id=${encodeURIComponent(id)}&period=${view.period}`);
    const p = r.player, s = r.stats, t = s.totals;
    const tile = (k, v, h) => `<div class="tile"><small>${k}</small><b>${esc(v)}</b>${h ? `<span>${esc(h)}</span>` : ''}</div>`;
    // Opponents who are members link to their own profile
    const opp = o => (o.key.startsWith('name:') ? esc(o.name) : `<a data-act="member" data-v="${esc(o.key)}">${esc(o.name)}</a>`);
    return `<button class="back" data-act="back">← All players</button>
      <div class="card" style="margin-bottom:16px"><div class="row" style="gap:16px;margin-bottom:18px"><span class="av big">${esc(initials(p.name))}</span><div><h2 style="margin:0">${esc(p.name)}</h2>${p.nickname ? `<div class="muted">“${esc(p.nickname)}”</div>` : ''}</div></div>
        <div class="tiles">${tile('Average', fmt(t.average, 2))}${tile('First 9', fmt(t.first9, 2))}${tile('Checkout', t.checkout_pct ? `${fmt(t.checkout_pct)}%` : '–')}
        ${tile('180s', t.t180 || 0)}${tile('140+', t.t140 || 0)}${tile('Best checkout', t.best_checkout || '–')}${tile('Best leg', t.best_leg ? `${t.best_leg} darts` : '–')}${tile('Games', t.games || 0, t.games ? `${t.wins} won · ${Math.round(t.win_pct)}%` : '')}</div></div>
      <div class="grid2"><div class="card"><h3>Form</h3>${formChart(s.form)}</div>
        <div class="card"><h3>Head-to-head</h3>${s.head_to_head.length ? `<table><tr><th>Opponent</th><th>Games</th><th>Won</th></tr>${s.head_to_head.slice(0, 10).map(o => `<tr><td>${opp(o)}</td><td>${o.games}</td><td>${o.wins}</td></tr>`).join('')}</table>` : '<div class="muted small">Nobody played yet.</div>'}</div></div>
      <div class="card" style="margin-top:24px"><h3>Recent games</h3>${s.recent.length ? `<table><tr><th>Date</th><th>Opponent</th><th>Result</th><th>Average</th><th>Board</th></tr>${s.recent.map(g => `<tr${g.counts ? '' : ' style="color:#707580"'}><td>${when(g.at)}</td><td>${esc(g.opponents.join(', ') || 'Solo')}</td><td><span class="res${g.won ? ' w' : ''}">${g.won ? 'W' : 'L'}</span> ${g.score[0]}–${g.score[1]}</td><td>${fmt(g.average, 2)}</td><td>${esc(g.board)}</td></tr>`).join('')}</table>` : '<div class="muted small">No games in this period.</div>'}</div>`;
  }

  function act(el) {
    const v = el.dataset.v;
    if (el.dataset.act === 'period') view.period = v;
    if (el.dataset.act === 'sort') { view.flip = view.sort === v && !view.flip; view.sort = v; }
    if (el.dataset.act === 'member') view.member = v;
    if (el.dataset.act === 'back') view.member = null;
    render();
  }
  root.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el) act(el); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-act]')) act(e.target); });
  // Search hides rows in place, so the box keeps focus while typing
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    view.q = e.target.value;
    const q = view.q.trim().toLowerCase();
    for (const tr of root.querySelectorAll('tr[data-q]')) tr.hidden = !!q && !tr.dataset.q.includes(q);
  });

  // ---------------------------------------------------------------------------
  // "Saved to Anna's stats" after each game, on every Autodarts page
  // ---------------------------------------------------------------------------
  const noticeHost = document.createElement('div');
  noticeHost.setAttribute('data-autoglow', 'players-notice');
  const noticeRoot = noticeHost.attachShadow({ mode: 'open' });
  noticeRoot.innerHTML = `<style>${CSS} .toast{bottom:96px}</style><div id="t"></div>`;
  let lastSaved = null;

  async function poll() {
    try { state = await api('state'); } catch { return; }
    const s = state.last_saved;
    const id = s && s.id;
    if (lastSaved !== null && id && id !== lastSaved && Date.now() / 1000 - s.at < 120) {
      if (!noticeHost.isConnected && document.body) document.documentElement.appendChild(noticeHost);
      const el = noticeRoot.getElementById('t');
      el.innerHTML = `<div class="toast">🎯 ${esc(s.text)}</div>`;
      setTimeout(() => { el.innerHTML = ''; }, 6000);
      data = null;
      if (isOpen()) render();
    }
    lastSaved = id || '';
  }

  // ---------------------------------------------------------------------------
  // Lobby: a "Club members" menu next to Shuffle. Autodarts forgets guests after a while; picking a
  // member here adds them through Autodarts' own "Add player" dialog (the user chose this on
  // 2026-11-13, knowing Autodarts' terms are against software operating the site).
  // ---------------------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lobbyHost = document.createElement('div');
  lobbyHost.setAttribute('data-autoglow', 'lobby-members');
  const lobbyRoot = lobbyHost.attachShadow({ mode: 'open' });
  lobbyRoot.innerHTML = `<style>${CSS}
    .lm-pop{position:fixed;z-index:41;width:340px;max-height:min(520px,70vh);display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 60px #000c;color:var(--text);font:500 14px/1.4 "Manrope Variable",Manrope,system-ui,sans-serif}
    .lm-head{padding:12px 14px 8px;display:flex;flex-direction:column;gap:8px}.lm-head b{font-size:15px}
    .lm-head input{width:100%;height:34px}
    .lm-list{overflow:auto;padding:0 6px 8px}
    .lm-row{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
    .lm-row:hover:not(:disabled){background:#ffffff0d}.lm-row:disabled{cursor:default;opacity:.55}
    .lm-row .nm{flex:1;min-width:0}.lm-row .nm b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lm-row .nm small{color:var(--muted);font-size:12px}
    .lm-row .st{font-size:12px;font-weight:700;color:var(--muted)}.lm-row .st.add{color:var(--blue2)}.lm-row .st.ok{color:var(--green)}
    .lm-foot{padding:8px 14px 12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
  </style><div class="lm-pop" id="lmPop" hidden></div>`;
  // The button itself is one of Autodarts' own: it sits in the Players card header next to
  // Shuffle and wears Shuffle's classes, so it looks and behaves like its neighbours
  const lmBtn = document.createElement('button');
  lmBtn.type = 'button';
  lmBtn.setAttribute('data-autoglow', 'club-members');
  lmBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>Club members';
  const lmPop = lobbyRoot.getElementById('lmPop');
  let lm = { members: [], lobby: [], query: '', busy: '', done: new Set(), autoShown: '' };

  const textIs = (el, re) => re.test((el.textContent || '').trim());
  const mainButtons = () => [...document.querySelectorAll('main button')].filter(b => b.checkVisibility && b.checkVisibility());
  const addPlayerButton = () => mainButtons().find(b => textIs(b, /^(spieler hinzufügen|add player)$/i));
  const adName = m => (m.alias || m.name).trim();
  const inLobby = m => lm.lobby.some(n => n.trim().toUpperCase() === adName(m).toUpperCase()) || lm.done.has(m.id);

  async function waitFor(fn, ms = 3000, step = 100) {
    for (let t = 0; t < ms; t += step) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return fn() || null;
  }

  /** Autodarts' inputs are React-controlled: set the value the way typing does */
  function typeInto(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Add one guest through Autodarts' own "Add player" dialog */
  async function addToLobby(name) {
    const open = addPlayerButton();
    if (!open) throw new Error('Open a local game lobby first');
    open.click();
    const dlg = await waitFor(() => { const d = document.querySelector('[role="dialog"]'); return d && d.querySelector('input') ? d : null; });
    if (!dlg) throw new Error('The Add player dialog did not open');
    typeInto(dlg.querySelector('input'), name);
    const same = (el) => [...el.querySelectorAll('span')].some(s => s.textContent.trim().toUpperCase() === name.toUpperCase());
    // The guest Autodarts still knows (its own row, shown once its search answers), else the button that creates the guest
    const known = () => [...dlg.querySelectorAll('button:not([disabled])')].find(b => b.parentElement && same(b.parentElement) && textIs(b, /^(hinzufügen|add)$/i));
    const added = () => [...dlg.querySelectorAll('button[disabled]')].some(b => textIs(b, /^(hinzugefügt|added)$/i) && b.parentElement && same(b.parentElement));
    await waitFor(() => known() || added(), 700, 50);
    const rowButton = known();
    const create = [...dlg.querySelectorAll('button:not([disabled])')].find(b => textIs(b, /^(hinzufügen|add)$/i));
    const already = added();
    const target = rowButton || (already ? null : create);
    if (target) {
      target.click();
      await waitFor(() => added() || !dlg.isConnected || !target.isConnected, 1500, 50);
    }
    const still = document.querySelector('[role="dialog"]');
    if (still) (([...still.querySelectorAll('button')].find(b => textIs(b, /^(close|schließen)$/i))) || still.querySelector('button')).click();
    await waitFor(() => !document.querySelector('[role="dialog"]'), 600, 50);
    if (!target && !already) throw new Error(`Autodarts did not offer to add ${name}`);
  }

  function renderMenu() {
    const q = lm.query.trim().toLowerCase();
    const list = lm.members.filter(m => !q || [m.name, m.nickname, m.alias].some(v => (v || '').toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
    const typing = lobbyRoot.activeElement && lobbyRoot.activeElement.id === 'lmQ';
    lmPop.innerHTML = `<div class="lm-head"><b>Club members</b><input id="lmQ" placeholder="Search members" value="${esc(lm.query)}"></div>
      <div class="lm-list">${list.length ? list.map(m => {
        const here = inLobby(m), busy = lm.busy === m.id;
        return `<button class="lm-row" data-m="${esc(m.id)}" ${here || lm.busy ? 'disabled' : ''}><span class="av">${esc(initials(m.name))}</span>
          <span class="nm"><b>${esc(m.name)}</b><small>${m.summary && m.summary.games ? `${fmt(m.summary.average)} avg · ` : ''}${esc(adName(m).toUpperCase())}</small></span>
          <span class="st ${here ? 'ok' : 'add'}">${busy ? 'Adding…' : here ? '✓ In lobby' : '+ Add'}</span></button>`;
      }).join('') : `<div class="muted small" style="padding:10px">${lm.members.length ? 'Nobody matches.' : 'No members yet. Add them in AutoGlow under Players.'}</div>`}</div>
      <div class="lm-foot">Adds the member as a guest with their Autodarts name, through Autodarts' own Add player dialog.</div>`;
    if (typing) { const i = lobbyRoot.getElementById('lmQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  async function loadMembers() {
    try {
      const r = await api('members');
      lm.members = r.players || [];
      lm.lobby = r.lobby || [];
      lm.done = new Set([...lm.done].filter(id => lm.members.some(m => m.id === id && !inLobbyByState(m))));
    } catch { /* keep the last list */ }
  }
  const inLobbyByState = m => lm.lobby.some(n => n.trim().toUpperCase() === adName(m).toUpperCase());

  function placePop() {
    const r = lmBtn.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - 348, r.right - 340));
    Object.assign(lmPop.style, { left: `${left}px`, top: `${r.bottom + 8}px`, maxHeight: `${Math.max(200, Math.min(520, window.innerHeight - r.bottom - 24))}px` });
  }

  async function openMenu() {
    lmPop.hidden = false;
    placePop();
    renderMenu();
    await loadMembers();
    if (!lmPop.hidden) renderMenu();
  }

  lmBtn.addEventListener('click', () => (lmPop.hidden ? openMenu() : (lmPop.hidden = true)));
  lobbyRoot.addEventListener('input', (e) => { if (e.target.id === 'lmQ') { lm.query = e.target.value; renderMenu(); } });
  lobbyRoot.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-m]');
    if (!row || lm.busy) return;
    const m = lm.members.find(x => x.id === row.dataset.m);
    if (!m) return;
    lm.busy = m.id;
    renderMenu();
    try {
      await addToLobby(adName(m));
      lm.done.add(m.id);
    } catch (err) {
      flashLobby(err.message);
    }
    lm.busy = '';
    await loadMembers();
    renderMenu();
  });
  document.addEventListener('mousedown', (e) => { if (!lmPop.hidden && !e.composedPath().some(x => x === lobbyHost || x === lmBtn)) lmPop.hidden = true; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lmPop.hidden = true; });

  function flashLobby(msg) {
    if (!noticeHost.isConnected && document.body) document.documentElement.appendChild(noticeHost);
    const el = noticeRoot.getElementById('t');
    el.innerHTML = `<div class="toast" style="border-left-color:var(--red)">${esc(msg)}</div>`;
    setTimeout(() => { el.innerHTML = ''; }, 5000);
  }

  /** Show the button beside Shuffle (or Add player) while a lobby is on screen; open the menu once per lobby */
  function placeLobby() {
    const add = addPlayerButton();
    const anchor = mainButtons().find(b => textIs(b, /^shuffle$/i)) || add;
    const show = !!add && !isOpen() && !document.querySelector('[role="dialog"]:not([data-autoglow])');
    if (!show) {
      if (lmBtn.isConnected) lmBtn.remove();
      if (!lm.busy) lmPop.hidden = true;
      return;
    }
    if (!lobbyHost.isConnected) document.documentElement.appendChild(lobbyHost);
    // Just before Shuffle at the far end of the header: our button takes Shuffle's auto margin
    if (lmBtn.nextElementSibling !== anchor) anchor.before(lmBtn);
    if (lmBtn.className !== anchor.className) lmBtn.className = anchor.className;
    lmBtn.style.marginLeft = 'auto';
    anchor.style.marginLeft = '0';
    if (!lmPop.hidden) {
      placePop();
      // Players removed in Autodarts can be added again
      if (!lm.busy && Date.now() - (lm.loadedAt || 0) > 3000) {
        lm.loadedAt = Date.now();
        loadMembers().then(() => { if (!lmPop.hidden && !lm.busy && !(lobbyRoot.activeElement && lobbyRoot.activeElement.id === 'lmQ')) renderMenu(); });
      }
    }
    if (lm.autoShown !== location.pathname) {
      lm.autoShown = location.pathname;
      lm.done = new Set();
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  window.addEventListener('resize', () => { if (isOpen()) placePage(); });
  setInterval(() => {
    if (!document.body) return;
    placeNav();
    placeLobby();
    if (isOpen() !== pageHost.isConnected) sync();
    if (isOpen()) placePage();
  }, 500);
  poll();
  setInterval(poll, STATE_EVERY_MS);
})();
