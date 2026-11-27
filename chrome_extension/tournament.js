// AutoGlow Bridge - Local Tournament page in play.autodarts.com.
// Adds a "Local Tournament" item to Autodarts' sidebar and draws the tournament page over the
// main content area. Everything comes from the local AutoGlow (through background.js). Autodarts is
// only read, except for the "Start game" button, which sets up and starts the board's match.
(() => {
  const HASH = '#autoglow-tournament';
  const POLL_OPEN_MS = 1000;
  const POLL_CLOSED_MS = 4000;
  const NAV_PATHS = ['/play', '/online', '/lobbies', '/boards', '/tournaments', '/statistics', '/history', '/matches', '/friends', '/settings'];

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** "Updated" only when it was: any other failure means the extension's background did not answer */
  const bridgeError = m => (/context invalidated/i.test(m || '') ? 'AutoGlow Bridge was updated. Reload this page.' : 'AutoGlow Bridge did not answer. Restart the browser, or reload the extension in chrome://extensions.');

  function api(path, body) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'tournament', path, body }, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(bridgeError(chrome.runtime.lastError.message)));
          if (r && r.ok) resolve(r.data); else reject(new Error(r ? r.error : 'AutoGlow is not reachable'));
        });
      } catch {
        reject(new Error('AutoGlow Bridge was updated. Reload this page.'));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Styles: Autodarts' own design (Tailwind/shadcn), measured from play.autodarts.com on
  // 2026-11-13. Its tokens come in as CSS variables; today's values are the fallbacks.
  // ---------------------------------------------------------------------------
  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  :host{--bg:var(--background,#01040b);--card:var(--color-black-85,#1b1f29);--line:var(--border,rgb(255 255 255 / .1));--muted:var(--muted-foreground,#b5b5b5);--text:#fafafa;
    --blue:var(--color-blue-60,#0b55df);--blue2:var(--color-blue-40,#6d99ec);--green:var(--color-green-50,#12cf81);--red:var(--color-red-50,#e24e67);--yellow:var(--color-yellow-60,#f7d458);
    --chipbg:var(--color-black-70,#292c33);--tab:var(--color-black-30,#b8bcc5);--display:var(--font-display,"Bebas Neue","Manrope Variable",sans-serif);--sans:"Manrope Variable",Manrope,system-ui,sans-serif}
  /* Drawn inside Autodarts' own content area (max-w-6xl, px-2 pt-4 > px-4 pt-6 gap-6) */
  .pg{color:var(--text);font:500 14px/1.45 var(--sans);max-width:1152px;margin:0 auto;padding:40px 24px 48px}
  .pg.float{position:fixed;z-index:40;overflow:auto;max-width:none;background:var(--bg)}
  h1{font-family:var(--display);font-weight:400;font-size:48px;line-height:1;margin:0;text-transform:uppercase}
  h2,h3{font-family:var(--display);font-weight:400;font-size:24px;line-height:1.2;margin:0 0 10px;text-transform:uppercase}
  .ph{display:flex;align-items:flex-end;gap:14px;margin-bottom:24px;flex-wrap:wrap}.ph .r{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
  .sub{color:var(--muted);font-size:16px;margin-top:6px}.muted{color:var(--muted)}.small{font-size:12px}
  .card{background:var(--card);border-radius:18px;padding:20px;box-shadow:inset 0 -0.5px 0 0 rgba(255,255,255,.08)}
  .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}
  .grid3{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
  /* Buttons: primary (Spieler hinzufügen), .sec = outline (Einstellungen bearbeiten), .sm = ghost size (Shuffle) */
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:6px 16px;border-radius:12px;border:0;font:700 14px/20px var(--sans);cursor:pointer;background:var(--blue);color:#f0f5fd;white-space:nowrap;transition:all .15s}
  .btn:hover{opacity:.9}.btn:active{background:var(--color-blue-70,#0944b2)}.btn:disabled{background:var(--chipbg);color:var(--tab);cursor:default;opacity:1}
  .btn.sec{background:rgb(255 255 255 / .05);color:#fafafa;border:1px solid var(--muted);border-radius:8px;font:600 12px/16px var(--sans)}
  .btn.sec:hover,.btn.sec.on{background:var(--blue);border-color:var(--blue);opacity:1}
  .btn.sm{height:32px;padding:0 10px;font-size:12px;border-radius:8px}
  .btn.sec.sm{border-radius:8px}
  .btn.danger{background:rgb(255 255 255 / .05);color:#ff8296;border:1px solid #e24e6788;border-radius:8px;font:600 12px/16px var(--sans)}
  .btn.danger:hover{background:var(--red);border-color:var(--red);color:#fff}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:22px;font:600 12px/1.2 var(--sans);background:var(--chipbg);color:var(--muted);white-space:nowrap}
  .chip .d{width:7px;height:7px;border-radius:50%;background:currentColor}
  .chip.live{background:var(--red);color:#fff}.chip.ok{color:var(--green)}
  .chip.warn{color:var(--yellow)}.chip.blue{color:var(--blue2)}
  /* The header's ⋯ menu, and the host's lines about matches that need a hand */
  .more{position:relative}.menu{position:absolute;right:0;top:calc(100% + 6px);z-index:30;min-width:190px;padding:6px;display:flex;flex-direction:column;background:var(--drawer,#0a0a23);border-radius:12px;box-shadow:0 0 0 1px rgb(255 255 255 / .12),0 8px 24px #0008}
  .mi{background:none;border:0;color:#e3e5ea;text-align:left;padding:9px 12px;border-radius:8px;font:600 13px/18px var(--sans);cursor:pointer;white-space:nowrap}.mi:hover{background:rgb(255 255 255 / .08)}.mi.danger{color:#ff8296}
  .alert{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;padding:10px 12px 10px 18px;border-radius:14px;background:#3a3214}.alert>span{flex:1;min-width:200px}
  .btn.yb{background:var(--yellow);color:#2b2300}
  .subtabs{display:flex;gap:6px;flex-wrap:wrap}.subtabs button{height:32px;padding:0 14px;border-radius:99px;border:0;background:var(--chipbg);color:var(--tab);font:700 13px var(--sans);cursor:pointer}
  .subtabs button:hover{color:#fff}.subtabs button.on{background:#2dd4bf26;color:#5eead4}
  .choice{display:flex;flex-direction:column;gap:10px;padding:20px;border-radius:18px;border:0;background:var(--card);box-shadow:inset 0 -0.5px 0 0 rgba(255,255,255,.08);cursor:pointer;text-align:left;color:#fff;font:inherit;transition:all .15s}
  .choice:hover{background:#fff;color:var(--color-blue-90,#001849)}.choice:hover .muted{color:#3a4050}
  .ic{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;background:var(--chipbg);color:#fff}
  .note{display:block;padding:12px 14px;border-radius:12px;background:var(--chipbg);color:#e3e5ea;font-size:13px;margin-top:14px}.note.warn{color:#f3e3a0;margin-top:10px}
  .err{padding:10px 14px;border-radius:12px;background:#e24e6722;color:#ffb3c0;margin-bottom:14px}
  input,select,textarea{background:var(--color-black-70,#292c33);border:1px solid transparent;border-radius:12px;color:#fff;padding:0 14px;font:700 14px var(--sans);height:40px;outline:none}
  input:focus,select:focus,textarea:focus{border-color:var(--blue)}
  textarea{height:auto;padding:10px 12px;width:100%;min-height:120px;resize:vertical}
  select option{background:#1b1f29}
  input[type=checkbox]{height:auto;width:16px;accent-color:var(--blue)}
  .field{display:grid;grid-template-columns:180px minmax(0,320px);gap:12px;align-items:center;margin-bottom:12px}.field label{color:#cacfd9;font-weight:600}
  table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle}th{color:var(--muted);font-weight:500;height:40px}
  /* Host: pick how it's played, then the lobby (players | boards, rules folded into a bar, start bar) */
  .modes{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
  .mode{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:18px;border:2px solid transparent;background:var(--card);color:#fff;font:inherit;text-align:left;cursor:pointer;transition:all .15s;box-shadow:inset 0 -0.5px 0 0 rgba(255,255,255,.08)}
  .mode:hover{border-color:var(--blue);background:#0b55df1f;transform:translateY(-2px)}
  .mode svg{width:100%;height:74px;margin-bottom:8px;color:var(--blue2)}.mode b{font:400 26px/1 var(--display);text-transform:uppercase}
  .mode .muted{font-size:13px}.mode .small{margin-top:auto;padding-top:6px;color:#8b91a0;font-weight:700}
  .rules{padding:0;margin-bottom:16px}.rules>button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;padding:14px 20px;cursor:pointer;flex-wrap:wrap}
  .rules>button:hover .ed{color:#fff}.rules .k{font:400 20px/1 var(--display);text-transform:uppercase;color:var(--muted)}
  .rules .v{font-weight:700;flex:1;min-width:200px}.rules .ed{color:var(--blue2);font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px}
  .rules .ed i{font-style:normal;display:inline-block;transition:transform .15s}.rules.open .ed i{transform:rotate(180deg)}
  .rules .body{padding:4px 20px 20px;border-top:1px solid var(--line)}
  .ff{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:14px}
  .ff label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);font-weight:700;min-width:0}
  .ff .w{grid-column:1/-1}.ff select,.ff input{width:100%}.ff input[type=checkbox]{width:16px;flex:none}.ff label.ck{flex-direction:row;align-items:center;gap:8px;color:#e3e5ea;font-size:13px}
  .lobby{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}
  @media (max-width:860px){.lobby{grid-template-columns:1fr}}
  .lobby .side{display:flex;flex-direction:column;gap:16px}
  .qrbox{background:#fff;border-radius:12px;padding:8px;margin:0 auto;max-width:220px}.qrbox svg{display:block;width:100%;height:auto}
  .lobby .card{padding:20px}.lobby h3{display:flex;align-items:center;gap:10px;margin-bottom:14px}.lobby h3 .chip{font-family:var(--sans)}
  .addbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.addbar input#pnew{flex:1;min-width:160px}
  .sw{display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:#e3e5ea;font-weight:700;font-size:13px;user-select:none}
  .sw input{position:absolute;opacity:0;width:0;height:0}.sw span{width:34px;height:20px;border-radius:99px;background:var(--chipbg);position:relative;transition:background .15s;box-shadow:inset 0 0 0 1px rgb(255 255 255 / .15)}
  .sw span::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#cacfd9;transition:transform .15s}
  .sw input:checked+span{background:var(--yellow)}.sw.go input:checked+span{background:var(--green)}.sw input:checked+span::after{transform:translateX(14px);background:#01040b}
  .club{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:12px}.club .lbl{color:var(--muted);font-size:12px;font-weight:700;margin-right:4px}
  .pick{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px 0 4px;border-radius:99px;border:0;background:var(--chipbg);color:#fff;font:700 12px var(--sans);cursor:pointer}
  .pick:hover{background:var(--blue)}.pick .av{width:22px;height:22px;font-size:11px}.pick .muted{font-weight:600}
  .plist{margin-top:16px;border-top:1px solid var(--line)}
  .prow{display:flex;align-items:center;gap:12px;padding:8px 4px;border-bottom:1px solid var(--line)}
  .prow .n{width:20px;color:var(--muted);font-weight:800;font-size:12px;text-align:right;flex:none}
  .prow .who{flex:1;min-width:0}.prow .who b{display:block;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prow .who span{font-size:12px;color:var(--muted)}
  .prow .act{display:flex;gap:2px;opacity:.45;transition:opacity .15s}.prow:hover .act{opacity:1}
  .av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font:800 14px var(--sans);color:#fff;flex:none}
  .tag{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:99px;border:0;font:700 11px/1 var(--sans);cursor:pointer;white-space:nowrap;background:#0b55df33;color:var(--blue2)}
  .tag.vis{background:#f7d45826;color:var(--yellow)}.tag.mem{background:#12cf8126;color:var(--green);cursor:default}
  .ib{width:30px;height:30px;padding:0;border-radius:8px;border:0;background:none;color:var(--muted);cursor:pointer;font:700 14px var(--sans)}.ib:hover{background:#ffffff14;color:#fff}.ib:disabled{opacity:.3;cursor:default;background:none}
  .seedbar{display:flex;gap:8px;align-items:center;margin-top:12px;color:var(--muted);font-size:12px;font-weight:700}
  .slot{display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;background:var(--chipbg);margin-bottom:8px}
  .slot .num{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:#ffffff12;font:400 24px/1 var(--display);flex:none}
  .slot .t{flex:1;min-width:0}.slot .t b{display:block}.slot.empty{background:none;border:1.5px dashed rgb(255 255 255 / .16);color:var(--muted)}
  .slot.empty .num{background:none;border:1.5px dashed rgb(255 255 255 / .16)}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:5px}.dot.off{background:var(--yellow)}
  .pulse{animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}
  .startbar{position:sticky;bottom:16px;margin-top:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;box-shadow:0 10px 40px #000c,inset 0 0 0 1px rgb(255 255 255 / .08)}
  .startbar .btn{height:48px;padding:0 28px;font-size:16px}
  .title-in{font:400 48px/1 var(--display);height:56px;background:transparent;border:1px solid transparent;padding:0 6px;margin-left:-7px;text-transform:uppercase;width:min(560px,80vw)}
  .title-in:hover{border-color:var(--line)}
  .vs{display:flex;align-items:center;gap:16px;margin:10px 0 6px;flex-wrap:wrap}.vs b{font-family:var(--display);font-weight:400;font-size:34px;text-transform:uppercase}
  .vs .x{font-family:"Bebas Neue",sans-serif;font-size:28px;color:#707580}.vs .sc{font-family:"Bebas Neue",sans-serif;font-size:48px;line-height:1}
  .banner{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 12px 10px 20px;border-radius:14px}.banner .vs{flex:1;min-width:0;margin:0}.banner .vs b{font-size:26px}
  .banner>.btn{height:40px;padding:0 20px;font-size:14px}
  /* The bracket so far: boxes to tap. A board's colour = the match it has lined up, red = being played, dimmed = done, faint = can't be picked now */
  .pkb{margin-top:20px;align-items:stretch;position:relative}.pkb .round h5{text-align:center}
  .pkb .pk{position:relative;z-index:1}.pkb svg{position:absolute;left:0;top:0;pointer-events:none}.pkb .round{min-width:180px;flex:1 1 0;justify-content:flex-start}
  .pkb .rb{flex:1;display:flex;flex-direction:column;justify-content:space-around;gap:12px}
  .pk{background:var(--card);border-radius:12px;border:2px solid transparent;overflow:hidden;cursor:pointer;transition:border-color .12s}
  .pk:hover{border-color:#ffffff2a}.pk.by{border-color:var(--bc)}.pk.no.by{opacity:.8}.pk.live{border-color:var(--red)}.pk.done{opacity:.5}.pk.no{opacity:.35}
  .pk .p{display:flex;justify-content:space-between;gap:8px;padding:9px 12px;font-weight:800}.pk .p+.p{border-top:1px solid var(--line)}
  .pk .p .s{font:400 20px/1 "Bebas Neue",sans-serif}.pk .p.w .s{color:var(--green)}
  .pk .t{font-size:11px;font-weight:700;color:#ff8296;padding:5px 12px;background:#00000055}
  .pk .t.bt,.m .bt{color:#e3e5ea;display:flex;gap:10px;flex-wrap:wrap}.bd{display:inline-flex;align-items:center;gap:5px}.bd i{width:8px;height:8px;border-radius:50%;background:var(--bc)}
  .m.by{border-color:var(--bc)}
  /* Groups → KO: phase bar, a card per group (table with the cut line under the last place that goes through, matches one per line) */
  .phase{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.phase span{padding:6px 14px;border-radius:99px;background:var(--chipbg);color:var(--tab);font:700 13px var(--sans)}
  .phase .on{background:#0b55df33;color:var(--blue2)}.phase .done{color:var(--green)}
  .gcards{display:grid;grid-template-columns:repeat(var(--gc),minmax(0,1fr));gap:16px;margin-top:16px;align-items:start}
  @media (max-width:860px){.gcards{grid-template-columns:1fr}}
  .gc{padding:16px}.gh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}.gh h3{margin:0}
  .gt th,.gt td{padding:5px 6px;font-size:13px;height:auto}.gt td:nth-child(n+3),.gt th:nth-child(n+3){text-align:right}
  .gt td:nth-child(2){font-weight:800;max-width:0;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gt tr.q td:first-child{color:var(--green);font-weight:800}.gt tr.cut td{border-bottom:2px dashed #12cf8166}
  .gr{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;margin-top:12px;align-items:start}
  .gr .rn{color:var(--muted);font-size:11px;font-weight:800;padding-top:10px}.gr>div{display:flex;flex-direction:column;gap:6px}
  .gm{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;border-radius:10px;background:var(--chipbg)}
  .gm>span{padding:7px 10px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gm>span:first-child{text-align:right}
  .gm .s{font:400 18px/1 "Bebas Neue",sans-serif;color:var(--muted);padding:7px 4px;min-width:44px;text-align:center}.gm .w{color:var(--green)}.gm .l{color:#707580}
  .gm .t{grid-column:1/-1}
  .bracket{display:flex;gap:26px;overflow:auto;padding:4px 2px 10px}
  .round{display:flex;flex-direction:column;justify-content:space-around;gap:12px;min-width:200px}
  .round h5{margin:0;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
  .m{background:var(--card);border:1px solid transparent;border-radius:12px;overflow:hidden;position:relative;box-shadow:inset 0 -0.5px 0 0 rgba(255,255,255,.08)}
  .m.live{border-color:var(--red)}.m .ref{position:absolute;right:8px;top:3px;font-size:10px;color:#707580;font-weight:700}
  .m .p{display:flex;justify-content:space-between;gap:8px;padding:6px 32px 6px 12px;font-weight:700}.m .p+.p{border-top:1px solid var(--line)}
  .m .p.lose{color:#707580}.m .p.win .scv{color:var(--green)}.m .src{color:#707580;font-weight:600}
  .m .meta{font-size:11px;color:var(--muted);padding:4px 12px;background:#00000040;font-weight:600}
  .sect{margin:18px 0 8px;color:var(--muted);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .toast{position:fixed;right:24px;bottom:24px;z-index:41;color:var(--text);font:600 14px/1.45 var(--sans);background:var(--color-black-70,#292c33);border-radius:12px;padding:12px 16px;box-shadow:0 10px 40px #000a;max-width:380px}
  .dlg{color:var(--text);font:500 14px/1.45 var(--sans);position:fixed;inset:0;background:rgb(0 0 0 / .6);backdrop-filter:blur(4px);display:grid;place-items:center;z-index:42;overflow:auto;padding:24px 0}
  .dlg .card{width:min(480px,92vw);max-height:calc(100vh - 48px);overflow:auto;background:var(--drawer,#0a0a23);border-radius:12px;box-shadow:0 0 0 1px rgb(255 255 255 / .1)}
  .rs{gap:12px;align-items:stretch;margin:16px 0 10px}.rs .nm{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 10px;background:var(--card);border:2px solid transparent;border-radius:14px;color:#e3e5ea;font:700 15px/1.3 var(--sans);cursor:pointer}
  .rs .nm.win{border-color:var(--green)}.rs .leg{font:400 40px/1 var(--display,var(--sans));padding:4px 14px;border-radius:10px}.rs .leg:hover{background:rgb(255 255 255 / .08)}
  `;

  // players.js draws the Players page with the same look
  window.__autoglowCSS = CSS;

  /**
   * Our pages live inside Autodarts' own content area, like its own pages: Autodarts' content is
   * hidden while ours shows, and comes back when ours closes. Without a <main> (Autodarts
   * changed), the page floats over the window instead.
   */
  function mountPage(host, pgEl) {
    const main = document.querySelector('main');
    if (!main) {
      pgEl.classList.add('float');
      if (host.parentElement !== document.documentElement) document.documentElement.appendChild(host);
      Object.assign(pgEl.style, { left: '0px', top: '0px', width: `${window.innerWidth}px`, height: `${window.innerHeight}px` });
      return;
    }
    pgEl.classList.remove('float');
    pgEl.removeAttribute('style');
    if (host.parentElement !== main) main.appendChild(host);
    // Some Autodarts pages (the home page) lock <main>'s scrolling; ours are often longer.
    if (!main.dataset.agScroll) {
      main.dataset.agScroll = main.style.overflowY || '-';
      main.style.overflowY = 'auto';
    }
    for (const c of main.children) {
      if (c !== host && !c.hasAttribute('data-autoglow') && c.style.display !== 'none') {
        c.dataset.agHidden = '1';
        c.style.display = 'none';
      }
    }
  }
  function unmountPage(host) {
    host.remove();
    if (document.querySelector('main > [data-autoglow$="-page"]')) return;
    for (const m of document.querySelectorAll('[data-ag-scroll]')) {
      m.style.overflowY = m.dataset.agScroll === '-' ? '' : m.dataset.agScroll;
      delete m.dataset.agScroll;
    }
    for (const c of document.querySelectorAll('[data-ag-hidden]')) {
      c.style.display = '';
      delete c.dataset.agHidden;
    }
  }
  window.__autoglowMount = { mountPage, unmountPage };

  /** Read-only club views (members with their stats) */
  function clubApi(path) {
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

  const ICON = {
    trophy: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0zM5 5H3v2a3 3 0 0 0 3 3M19 5h2v2a3 3 0 0 1-3 3M12 13v4M8 21h8"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // Sidebar item
  // ---------------------------------------------------------------------------
  const navHost = document.createElement('div');
  navHost.setAttribute('data-autoglow', 'tournament-nav');
  const navRoot = navHost.attachShadow({ mode: 'open' });
  navRoot.innerHTML = `<style>
    :host{display:block}:host(.top){display:flex}
    a{display:flex;align-items:center;gap:10px;text-decoration:none;cursor:pointer;color:inherit;font:inherit;border-radius:8px;white-space:nowrap}
    a:hover{background:#ffffff0d}a.on{background:#ffffff14;color:#fff}
    :host(.compact) .long,:host(.compact) .short{display:none!important}
    :host(.top) .sec{display:none}:host(.top) a{position:relative;border-radius:0;background:none;gap:7px}:host(.top) a:hover,:host(.top) a.on{color:#fff!important}
    :host(.top) a.on::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:#fff}
    :host(.bottom) a{flex-direction:column;gap:4px;justify-content:center}:host(.bottom) .long{display:none}:host(.bottom) .short{display:inline!important}
    :host(.bottom) a.on::after{top:auto;bottom:0}:host(.bottom) svg{width:20px;height:20px}
    :host(.bottom) .b{position:absolute;top:2px;right:0;margin:0}
    .sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;opacity:.55;margin:12px 0 4px 10px}
    .b{margin-left:auto;font-size:10px;font-weight:800;padding:2px 6px;border-radius:99px;background:#0b55df;color:#f0f5fd}.b.live{background:#da3954}.b:empty{display:none}
    svg{width:18px;height:18px;flex:none}
    /* Top bar: text only, like Autodarts' own Start / Spielen / Turniere */ :host(.top) svg{display:none}
    /* AutoGlow's teal (the app's --accent-bright), so the extension's items stand apart from Autodarts' own */
    a{color:#2dd4bf!important}:host(.top) a:hover,:host(.top) a.on,a:hover,a.on{color:#5eead4!important}
    :host(.top) a.on::after{background:#2dd4bf!important}
  </style><div class="sec">AutoGlow</div><a id="item" title="Local Tournament">${ICON.trophy.replace('width="22" height="22"', '')}<span class="long">Local Tournament</span><span class="short" style="display:none">Local</span><span class="b" id="badge"></span></a>`;
  const navItem = navRoot.getElementById('item');
  navItem.addEventListener('click', (e) => { e.preventDefault(); openPage(); });

  /** The element holding Autodarts' sidebar links, found by the links it contains */
  function findSidebar() {
    const links = [...document.querySelectorAll('a[href]')].filter(a => NAV_PATHS.some(p => (a.getAttribute('href') || '').startsWith(p)) && !navHost.contains(a));
    if (links.length < 2) return null;
    let box = links[0].parentElement;
    while (box && box !== document.body) {
      if (links.filter(l => box.contains(l)).length >= Math.min(3, links.length)) return { box, sample: links.find(l => !l.getAttribute('aria-current')) || links[0] };
      box = box.parentElement;
    }
    return null;
  }

  function placeNav() {
    const found = findSidebar();
    // No menu on screen (lobby, match): Autodarts hides its menu there, so ours goes too
    if (!found) {
      if (navHost.isConnected) navHost.remove();
      return;
    }
    // After Autodarts' own items; only our Players item may follow (moving every tick made both flicker)
    const after = navHost.nextElementSibling;
    if (navHost.parentElement !== found.box || (after && !after.hasAttribute('data-autoglow'))) {
      navHost.style.cssText = '';
      found.box.appendChild(navHost);
    }
    // Autodarts has a menu bar across the top today; a sidebar layout is kept as the fallback
    // Narrow screens: the same menu becomes a tab bar at the bottom with icons over short labels
    const box = found.box.getBoundingClientRect();
    navHost.classList.toggle('top', box.height < 120);
    navHost.classList.toggle('bottom', box.height < 120 && box.top > window.innerHeight / 2);
    dimNative(found.box);
    const cs = getComputedStyle(found.sample);
    navItem.style.cssText = `padding:${cs.padding};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-family:${cs.fontFamily};min-height:${cs.height}`;
    fitTopBar(found.box);
  }

  // Narrow screens (portrait): the centred top bar runs into the logo and the icons on its right.
  // Then our items show only their icons. The full width is remembered, so it doesn't flip each tick.
  let fullWidth = 0, fitWidth = 0;
  function fitTopBar(box) {
    if (!navHost.classList.contains('top') || navHost.classList.contains('bottom')) {
      navHost.classList.remove('compact');
      return;
    }
    if (fitWidth !== window.innerWidth) { fitWidth = window.innerWidth; fullWidth = 0; navHost.classList.remove('compact'); }
    const r = box.getBoundingClientRect();
    if (!navHost.classList.contains('compact')) fullWidth = r.width;
    const mid = r.left + r.width / 2;
    let room = Infinity;
    for (const s of box.parentElement.children) {
      if (s === box || s.contains(box)) continue;
      const o = s.getBoundingClientRect();
      if (!o.width) continue;
      room = Math.min(room, o.right <= mid ? mid - o.right : o.left - mid);
    }
    navHost.classList.toggle('compact', fullWidth / 2 + 16 > room);
  }

  /** While our page is open, Autodarts' own active entry and its underline must not look active too */
  function dimNative(box) {
    const open = isOpen() || location.hash === '#autoglow-players';
    for (const a of box.querySelectorAll('a[aria-current]')) a.style.color = open ? 'var(--color-black-20, #cacfd9)' : '';
    for (const d of box.querySelectorAll(':scope > div[aria-hidden="true"]')) d.style.opacity = open ? '0' : '';
  }

  // ---------------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------------
  const pageHost = document.createElement('div');
  pageHost.setAttribute('data-autoglow', 'tournament-page');
  const root = pageHost.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><div class="pg" id="pg"></div><div id="dlg"></div>`;
  const pg = root.getElementById('pg');

  let data = null;        // /api/tournament/local
  let error = '';
  let lastJson = '';
  let tab = { host: 'mine', board: 'mine' }; // 'mine' = the board view, 'bracket' = the tables
  let screen = 'start';   // no tournament: start | join | exists | mode (how it's played, before the lobby opens)
  let hosts = null;       // discovered AutoGlows
  let lob = null;         // host lobby: the organizer's copy of rules and players, saved to AutoGlow as it changes
  let busy = false;

  function isOpen() { return location.hash === HASH; }

  function openPage() {
    if (location.hash !== HASH) history.pushState(null, '', location.pathname + location.search + HASH);
    sync();
    refresh(true);
  }

  const placePage = () => mountPage(pageHost, pg);

  function sync() {
    const open = isOpen();
    navItem.classList.toggle('on', open);
    if (navHost.parentElement) dimNative(navHost.parentElement);
    if (open) placePage();
    if (!open && pageHost.isConnected) unmountPage(pageHost);
  }

  async function refresh(force) {
    try {
      data = await api('local');
      error = '';
    } catch (e) {
      error = e.message;
    }
    badge();
    toast();
    callout();
    takePhoneSignups();
    if (window.autoglowMatch) window.autoglowMatch(data);
    if (!isOpen()) return;
    const json = JSON.stringify(data) + error;
    if (force || (json !== lastJson && !typing() && !root.getElementById('dlg').innerHTML)) {
      lastJson = json;
      render();
    } else if (json !== lastJson) {
      paintLobbyBoards();
    }
  }

  /** Typing in a text field: a redraw would take the cursor away */
  function typing() {
    const el = root.activeElement;
    return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio)$/.test(el.type)));
  }

  function badge() {
    const b = navRoot.getElementById('badge');
    let txt = '', live = false;
    if (data && data.role !== 'none') {
      const a = data.board && data.board.assignment;
      if (data.role === 'host') {
        const n = ((data.tournament || {}).matches || []).filter(m => m.state === 'live').length;
        txt = n ? `${n} live` : '';
        live = n > 0;
      } else if (a) {
        txt = data.board.linked ? 'LIVE' : 'Next';
        live = !!data.board.linked;
      }
    }
    b.textContent = txt;
    b.classList.toggle('live', live);
  }

  // Toasts show on every Autodarts page; the "next match" card sits in the page itself, at the
  // top of Start, Play and the lobby, like one of Autodarts' own cards
  const noticeHost = document.createElement('div');
  noticeHost.setAttribute('data-autoglow', 'tournament-notice');
  const noticeRoot = noticeHost.attachShadow({ mode: 'open' });
  noticeRoot.innerHTML = `<style>${CSS}
    .cover{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgb(1 4 11 / .94);backdrop-filter:blur(8px);color:var(--text);font:500 14px/1.45 var(--sans);animation:fade .2s ease-out}
    .cover .box{text-align:center;max-width:520px;padding:24px}
    .cover .lbl{margin-top:20px;color:var(--muted);font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
    .cover .who{font:400 48px/1.1 var(--display);text-transform:uppercase;margin:8px 0 10px}.cover .who .x{color:#707580;font-size:34px}
    .cover .spin{width:46px;height:46px;margin:0 auto;border-radius:50%;border:4px solid #ffffff1f;border-top-color:var(--blue2);animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}@keyframes fade{from{opacity:0}}
  </style><div id="toast"></div><div id="cover"></div>`;
  const ensureNotices = () => { if (!noticeHost.isConnected && document.body) document.documentElement.appendChild(noticeHost); };

  const cardHost = document.createElement('div');
  cardHost.setAttribute('data-autoglow', 'tournament-card');
  const cardRoot = cardHost.attachShadow({ mode: 'open' });
  cardRoot.innerHTML = `<style>${CSS}
    :host{display:block}
    .nx{display:flex;align-items:center;gap:20px;flex-wrap:wrap;font:500 14px/1.45 var(--sans);color:var(--text)}
    .nx .who{font:400 34px/1.1 var(--display);text-transform:uppercase;margin:6px 0 2px}
    .nx .r{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  </style><div class="card" id="callout"></div>`;

  /** Where the card goes: first in the page column of Start, Play and the lobby; nowhere else */
  function cardSlot() {
    const p = location.pathname;
    if (!(p === '/' || p === '/play' || p.startsWith('/lobby/'))) return null;
    const wrap = document.querySelector('main > div:not([data-autoglow])');
    if (!wrap) return null;
    // The lobby's column of cards (flex-col gap-6); elsewhere the top of the page
    const col = wrap.firstElementChild;
    return col && /\bflex-col\b/.test(col.className) && /\bgap-/.test(col.className) ? col : wrap;
  }

  let calledOut = '';
  const startButton = (attr = 'data-n', match = '') => (starting && !starting.error ? '' : `<button class="btn" ${attr}="start"${match ? ` data-m="${esc(match)}"` : ''}>▶ Start game</button>`);
  /** A new match for this board: shown in the page the players are on, until the game is linked */
  function callout(force) {
    const a = data && data.board && data.board.assignment;
    const key = a ? `${a.match}` : '';
    const slot = !a || data.board.linked || isOpen() || (calledOut === `x${key}` && !starting) ? null : cardSlot();
    if (!a) calledOut = '';
    if (!slot) {
      if (cardHost.isConnected) cardHost.remove();
      return;
    }
    if (cardHost.parentElement !== slot || slot.firstElementChild !== cardHost) {
      slot.prepend(cardHost);
      if (slot.classList.contains('flex-col')) cardHost.style.margin = ''; else cardHost.style.margin = '16px 16px 8px';
    }
    const el = cardRoot.getElementById('callout');
    if (calledOut === key && !force && el.innerHTML) return;
    calledOut = key;
    const s = a.settings;
    el.innerHTML = `<div class="nx"><div><span class="chip">Local Tournament</span>
      <div class="who">${esc(a.players[0].name)} <span class="muted">vs</span> ${esc(a.players[1].name)}</div>
      <div class="muted">X01 ${s.base_score} · ${esc(s.in_mode)} in · ${esc(s.out_mode)} out · first to ${s.sets ? `${s.sets} set${s.sets > 1 ? 's' : ''} (${s.legs} leg${s.legs > 1 ? 's' : ''} each)` : `${s.legs} leg${s.legs > 1 ? 's' : ''}`}</div></div>
      <div class="r">${startButton()}${starting && !starting.error ? '' : '<button class="btn sec" data-n="open" title="All upcoming matches: someone isn\'t here? Play another one first">Change match…</button><button class="btn sec" data-n="hide">Hide</button>'}</div></div>`;
  }
  cardRoot.addEventListener('click', (e) => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    if (b.dataset.n === 'start') { runStart(); return; }
    if (b.dataset.n === 'open') openPage();
    if (b.dataset.n === 'hide') calledOut = `x${calledOut}`;
    callout(true);
  });

  function flash(msg) {
    ensureNotices();
    const el = noticeRoot.getElementById('toast');
    el.innerHTML = `<div class="toast">${esc(msg)}</div>`;
    setTimeout(() => { el.innerHTML = ''; }, 3000);
  }

  let lastNotice = '';
  function toast() {
    const n = data && data.board && data.board.notice;
    ensureNotices();
    const el = noticeRoot.getElementById('toast');
    if (n && n !== lastNotice) {
      lastNotice = n;
      el.innerHTML = `<div class="toast">${esc(n)}</div>`;
      setTimeout(() => { el.innerHTML = ''; }, 4000);
    }
    if (!n) lastNotice = '';
  }

  // ---------------------------------------------------------------------------
  // "Start game": AutoGlow creates the board's match as a local game and starts it, in one click.
  // page_hook.js makes the calls to Autodarts' API with the page's own login (the user chose this on
  // 2026-11-14, knowing Autodarts' terms are against software operating the site). A cover hides
  // the page until the match screen is there.
  // ---------------------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let starting = null; // { match, error }

  async function waitFor(fn, ms = 8000, step = 50) {
    for (let t = 0; t < ms; t += step) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function cover() {
    ensureNotices();
    const el = noticeRoot.getElementById('cover');
    if (!starting) { el.innerHTML = ''; return; }
    const [p0, p1] = starting.names;
    el.innerHTML = `<div class="cover"><div class="box">${starting.error ? '<div class="lbl">Could not start the game</div>' : '<div class="spin"></div><div class="lbl">Starting game</div>'}
      <div class="who">${esc(p0)} <span class="x">vs</span> ${esc(p1)}</div>
      ${starting.error ? `<div class="muted">${esc(starting.error)}</div><div style="margin-top:18px"><button class="btn sec" id="cover-close">Close</button></div>` : ''}</div></div>`;
  }
  noticeRoot.addEventListener('click', (e) => { if (e.target.id === 'cover-close') { starting = null; cover(); callout(true); } });

  /** Ask page_hook.js to set up and start the game; resolves with the new match id */
  function startViaApi(game, finished) {
    const id = `${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { window.removeEventListener('message', on); clearTimeout(timer); fn(v); };
      const on = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.source !== 'autoglow-start-result' || ev.data.id !== id) return;
        if (ev.data.ok) done(resolve, ev.data.match); else done(reject, new Error(ev.data.error));
      };
      const timer = setTimeout(() => done(reject, new Error('Autodarts did not answer. Reload the page and try again.')), 15000);
      window.addEventListener('message', on);
      window.postMessage({ source: 'autoglow-start', id, game, finished }, location.origin);
    });
  }

  /** finished: pressed on the result of the match this page shows, so leaving it loses nothing.
   *  match: a match tapped on this board's page; it comes to this board first */
  async function runStart(finished = false, match = '') {
    let a = data && data.board && data.board.assignment;
    if ((starting && !starting.error) || (data && data.board && data.board.linked)) return;
    const m = match && T() && T().matches.find(x => x.id === match);
    if (!m && !a) return;
    starting = { names: m ? m.sides.map(s => pname(s.player)) : a.players.map(p => p.name) };
    cover();
    callout(true);
    try {
      if (m && (!a || a.match !== m.id)) {
        data = await api('claim', { match: m.id });
        // A board asks the host: the match arrives with the host's next update
        for (let i = 0; i < 40 && !(data.board.assignment && data.board.assignment.match === m.id); i++) {
          await sleep(250);
          await refresh(false);
        }
        a = data.board.assignment;
        if (!a || a.match !== m.id) throw new Error('The host did not hand this match over. Try again.');
      }
      picked = null;
      const players = a.players.map(p => ({ name: (p.ad_name || p.name).trim() }));
      const id = await startViaApi({ settings: a.settings, players }, finished);
      api('started', { match: a.match, ad_match: id }).catch(() => {});
      // Autodarts may still ask "End this game?" on a running match: then the cover goes so it can be answered
      if (await waitFor(() => location.pathname === `/matches/${id}`, 3000)) await sleep(700);
    } catch (e) {
      starting = { ...starting, error: e.message };
      cover();
      callout(true);
      return;
    }
    starting = null;
    cover();
    callout(true);
  }

  // The match screen's winner banner starts this board's next match (match.js)
  window.autoglowStartNext = () => runStart(true);
  // ...or opens this page after the final: from Play, the match page has no room for it
  window.autoglowShowPage = async () => {
    if (/^\/matches\//.test(location.pathname)) {
      window.postMessage({ source: 'autoglow-nav', to: '/play', finished: true }, location.origin);
      if (!await waitFor(() => location.pathname === '/play', 2500)) { location.assign('/play' + HASH); return; }
    }
    openPage();
  };

  async function act(path, body, after) {
    if (busy) return;
    busy = true;
    try {
      data = await api(path, body);
      error = '';
      if (after) after();
    } catch (e) {
      error = e.message;
    }
    busy = false;
    lastJson = '';
    render();
  }

  // ---------------------------------------------------------------------------
  // Helpers for tournament data
  // ---------------------------------------------------------------------------
  const T = () => (data && data.tournament) || null;
  function pname(id) {
    const t = T();
    const p = t && (t.players || []).find(x => x.id === id);
    return p ? p.name : id;
  }
  // Each board's colour, by its number: the match it has lined up shows in it on every screen
  const BOARD_COLORS = ['#6d99ec', '#ff9f43', '#c084fc', '#2dd4bf', '#f472b6', '#a3e635', '#fbbf24', '#94a3b8'];
  const boardColor = b => BOARD_COLORS[(Math.max(1, b.number) - 1) % BOARD_COLORS.length];

  /** match id -> the boards that have it lined up: the match a board picked while it is still free,
   *  else the one the host handed it. This board's own comes from its page (`own`), not the host. */
  function lineups(t, own) {
    const by = {};
    for (const b of (t.boards || []).filter(x => x.approved && !x.left)) {
      let id = b.pick;
      if (b.node_id === data.node.id && own !== undefined) id = own;
      const m = id && t.matches.find(x => x.id === id);
      const free = m && (m.state === 'ready' || (m.state === 'assigned' && m.board === b.node_id));
      const handed = t.matches.find(x => x.state === 'assigned' && x.board === b.node_id);
      const it = free ? m : (own === undefined || b.node_id !== data.node.id) && handed;
      if (it) (by[it.id] = by[it.id] || []).push(b);
    }
    return by;
  }
  const boardTags = (bs, me) => bs.map(b => `<span class="bd" style="--bc:${boardColor(b)}"><i></i>${b.node_id === me ? 'This board' : `Board ${b.number}`}</span>`).join('');

  function boardName(node) {
    const b = T() && (T().boards || []).find(x => x.node_id === node);
    return b ? `Board ${b.number}` : '';
  }
  function sideName(m, i) {
    const s = m.sides[i];
    if (s.player) return esc(pname(s.player));
    if (s.bye) return '<span class="src">bye</span>';
    const f = s.from || '';
    const txt = f.startsWith('W:') ? `Winner ${f.slice(2)}` : f.startsWith('L:') ? `Loser ${f.slice(2)}` : f.startsWith('G:') ? `${ordinal(+f.split(':')[2])} Group ${f.split(':')[1]}` : '—';
    return `<span class="src">${esc(txt)}</span>`;
  }
  const ordinal = n => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
  const FORMAT_NAME = { single_ko: 'Single KO', double_ko: 'Double KO', groups: 'Groups → KO', league: 'League', swiss: 'Swiss' };

  function matchBox(m, by = {}) {
    const r = m.result;
    const w = m.state === 'done' && r ? r.winner : -1;
    const show = m.state === 'done' || m.state === 'live';
    const live = m.state === 'live' ? liveOf(m) : null;
    const sc = (i) => {
      if (live && live.legs) return live.legs[i];
      if (!show || !r) return '';
      return r.walkover ? (i === r.winner ? 'W' : '–') : r.legs[i];
    };
    const bs = m.state === 'ready' || m.state === 'assigned' ? (by[m.id] || []).slice().sort((p, q) => p.number - q.number) : [];
    const meta = m.state === 'live' ? `<span style="color:#ff6b84">● LIVE</span> · ${esc(boardName(m.board))}`
      : bs.length ? `<span class="bt">${boardTags(bs, data.node.id)}</span>`
      : m.state === 'assigned' ? `Setting up · ${esc(boardName(m.board))}`
      : m.state === 'ready' ? (m.held ? 'On hold' : 'Waiting for a free board')
      : m.state === 'skipped' ? 'Not needed' : '';
    return `<div class="m ${m.state === 'live' ? 'live' : ''}${bs.length ? ' by' : ''}"${bs.length ? ` style="--bc:${boardColor(bs[0])}"` : ''}><span class="ref">${esc(m.id)}</span>
      <div class="p ${w === 0 ? 'win' : w === 1 ? 'lose' : ''}"><span>${sideName(m, 0)}</span><span class="scv">${sc(0)}</span></div>
      <div class="p ${w === 1 ? 'win' : w === 0 ? 'lose' : ''}"><span>${sideName(m, 1)}</span><span class="scv">${sc(1)}</span></div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}</div>`;
  }

  function liveOf(m) {
    const t = T();
    const b = t && (t.boards || []).find(x => x.node_id === m.board);
    if (b && b.status && b.status.match === m.id) return b.status.live;
    const a = data.board && data.board.assignment;
    if (a && a.match === m.id) return data.board.live;
    return m.last_live || null;
  }

  function bracketCols(ms, lu) {
    const rounds = [...new Set(ms.map(m => m.round))].sort((a, b) => a - b);
    return `<div class="bracket">${rounds.map(r => {
      const rm = ms.filter(m => m.round === r).sort((a, b) => a.order - b.order);
      return `<div class="round"><h5>${esc(rm[0].label)}</h5>${rm.map(m => matchBox(m, lu)).join('')}</div>`;
    }).join('')}</div>`;
  }

  function tablesHTML(t) {
    return (t.tables || []).map(tb => `<div class="card" style="margin-bottom:14px"><h3>${esc(tb.name.length === 1 ? `Group ${tb.name}` : tb.name)}</h3>
      <table><tr><th>#</th><th>Player</th><th>Played</th><th>Won</th><th>Lost</th><th>Legs</th><th>+/-</th>${t.format === 'swiss' ? '<th>Buchholz</th>' : ''}<th>Avg</th><th>180s</th></tr>
      ${tb.rows.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.name)}</b></td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.legs_for}:${r.legs_against}</td><td>${r.legs_for - r.legs_against}</td>${t.format === 'swiss' ? `<td>${r.buchholz}</td>` : ''}<td>${r.average ? r.average.toFixed(2) : '–'}</td><td>${r.t180 || 0}</td></tr>`).join('')}</table></div>`).join('');
  }

  function bracketHTML(t) {
    const ms = t.matches || [];
    const by = (s) => ms.filter(m => m.stage === s);
    const lu = t.status === 'running' ? lineups(t) : {};
    let h = '';
    if (t.champion) h += `<div class="card" style="margin-bottom:16px;border-color:#f7d45866"><h2 style="color:var(--yellow)">🏆 ${esc(pname(t.champion))} wins ${esc(t.name)}</h2></div>`;
    if (t.format === 'single_ko') h += bracketCols(by('main'), lu);
    if (t.format === 'double_ko') {
      h += `<div class="sect">Winners bracket</div>${bracketCols(by('wb'), lu)}`;
      if (by('lb').length) h += `<div class="sect">Losers bracket</div>${bracketCols(by('lb'), lu)}`;
      h += `<div class="sect">Grand final</div>${bracketCols(by('gf'), lu)}`;
    }
    if (t.format === 'groups') {
      h += tablesHTML(t);
      h += `<div class="sect">Knockout</div>${bracketCols(by('ko'), lu)}`;
      h += `<div class="sect">Group matches</div>${matchList(by('group'), lu)}`;
    }
    if (t.format === 'swiss') h += tablesHTML(t) + `<div class="sect">Rounds</div>${bracketCols(by('swiss'), lu)}`;
    if (t.format === 'league') h += tablesHTML(t) + `<div class="sect">Matches${t.return_round ? ' (with return round)' : ''}</div>${matchList(by('group'), lu)}`;
    return h;
  }

  function matchList(ms, lu) {
    return `<div class="grid3">${ms.map(m => matchBox(m, lu)).join('')}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function render() {
    if (!isOpen()) return;
    placePage();
    let h = error ? `<div class="err">${esc(error)}</div>` : '';
    if (!data) {
      pg.innerHTML = h + `<div class="ph"><h1>Local Tournament</h1></div><div class="card">Connecting to AutoGlow… Is AutoGlow running on this PC?</div>`;
      return;
    }
    if (data.role === 'host') h += hostPage();
    else if (data.role === 'board') h += boardPage();
    else h += freshPage();
    const scrolled = [...pg.querySelectorAll('.pkb')].map(el => el.scrollLeft);
    pg.innerHTML = h;
    pg.querySelectorAll('.pkb').forEach((el, i) => {
      const cur = el.querySelector('.round.cur');
      const key = cur ? `${i}:${cur.querySelector('h5').textContent}` : '';
      if (cur && lastCur[i] !== key) el.scrollLeft = cur.offsetLeft - el.offsetLeft - 4;
      else if (scrolled[i] != null) el.scrollLeft = scrolled[i];
      lastCur[i] = key;
    });
    flowLines();
  }
  const lastCur = []; // the first playing round of each bracket strip, as last scrolled to

  /** Faint lines from each match to the one its winner goes on to, within a bracket strip */
  function flowLines() {
    const ms = Object.fromEntries(((T() || {}).matches || []).map(m => [m.id, m]));
    pg.querySelectorAll('.pkb').forEach((el) => {
      const old = el.querySelector('svg');
      if (old) old.remove();
      const box = id => el.querySelector(`.pk[data-m="${window.CSS.escape(id)}"]`);
      let paths = '';
      for (const to of el.querySelectorAll('.pk')) {
        const m = ms[to.dataset.m];
        const froms = [...new Set((m ? m.sides : []).map(sd => sd.from || '').filter(f => f.startsWith('W:')).map(f => f.slice(2)))];
        froms.forEach((id) => {
          const from = box(id);
          if (!from) return;
          const x1 = from.offsetLeft + from.offsetWidth, y1 = from.offsetTop + from.offsetHeight / 2;
          const x2 = to.offsetLeft, y2 = to.offsetTop + to.offsetHeight * (froms.length > 1 ? (froms.indexOf(id) ? 0.75 : 0.25) : 0.5);
          const xm = (x1 + x2) / 2;
          paths += `<path d="M${x1} ${y1}H${xm}V${y2}H${x2}"/>`;
        });
      }
      if (paths) el.insertAdjacentHTML('afterbegin', `<svg width="${el.scrollWidth}" height="${el.scrollHeight}" fill="none" stroke="#ffffff1c" stroke-width="2">${paths}</svg>`);
    });
  }
  window.addEventListener('resize', () => { if (isOpen()) flowLines(); });

  function freshPage() {
    if (screen === 'mode') return modePage();
    if (screen === 'join') {
      return `<div class="ph"><div><h1>Join a tournament</h1><div class="sub">AutoGlows found on your network</div></div><div class="r"><button class="btn sec sm" data-act="rescan">Search again</button><button class="btn sec sm" data-act="screen" data-v="start">← Back</button></div></div>
        ${hosts === null ? '<div class="card">Searching…</div>' : (hosts.filter(x => x.tournament).length ? hosts.filter(x => x.tournament).map(x => `<div class="card row" style="margin-bottom:8px"><div class="ic">${ICON.trophy}</div><div style="flex:1"><b>${esc(x.tournament)}</b><div class="small muted">hosted by ${esc(x.name)} · ${esc(x.address)}</div></div><button class="btn sm" data-act="join" data-addr="${esc(x.address)}" data-host="${esc(x.name)}" data-tour="${esc(x.tournament)}">Join</button></div>`).join('') : '<div class="card muted">No tournament found. Is it hosted on a PC in this network?</div>')}
        <div class="card" style="margin-top:14px"><h3>Not listed?</h3><div class="muted small" style="margin-bottom:10px">Type the host's address, e.g. 192.168.1.20</div><div class="row"><input id="addr" placeholder="192.168.1.20" style="width:240px"><button class="btn sec" data-act="join-addr">Connect</button></div></div>`;
    }
    if (screen === 'exists') {
      const h = (hosts || []).find(x => x.tournament);
      return `<div class="ph"><div><h1>There is already a host</h1><div class="sub"><b style="color:#fff">${esc(h.name)}</b> is hosting <b style="color:#fff">${esc(h.tournament)}</b> on this network.</div></div></div>
        <div class="grid2"><button class="choice" data-act="join" data-addr="${esc(h.address)}" data-host="${esc(h.name)}" data-tour="${esc(h.tournament)}"><div class="ic">${ICON.link}</div><h2>Join that one</h2><div class="muted">Recommended. This PC becomes a board of ${esc(h.tournament)}.</div></button>
        <button class="choice" data-act="wizard"><div class="ic">${ICON.trophy}</div><h2>Host a separate one</h2><div class="muted">For a second, independent event on the same network.</div></button></div>
        <div class="row" style="margin-top:20px"><button class="btn danger" data-act="end-at" data-addr="${esc(h.address)}" data-tour="${esc(h.tournament)}">End ${esc(h.tournament)}</button><span class="muted small">Ends it on ${esc(h.name)} and every board. For when the host's screen is out of reach.</span></div>`;
    }
    return `<div class="ph"><div><h1>Local Tournament</h1><div class="sub">Run a tournament on your own boards. Every match is a normal local game.</div></div><div class="r"><button class="btn sec sm" data-act="help">How it works</button></div></div>
      <div class="grid2">
        <button class="choice" data-act="host"><div class="ic">${ICON.trophy}</div><h2>Host a tournament here</h2><div class="muted">This PC runs the tournament: players, bracket and boards. It can also play matches on its own board.</div></button>
        <button class="choice" data-act="screen" data-v="join"><div class="ic">${ICON.link}</div><h2>Join a tournament</h2><div class="muted">This board plays the matches another PC hands out. Results are sent back automatically.</div></button>
      </div>
      <div class="card" style="margin-top:16px"><div class="row"><span class="muted">This PC is called</span><input id="pcname" value="${esc(data.node.name)}" style="width:220px"><button class="btn sec sm" data-act="rename">Save</button></div></div>
      <div class="note">The PC where you press <b>Host</b> becomes the host. Only one host per network: AutoGlow checks before it starts.</div>`;
  }

  // ---------------------------------------------------------------------------
  // Lobby: "Host a tournament" opens it at once. Rules, players and the boards that have joined
  // are on one screen; Start builds the bracket.
  // ---------------------------------------------------------------------------
  const FORMATS = [['single_ko', 'Single KO', 'Lose once and you’re out. Byes for odd counts.', '2–32 players'],
    ['double_ko', 'Double KO', 'Out after the second loss. Winners and losers bracket.', '2–32 players'],
    ['groups', 'Groups → KO', 'Round robin groups, the best go on to a knockout.', '4–32 players'],
    ['league', 'League', 'Everyone plays everyone. One table decides.', '2–16 players'],
    ['swiss', 'Swiss', 'Fixed rounds, players paired by points.', '4–32 players']];
  const DEFAULT_SETTINGS = { base_score: 501, in_mode: 'Straight', out_mode: 'Double', legs: 2, sets: 0, bull_off: 'Normal' };
  /** A small drawing of each format for the mode cards */
  const MODE_ART = {
    single_ko: '<path d="M8 12h22v14H8M8 48h22V34H8M30 19h20v30H30M8 62h22v-6M30 30h0M50 34h22"/><path d="M8 26h22M8 34h22" opacity=".35"/>',
    double_ko: '<path d="M8 8h20v12H8M28 14h18v20H28M8 28h20v12H8M46 24h26"/><path d="M8 50h20v14H8M28 57h18v-23" stroke-dasharray="4 4"/>',
    groups: '<rect x="6" y="8" width="26" height="24" rx="4"/><rect x="6" y="40" width="26" height="24" rx="4"/><path d="M12 16h14M12 24h14M12 48h14M12 56h14" opacity=".5"/><path d="M32 20h14v32H32M46 36h26"/>',
    league: '<rect x="8" y="8" width="64" height="56" rx="5"/><path d="M8 22h64M8 36h64M8 50h64M24 8v56" opacity=".5"/>',
    swiss: '<path d="M8 12h14M8 22h14M8 42h14M8 52h14M33 12h14M33 22h14M33 42h14M33 52h14M58 12h14M58 22h14M58 42h14M58 52h14"/><path d="M22 12l11 10M22 22l11-10M47 12l11 30M47 42l11-30" opacity=".45"/>',
  };
  const avColor = n => `hsl(${[...n].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 55% 38%)`;
  const avatar = n => `<span class="av" style="background:${avColor(n.trim().toLowerCase())}">${esc((n.trim()[0] || '?').toUpperCase())}</span>`;

  /** Step 1 of hosting: how the tournament is played */
  function modePage() {
    return `<div class="ph"><div><h1>Host a tournament</h1><div class="sub">How is it played? Rules and players come next, and everything can still be changed in the lobby.</div></div><div class="r"><button class="btn sec sm" data-act="screen" data-v="start">← Back</button></div></div>
      <div class="modes">${FORMATS.map(([k, n, d, ps]) => `<button class="mode" data-act="mode" data-v="${k}"><svg viewBox="0 0 80 72" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" preserveAspectRatio="xMidYMid meet">${MODE_ART[k]}</svg><b>${n}</b><span class="muted">${d}</span><span class="small">${ps}</span></button>`).join('')}</div>
      <div class="note">Every match is a normal local X01 game in Autodarts, on as many boards as you have.</div>`;
  }

  /** The organizer's copy, taken from AutoGlow once per lobby (another PC may have opened it) */
  function lobbyState(t) {
    if (lob && lob.tid === t.id) return lob;
    const s = t.lobby || {};
    lob = { tid: t.id, name: s.name || t.name, format: s.format || 'single_ko', groups: s.groups || 0, advance: s.advance || 2, swiss_rounds: s.swiss_rounds || 0,
      return_round: !!s.return_round, ko_legs: s.ko_legs || 0, semi_legs: s.semi_legs || 0, final_legs: s.final_legs || 0, settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
      players: (s.players || []).map(p => ({ name: p.name, ad_name: p.ad_name || '', visitor: !!p.visitor, member: p.member || '', phone: p.phone || 0 })), roster: null, visitor: false, rulesOpen: false,
      phone_signup: !!s.phone_signup, phoneSeen: s.phone_count || 0, qr: null };
    clubApi('members').then(r => { lob.roster = r.players || []; }, () => { lob.roster = []; }).then(() => { if (!typing()) { lastJson = ''; render(); } });
    return lob;
  }
  function spec() {
    const l = lob;
    return { name: l.name, format: l.format, groups: +l.groups, advance: +l.advance, swiss_rounds: +l.swiss_rounds,
      settings: { ...l.settings, base_score: +l.settings.base_score, legs: +l.settings.legs, sets: +l.settings.sets },
      semi_legs: +l.semi_legs, final_legs: +l.final_legs, ko_legs: +l.ko_legs, return_round: !!l.return_round,
      phone_signup: !!l.phone_signup, phone_seen: l.phoneSeen,
      players: l.players.map((p, i) => ({ name: p.name, ad_name: p.ad_name, visitor: !!p.visitor, member: p.member, phone: p.phone || 0, seed: i + 1 })) };
  }
  /** Players who signed up on their phone go into the organizer's list (once: a removed one stays out) */
  function takePhoneSignups() {
    const t = T();
    if (!lob || !t || t.status !== 'lobby' || lob.tid !== t.id || data.role !== 'host') return;
    const fresh = ((t.lobby || {}).players || []).filter(p => p.phone > lob.phoneSeen).sort((a, b) => a.phone - b.phone);
    if (!fresh.length) return;
    for (const p of fresh) {
      lob.phoneSeen = Math.max(lob.phoneSeen, p.phone);
      if (!lob.players.some(q => q.name.trim().toLowerCase() === p.name.trim().toLowerCase())) addPlayer(p.name, { phone: p.phone });
    }
    flash(`${fresh.map(p => p.name).join(', ')} signed up by phone`);
    lastJson = '';
    saveLobby(true);
  }
  let saveTimer = 0;
  /** Send the lobby to AutoGlow (joined boards see it too); text fields wait until typing pauses */
  function saveLobby(now) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { data = await api('lobby', spec()); error = ''; } catch (e) { error = e.message; }
      if (typing()) { paintLobbyBoards(); paintStartBar(); } else { lastJson = ''; render(); }
    }, now ? 0 : 500);
  }
  const opt = (vals, cur) => vals.map(v => `<option ${String(v) === String(cur) ? 'selected' : ''}>${v}</option>`).join('');
  const optKV = (vals, cur) => vals.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('');
  const firstTo = same => [[0, same], ...[2, 3, 4, 5, 6, 7].map(n => [n, `First to ${n}`])];

  /** One line for the rules: format, game and match length */
  function rulesLine(r) {
    const s = r.settings || DEFAULT_SETTINGS;
    const len = s.sets ? `first to ${s.sets} set${s.sets > 1 ? 's' : ''} (${s.legs} legs each)` : `first to ${s.legs} leg${s.legs > 1 ? 's' : ''}`;
    const extra = [r.format === 'groups' ? `${+r.groups ? `${r.groups} groups` : 'groups of about 4'}, ${r.advance} go through` : '', r.return_round ? 'return round' : '',
      +r.final_legs ? `final first to ${r.final_legs}` : ''].filter(Boolean);
    return `${esc(FORMAT_NAME[r.format] || '')} · X01 ${s.base_score} · ${esc(s.in_mode)} in · ${esc(s.out_mode)} out · ${len}${extra.length ? ` · ${esc(extra.join(' · '))}` : ''}`;
  }

  function lobbyPage(t) {
    const l = lobbyState(t);
    return `<div class="ph"><div><input class="title-in" data-l="name" value="${esc(l.name)}" title="Click to rename" maxlength="60"><div class="sub">Lobby on ${esc(data.node.name)} · boards on your network can join now</div></div>
        <div class="r"><button class="btn sec sm" data-act="help">How it works</button><button class="btn danger sm" data-act="lcancel">Close lobby</button></div></div>
      ${rulesCard(l)}
      <div class="lobby">${playersCard(l)}<div class="side"><div class="card" id="lboards">${lobbyBoards(t, true)}</div>${phoneCard(l)}</div></div>
      <div class="card startbar" id="lstart">${startBar(t)}</div>`;
  }

  /** Folded: one line. Unfolded: every setting, the format too */
  function rulesCard(l) {
    const s = l.settings, f = l.format;
    const body = !l.rulesOpen ? '' : `<div class="body"><div class="ff">
      <label>Format<select data-l="format">${optKV(FORMATS.map(([k, n]) => [k, n]), f)}</select></label>
      ${f === 'groups' ? `<label>Groups<select data-l="groups">${optKV([[0, 'Automatic'], ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, n])], l.groups)}</select></label>
        <label>Advance per group<select data-l="advance">${opt([1, 2, 3, 4], l.advance)}</select></label>` : ''}
      ${f === 'swiss' ? `<label>Rounds<select data-l="swiss_rounds">${optKV([[0, 'Automatic'], ...[2, 3, 4, 5, 6, 7].map(n => [n, n])], l.swiss_rounds)}</select></label>` : ''}
      <label>Base score<select data-s="base_score">${opt([301, 501, 701], s.base_score)}</select></label>
      <label>In<select data-s="in_mode">${opt(['Straight', 'Double', 'Master'], s.in_mode)}</select></label>
      <label>Out<select data-s="out_mode">${opt(['Straight', 'Double', 'Master'], s.out_mode)}</select></label>
      <label>Legs (first to)<select data-s="legs">${opt([1, 2, 3, 4, 5, 6, 7], s.legs)}</select></label>
      <label>Sets (first to)<select data-s="sets">${optKV([[0, 'No sets'], ...[1, 2, 3, 4, 5].map(n => [n, n])], s.sets)}</select></label>
      <label>Bull-off<select data-s="bull_off">${optKV([['Off', 'Off'], ['Normal', 'WDF'], ['Official', 'PDC']], s.bull_off)}</select></label>
      ${f === 'groups' ? `<label>Knockout<select data-l="ko_legs">${optKV(firstTo('Same as groups'), l.ko_legs)}</select></label>` : ''}
      ${f === 'league' || f === 'swiss' ? '' : `<label>Semi-finals<select data-l="semi_legs">${optKV(firstTo('Same'), l.semi_legs)}</select></label>
        <label>Final<select data-l="final_legs">${optKV(firstTo('Same'), l.final_legs)}</select></label>`}
      ${f === 'groups' || f === 'league' ? `<label class="w ck"><input type="checkbox" data-l="return_round" ${l.return_round ? 'checked' : ''}> Return round: every pairing plays twice, the other player throws first</label>` : ''}
      </div><div class="small muted" style="margin-top:14px">${esc((FORMATS.find(x => x[0] === f) || [])[2] || '')} ${s.sets ? 'Legs are per set; the rounds count sets. ' : ''}The match length can still be changed while the tournament runs.</div></div>`;
    return `<div class="card rules ${l.rulesOpen ? 'open' : ''}"><button data-act="rules"><span class="k">Rules</span><span class="v">${rulesLine(l)}</span><span class="ed">${l.rulesOpen ? 'Done' : 'Change'} <i>▾</i></span></button>${body}</div>`;
  }

  function playersCard(l) {
    const taken = new Set(l.players.map(p => p.name.trim().toLowerCase()));
    const free = (l.roster || []).filter(m => !taken.has(m.name.trim().toLowerCase()));
    const tag = (p, i) => (p.member ? '<span class="tag mem" title="Club member: the games count for their stats">★ Member</span>'
      : `<button class="tag ${p.visitor ? 'vis' : ''}" data-act="pvis" data-i="${i}" title="${p.visitor ? 'Visitor: no club profile. Click to give them one.' : 'Gets a club profile when the tournament starts. Click to make them a visitor.'}">${p.visitor ? 'Visitor' : 'New profile'}</button>`);
    const sub = p => [p.ad_name && p.ad_name.toUpperCase() !== p.name.toUpperCase() ? `in Autodarts: ${esc(p.ad_name)}` : '', p.phone ? 'signed up by phone' : ''].filter(Boolean).join(' · ');
    return `<div class="card"><h3>Players <span class="chip">${l.players.length} / 32</span></h3>
      <div class="addbar"><input id="pnew" placeholder="Type a name and press Enter"><label class="sw" title="Visitors get no club profile"><input type="checkbox" id="pvisnew" ${l.visitor ? 'checked' : ''}><span></span>Visitor</label><button class="btn" data-act="padd">Add</button><button class="btn sec sm" data-act="ppaste">Paste a list…</button></div>
      ${l.roster && l.roster.length && free.length ? `<div class="club"><span class="lbl">From the club</span>${free.map(m => `<button class="pick" data-act="radd" data-v="${esc(m.id)}">${avatar(m.name)}${esc(m.name)}${m.summary && m.summary.games ? ` <span class="muted">${m.summary.average.toFixed(1)}</span>` : ''}</button>`).join('')}
        ${free.length > 1 ? '<button class="btn sec sm" data-act="radd-all">Add all</button>' : ''}</div>` : ''}
      <div class="plist">${l.players.length ? l.players.map((p, i) => `<div class="prow"><span class="n">${i + 1}</span>${avatar(p.name)}<div class="who"><b>${esc(p.name)}</b>${sub(p) ? `<span>${sub(p)}</span>` : ''}</div>${tag(p, i)}
          <span class="act"><button class="ib" data-act="pedit" data-i="${i}" title="Edit">✎</button><button class="ib" data-act="pup" data-i="${i}" title="Seed higher" ${i ? '' : 'disabled'}>↑</button><button class="ib" data-act="pdel" data-i="${i}" title="Remove">✕</button></span></div>`).join('')
        : '<div class="muted" style="padding:28px 0;text-align:center">No players yet. Type a name above or pick club members.</div>'}</div>
      ${l.players.length > 1 ? `<div class="seedbar">Seeding is the list order<span style="flex:1"></span><button class="btn sec sm" data-act="pshuffle">Shuffle</button>${l.roster && l.roster.length ? '<button class="btn sec sm" data-act="rseed">By club average</button>' : ''}</div>` : ''}
      </div>`;
  }

  /** Optional: a QR code players scan to put themselves on the list (phone on the same network) */
  function phoneCard(l) {
    if (l.phone_signup && !l.qr) {
      l.qr = 'loading';
      api('signup-qr').then(r => { l.qr = r; }, e => { l.qr = null; flash(e.message || 'Could not make the QR code'); })
        .then(() => { if (!typing()) { lastJson = ''; render(); } });
    }
    const qr = l.qr && l.qr.svg ? `<div class="qrbox" role="img" aria-label="QR code to sign up">${l.qr.svg}</div><div class="small muted" style="text-align:center;margin-top:8px">Scan with a phone on the same network.<br>${esc(l.qr.url)}</div>` : '';
    return `<div class="card"><h3 style="margin-bottom:${l.phone_signup ? 14 : 0}px">Phone sign-up<span style="flex:1"></span><label class="sw" title="Players scan a QR code to put themselves on the list"><input type="checkbox" data-l="phone_signup" ${l.phone_signup ? 'checked' : ''}><span></span></label></h3>
      ${l.phone_signup ? qr : '<div class="small muted" style="margin-top:8px">Show a QR code: players scan it and put themselves on the list.</div>'}</div>`;
  }

  /** Who has joined, like a game lobby. The host can switch a board's playing on or off, or remove it */
  function lobbyBoards(t, host) {
    const bs = (t.boards || []).filter(b => b.approved && !b.left).sort((a, b) => a.number - b.number);
    return `<h3>Boards <span class="chip">${bs.length}</span></h3>
      ${bs.map(b => `<div class="slot"><span class="num">${b.number}</span><div class="t"><b>${esc(b.name)}</b><span class="small muted"><span class="dot ${b.online ? '' : 'off'}"></span>${b.online ? 'Ready' : 'Offline'}${b.this_pc ? ' · this PC' : ''}${b.plays ? '' : ' · only runs it'}</span></div>
        ${host ? `<label class="sw go" title="Plays matches"><input type="checkbox" data-act-change="plays" data-node="${esc(b.node_id)}" ${b.plays ? 'checked' : ''}><span></span></label>${b.this_pc ? '' : `<button class="ib" data-act="reject" data-node="${esc(b.node_id)}" title="Remove this board">✕</button>`}` : ''}</div>`).join('')}
      <div class="slot empty"><span class="num pulse">+</span><div class="t small">${host ? 'Waiting for boards…<br>On another board’s PC: <b style="color:#fff">Local Tournament → Join</b>' : 'More boards can still join.'}</div></div>
      ${host ? '<div class="small muted" style="margin-top:4px">One board is enough: every match is then played here, one after the other.</div>' : ''}`;
  }

  function startBar(t) {
    const c = t.lobby_check || {};
    const playing = (t.boards || []).filter(b => b.approved && b.plays && !b.left).length;
    const fmt = FORMAT_NAME[(lob && lob.format) || t.format];
    const why = !c.ok ? c.error : !playing ? 'No board plays: switch one on under Boards.' : '';
    return `<div style="flex:1;min-width:220px"><b style="font-size:16px">${esc(fmt)} · ${(t.players || []).length} players${c.ok ? ` · ${c.matches} matches` : ''} · ${playing} board${playing === 1 ? '' : 's'}</b>
        <div class="small ${why ? '' : 'muted'}" style="${why ? 'color:#f3e3a0' : ''}">${why ? esc(why) : 'Ready. Boards get their first matches when you start.'}</div></div>
      <button class="btn" data-act="lstart" ${why ? 'disabled' : ''}>🏆 Start tournament</button>`;
  }

  function paintLobbyBoards() {
    const t = T(), el = root.getElementById('lboards');
    if (el && t && t.status === 'lobby') el.innerHTML = lobbyBoards(t, data.role === 'host');
  }
  function paintStartBar() {
    const t = T(), el = root.getElementById('lstart');
    if (el && t && t.status === 'lobby') el.innerHTML = startBar(t);
  }

  /** A board in the lobby sees what the host has set up, and waits for the start */
  function lobbyWaiting(t) {
    return `<div class="note" style="margin:0 0 16px"><span class="pulse">⏳</span> Waiting for <b>${esc(data.join.host_name || 'the host')}</b> to start the tournament. This board gets its matches by itself.</div>
      <div class="card rules"><button style="cursor:default"><span class="k">Rules</span><span class="v">${rulesLine(t.lobby || t)}</span></button></div>
      <div class="lobby"><div class="card"><h3>Players <span class="chip">${(t.players || []).length}</span></h3><div class="plist">${(t.players || []).map((p, i) => `<div class="prow"><span class="n">${i + 1}</span>${avatar(p.name)}<div class="who"><b>${esc(p.name)}</b></div>${p.visitor ? '<span class="tag vis" style="cursor:default">Visitor</span>' : ''}</div>`).join('') || '<div class="muted" style="padding:20px 0">No players yet.</div>'}</div></div>
      <div class="card" id="lboards">${lobbyBoards(t, false)}</div></div>`;
  }

  function addPlayer(name, extra) {
    const n = name.trim();
    if (!n) return false;
    if (lob.players.length >= 32) { flash('At most 32 players'); return false; }
    if (lob.players.some(p => p.name.trim().toLowerCase() === n.toLowerCase())) { flash(`${n} is already in`); return false; }
    // A typed name that is a club member is that member
    const m = !extra.member && (lob.roster || []).find(x => x.name.trim().toLowerCase() === n.toLowerCase());
    lob.players.push({ name: n, ad_name: '', visitor: false, member: '', ...extra, ...(m ? { member: m.id, visitor: false, ad_name: m.alias || '' } : {}) });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Running tournament: every PC, the host too, opens on its board view: Start game on top, the whole
  // bracket below. The host has no extra page: what needs its hand comes up as a line on top, and a
  // tap on a match there enters or corrects its result.
  // ---------------------------------------------------------------------------
  function pageHead(t, hostName, right) {
    const done = t.matches.filter(m => m.state === 'done').length;
    const who = data.role === 'host' ? `Hosted by <b style="color:#fff">${esc(data.node.name)}</b> (this PC)` : `Hosted by ${hostName} · this PC is <b style="color:#fff">${esc(data.node.name)}</b>`;
    return `<div class="ph"><div><h1>${esc(t.name)}</h1><div class="sub">${who} · ${FORMAT_NAME[t.format]} · ${t.players.length} players · ${done}/${t.matches.length} played${t.status === 'finished' ? ' · finished' : ''}</div></div>
      <div class="r">${right}</div></div>`;
  }

  /** A board that doesn't play gets no Start game, only the bracket */
  function playsHere(t) {
    const me = (t.boards || []).find(b => b.node_id === data.node.id);
    return !me || me.plays;
  }

  /** Groups, league and Swiss have tables too; they open from the header */
  function viewButtons(t, cur) {
    if (!['groups', 'league', 'swiss'].includes(t.format)) return '';
    return cur === 'bracket' ? '<button class="btn sm" data-act="tab" data-v="mine">← Back</button>'
      : `<button class="btn sec sm" data-act="tab" data-v="bracket">${t.format === 'league' ? 'Table' : 'Tables'}</button>`;
  }

  /** Everything rarely needed sits behind one ⋯ button */
  let menuOpen = false;
  function moreMenu(items) {
    return `<span class="more"><button class="btn sec sm" data-act="menu" aria-label="More">⋯</button>${menuOpen ? `<div class="menu">${items}</div>` : ''}</span>`;
  }

  function hostPage() {
    const t = T();
    if (t.status === 'lobby') return lobbyPage(t);
    const more = '<button class="mi" data-act="help">How it works</button><button class="mi" data-act="tv">TV dashboard</button><button class="mi danger" data-act="end">End tournament</button>';
    return pageHead(t, '', `<span class="chip ok"><span class="d"></span>Hosting</span>${viewButtons(t, tab.host)}${moreMenu(more)}`)
      + (tab.host === 'bracket' ? bracketHTML(t) : thisBoard());
  }

  /** Host: a line for each live match AutoGlow can't follow any more, so its result can be typed in */
  function alerts(t) {
    const lines = t.matches.filter(m => m.state === 'live').map((m) => {
      const b = t.boards.find(x => x.node_id === m.board);
      if (!b || (b.online && (b.status || {}).bridge !== false)) return '';
      const l = m.last_live && m.last_live.legs;
      const what = b.online ? `Autodarts is closed on ${esc(boardName(b.node_id))}` : `${esc(boardName(b.node_id))} went offline`;
      return `<div class="card alert"><span>${what} during <b>${sideName(m, 0)} vs ${sideName(m, 1)}</b>${l ? ` (${l[0]} – ${l[1]})` : ''}</span><button class="btn sm yb" data-act="result" data-m="${esc(m.id)}">Enter result</button><button class="btn sec sm" data-act="replay" data-m="${esc(m.id)}">Play again</button></div>`;
    });
    if (t.status === 'running' && !t.boards.some(b => b.approved && b.plays && !b.left)) {
      lines.push('<div class="card alert"><span>No board plays matches yet. On a board PC, open <b>Local Tournament → Join a tournament</b>.</span></div>');
    }
    return lines.join('');
  }

  // ---------------------------------------------------------------------------
  // Board
  // ---------------------------------------------------------------------------
  function boardPage() {
    const j = data.join;
    const status = {
      connecting: ['warn', 'Connecting to the host…'], offline: ['warn', 'Host not reachable, retrying'], waiting: ['warn', 'Waiting for the host to approve this board'],
      approved: ['ok', 'Connected to host'], rejected: ['', 'Not accepted'], ended: ['', 'Tournament ended'],
    }[j.status] || ['', j.status];
    const t0 = T();
    const views = t0 && t0.matches && t0.status !== 'lobby' && (j.status === 'approved' || j.status === 'offline') ? viewButtons(t0, tab.board) : '';
    const right = `<span class="chip ${status[0]}"><span class="d"></span>${status[1]}</span>${views}${moreMenu(`<button class="mi" data-act="help">How it works</button><button class="mi danger" data-act="leave">Leave</button><button class="mi danger" data-act="end-at" data-addr="" data-tour="${esc((T() || {}).name || 'the tournament')}">End tournament</button>`)}`;
    // Before the bracket exists there are no counts to show yet
    let h = t0 && t0.status !== 'lobby' && t0.matches ? pageHead(t0, `<b style="color:#fff">${esc(j.host_name || j.address)}</b>`, right)
      : `<div class="ph"><div><h1>${esc(j.tournament_name || 'Local Tournament')}</h1><div class="sub">Hosted by ${esc(j.host_name || j.address)} · this PC is <b style="color:#fff">${esc(data.node.name)}</b></div></div><div class="r">${right}</div></div>`;
    if (j.status === 'rejected' || j.status === 'ended') {
      return h + `<div class="card"><h3>${esc(status[1])}</h3><div class="muted">${esc(j.reason || '')}</div><div style="margin-top:12px"><button class="btn sec" data-act="leave">OK</button></div></div>`;
    }
    if (!T()) {
      return h + `<div class="card"><h3>${j.status === 'waiting' ? 'Almost there' : 'Connecting'}</h3><div class="muted">${j.status === 'waiting' ? 'Ask the organizer to press <b style="color:#fff">Approve</b> for this board on the host.' : `Trying to reach ${esc(j.address)}.`}</div></div>`;
    }
    if (j.status === 'offline') {
      h += j.can_take_over
        ? `<div class="card" style="margin-bottom:16px;border-color:#f7d45855"><h3>The host is gone</h3><div class="muted">${esc(j.host_name || j.address)} hasn't answered for ${Math.round(j.offline_for / 60) || 1} min, and AutoGlow didn't find it anywhere on the network. Matches on the boards go on; results wait here.<br>If the host won't be back, this PC can carry on as the host: it has a copy of the whole tournament, and the other boards find it by themselves. Only do this on <b style="color:#fff">one</b> board.</div><div class="row" style="margin-top:12px"><button class="btn" data-act="take-over">Take over as host</button></div></div>`
        : `<div class="note warn" style="margin:0 0 16px">The host ${esc(j.host_name || j.address)} isn't answering${j.offline_for ? ` (${j.offline_for} s)` : ''}. AutoGlow keeps trying and searches the network for it. Play on: results wait here until it's back.</div>`;
    }
    if (T().status === 'lobby') return h + lobbyWaiting(T());
    return h + (tab.board === 'mine' ? thisBoard() : bracketHTML(T()));
  }

  // ---------------------------------------------------------------------------
  // This board: the picked match on top with Start, the current round below as boxes to tap
  // ---------------------------------------------------------------------------
  let picked = null; // a match tapped on this board, until it starts or can't be played

  // Bracket strips, left to right; the grand final ends the winners' strip
  const STRIPS = [['main'], ['wb', 'gf'], ['lb'], ['group'], ['swiss'], ['ko']];
  let bracketSide = null; // double KO: 'wb' or 'lb' as tapped; null = the side of this board's match

  /** The whole bracket, laid out by stage and round, each match with what a tap does (pick it, or
   *  why it can't be picked). Matches still waiting for their players are greyed out. */
  function bracketBoxes(t) {
    const me = (t.boards || []).find(b => b.node_id === data.node.id);
    const mine = t.matches.find(m => (m.state === 'assigned' || m.state === 'live') && m.board === data.node.id);
    const canPick = me && me.approved && me.plays && !me.left && t.status === 'running' && !(mine && mine.state === 'live');
    const shown = t.matches.filter(m => m.state !== 'skipped' && !m.sides.some(s => s.bye));
    // Players already on a board (not counting the match this board would give back)
    const onBoard = {};
    for (const m of t.matches.filter(x => (x.state === 'assigned' || x.state === 'live') && x !== (mine && mine.state === 'assigned' ? mine : null))) {
      for (const s of m.sides) if (s.player) onBoard[s.player] = m;
    }
    const box = (m) => {
      if (m.state === 'pending' || !m.sides.every(s => s.player)) {
        return { m, kind: 'no', why: m.sides.some(s => !s.player && (s.from || '').startsWith('G:')) ? 'Starts when the groups are done' : 'Waiting for earlier results' };
      }
      if (m.state === 'done') {
        const r = m.result;
        return { m, kind: 'done', why: r && !r.walkover ? `${pname(m.sides[r.winner].player)} won ${Math.max(...r.legs)}:${Math.min(...r.legs)}` : '' };
      }
      const clashSide = m.sides.find(s => onBoard[s.player] && onBoard[s.player] !== m);
      const clash = clashSide && onBoard[clashSide.player];
      let kind = 'pick', why = '';
      if (m === mine) kind = m.state === 'live' ? 'live' : 'pick';
      else if (m.state === 'live') { kind = 'live'; why = `${pname(m.sides[0].player)} vs ${pname(m.sides[1].player)} is on ${boardName(m.board)}`; }
      else if (m.state === 'assigned') { kind = 'no'; why = `Being set up on ${boardName(m.board)}`; }
      else if (m.held) { kind = 'no'; why = 'On hold'; }
      else if (clash) { kind = 'no'; why = `${pname(clashSide.player)} is ${clash.state === 'live' ? 'playing' : 'about to play'} on ${boardName(clash.board)}`; }
      else if (!canPick) { kind = 'no'; why = mine && mine.state === 'live' ? 'Finish this match first' : 'This board can\'t take matches right now'; }
      return { m, kind, why };
    };
    const boxes = shown.map(box);
    const stages = STRIPS.filter(sts => boxes.some(x => sts.includes(x.m.stage))).map(sts => ({
      key: sts[0],
      cols: sts.flatMap((st) => {
        const xs = boxes.filter(x => x.m.stage === st);
        const rounds = [...new Set(xs.map(x => x.m.round))].sort((p, q) => p - q);
        return rounds.map((r) => {
          const col = xs.filter(x => x.m.round === r).sort((p, q) => p.m.order - q.m.order);
          return { label: col[0].m.label.replace(/^Group \S+ · /, ''), boxes: col, cur: col.some(x => x.kind === 'pick' || x.kind === 'live') };
        });
      }),
      // The losers' side opens once its first players are known
      started: boxes.some(x => sts.includes(x.m.stage) && x.m.sides.some(sd => sd.player)),
    }));
    // The free ones in the order AutoGlow hands them out
    const order = Object.fromEntries((t.up_next || []).map((id, i) => [id, i]));
    const pickable = boxes.filter(x => x.kind === 'pick').map(x => x.m).sort((p, q) => (p === mine ? -1 : 0) - (q === mine ? -1 : 0) || (order[p.id] ?? 999) - (order[q.id] ?? 999));
    return { stages, mine, pickable };
  }

  /** The match on top: the one tapped, else this board's own, else the first one no other board
   *  lined up (only boards with a lower number count, so two boards never keep swapping) */
  function selected(r) {
    const tapped = r.pickable.find(m => m.id === picked);
    if (tapped) return tapped;
    if (r.mine && r.mine.state === 'assigned') return r.mine;
    const t = T(), me = t && (t.boards || []).find(b => b.node_id === data.node.id);
    const taken = new Set((t ? t.boards || [] : []).filter(b => me && b.number < me.number && b.approved && !b.left && b.pick).map(b => b.pick));
    return r.pickable.find(m => !taken.has(m.id)) || r.pickable[0] || null;
  }

  /** Tell the host (and so every screen) which match this board has lined up */
  let sentPick = null;
  function notePick(id) {
    if (id === sentPick) return;
    sentPick = id;
    api('pick', { match: id }).catch(() => {}); // only a hint: an older AutoGlow has no picks
  }

  function pickBox(x, sel, by) {
    const m = x.m;
    const live = x.kind === 'live' ? liveOf(m) || {} : null;
    const r = m.result;
    const sc = i => (live ? (live.legs || [0, 0])[i] : x.kind === 'done' && r ? (r.walkover ? (i === r.winner ? 'W' : '–') : r.legs[i]) : '');
    const win = x.kind === 'done' && r ? r.winner : -1;
    const mins = live && m.live_at ? Math.max(1, Math.round((Date.now() / 1000 - m.live_at) / 60)) : 0;
    const tag = live ? `${m.board === data.node.id ? 'This board' : esc(boardName(m.board))}${mins ? ` · ${mins}'` : ''}` : '';
    const bs = live || x.kind === 'done' ? [] : linedUp(m, by);
    const cls = x.kind === 'pick' ? '' : x.kind;
    // Still empty: '–', or the group place it waits for
    const nm = i => (m.sides[i].player || (m.sides[i].from || '').startsWith('G:') ? sideName(m, i) : '–');
    return `<div class="pk ${cls}${bs.length ? ' by' : ''}"${bs.length ? ` style="--bc:${boardColor(bs[0])}"` : ''} data-act="pick" data-m="${esc(m.id)}" data-why="${esc(x.why)}">${[0, 1].map(i => `<div class="p ${win === i ? 'w' : ''}"><span>${nm(i)}</span><span class="s">${sc(i)}</span></div>`).join('')}${tag ? `<div class="t">${tag}</div>` : bs.length ? `<div class="t bt">${boardTags(bs, data.node.id)}</div>` : ''}</div>`;
  }

  /** The boards that lined this match up, this one first */
  const linedUp = (m, by) => (by[m.id] || []).slice().sort((p, q) => (q.node_id === data.node.id) - (p.node_id === data.node.id) || p.number - q.number);

  /** A group match on one line: both players, the score in between, and a strip for live or lined up */
  function groupRow(x, by) {
    const m = x.m, r = m.result;
    const live = x.kind === 'live' ? liveOf(m) || {} : null;
    const done = x.kind === 'done' && r;
    const sc = live ? (live.legs || [0, 0]).join(' : ') : done ? (r.walkover ? 'W/O' : r.legs.join(' : ')) : 'vs';
    const bs = live || done ? [] : linedUp(m, by);
    const tag = live ? `<span class="t">● ${m.board === data.node.id ? 'This board' : esc(boardName(m.board))}</span>`
      : bs.length ? `<span class="t bt">${boardTags(bs, data.node.id)}</span>` : '';
    const nm = i => `<span class="${done ? (r.winner === i ? 'w' : 'l') : ''}">${sideName(m, i)}</span>`;
    return `<div class="pk gm ${x.kind === 'pick' ? '' : x.kind}${bs.length ? ' by' : ''}"${bs.length ? ` style="--bc:${boardColor(bs[0])}"` : ''} data-act="pick" data-m="${esc(m.id)}" data-why="${esc(x.why)}">${nm(0)}<span class="s">${sc}</span>${nm(1)}${tag}</div>`;
  }

  /** Groups → KO: which phase it's in, a card per group (table with the cut line, its matches by
   *  round), and the knockout with the group places it waits for. Knockout first once it's on. */
  function groupsView(t, r, by, strip) {
    const real = m => m.state !== 'skipped' && !m.sides.some(s => s.bye);
    const tally = ms => [ms.filter(m => m.state === 'done').length, ms.length];
    const [gd, gn] = tally(t.matches.filter(m => m.stage === 'group' && real(m)));
    const [kd, kn] = tally(t.matches.filter(m => m.stage === 'ko' && real(m)));
    const koOn = gd === gn;
    const bar = `<div class="phase"><span class="${koOn ? 'done' : 'on'}">1 · Groups <b>${gd}/${gn}</b></span><span class="${koOn ? 'on' : ''}">2 · Knockout <b>${kd}/${kn}</b></span></div>`;
    const gs = r.stages.find(x => x.key === 'group');
    const boxes = gs ? gs.cols.flatMap(c => c.boxes) : [];
    const adv = t.advance || 1;
    const cards = (t.tables || []).map((tb) => {
      const xs = boxes.filter(x => x.m.group === tb.name);
      const [pd, pn] = tally(xs.map(x => x.m));
      const rows = tb.rows.map((row, i) => `<tr class="${i < adv ? 'q' : ''}${i === adv - 1 && tb.rows.length > adv ? ' cut' : ''}"><td>${i + 1}</td><td>${esc(row.name)}</td><td>${row.played}</td><td>${row.won}</td><td>${row.lost}</td><td>${row.legs_for}:${row.legs_against}</td></tr>`).join('');
      const rounds = [...new Set(xs.map(x => x.m.round))].sort((p, q) => p - q);
      return `<div class="card gc"><div class="gh"><h3>Group ${esc(tb.name)}</h3><span class="chip ${pd === pn ? 'ok' : ''}">${pd === pn ? 'Done' : `${pd}/${pn} played`}</span></div>
        <table class="gt"><tr><th>#</th><th>Player</th><th>P</th><th>W</th><th>L</th><th>Legs</th></tr>${rows}</table>
        <div class="gr">${rounds.map(rd => `<span class="rn">R${rd}</span><div>${xs.filter(x => x.m.round === rd).sort((p, q) => p.m.order - q.m.order).map(x => groupRow(x, by)).join('')}</div>`).join('')}</div></div>`;
    });
    const n = cards.length;
    const groups = `<div class="gcards" style="--gc:${n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4}">${cards.join('')}</div>`;
    const ko = r.stages.filter(x => x.key === 'ko').map(strip).join('');
    return bar + (koOn ? `${ko}<div class="sect">Groups</div>${groups}` : `${groups}<div class="sect">Knockout</div>${ko}`);
  }

  /** Double KO shows one side at a time: Winners, or Losers once it has players */
  function bracketStrips(r, sel, by) {
    const strip = x => `<div class="bracket pkb">${x.cols.map(c => `<div class="round ${c.cur ? 'cur' : ''}"><h5>${esc(c.label)}</h5><div class="rb">${c.boxes.map(b => pickBox(b, sel, by)).join('')}</div></div>`).join('')}</div>`;
    const t = T();
    if (t && t.format === 'groups') return groupsView(t, r, by, strip);
    const lb = r.stages.find(x => x.key === 'lb');
    const two = lb && lb.started;
    const side = two ? bracketSide || (r.mine && r.mine.stage === 'lb' ? 'lb' : 'wb') : 'wb';
    const sw = two ? `<div class="subtabs" style="margin-top:20px">${[['wb', 'Winners'], ['lb', 'Losers']].map(([k, n]) => `<button data-act="side" data-v="${k}" class="${side === k ? 'on' : ''}">${n}</button>`).join('')}</div>` : '';
    return sw + r.stages.filter(x => x.key !== (side === 'wb' ? 'lb' : 'wb')).map(strip).join('');
  }

  function thisBoard() {
    const t = T();
    const b = data.board;
    const r = t ? bracketBoxes(t) : { stages: [], mine: null, pickable: [] };
    const sel = selected(r);
    // Nothing lined up while this board plays
    const own = b.linked ? '' : sel ? sel.id : '';
    if (t && t.status === 'running') notePick(own);
    const by = t ? lineups(t, own) : {};
    let top = '';
    if (b.linked && b.assignment) {
      const legs = (b.live || {}).legs || [0, 0];
      top = `<div class="vs"><b>${esc(b.assignment.players[0].name)}</b><span class="sc">${legs[0]}</span><span class="x">:</span><span class="sc">${legs[1]}</span><b>${esc(b.assignment.players[1].name)}</b></div><span class="chip live"><span class="d"></span>LIVE</span>`;
    } else if (t && t.champion) {
      top = `<div class="vs"><b style="color:var(--yellow)">🏆 ${esc(pname(t.champion))} wins</b></div>`;
    } else if (sel) {
      top = `<div class="vs"><b>${sideName(sel, 0)}</b><span class="x">VS</span><b>${sideName(sel, 1)}</b></div>${startButton('data-act', sel.id)}`;
    } else if (!t || playsHere(t)) {
      top = `<div class="vs"><b class="muted">Waiting for the next match</b></div>`;
    }
    return (t && data.role === 'host' ? alerts(t) : '') + (top ? `<div class="card banner">${top}</div>` : '')
      + bracketStrips(r, sel, by);
  }

  const HELP_HTML = `<h3>How it works</h3><ol style="margin:0;padding-left:20px;line-height:1.6">
    <li><b>Press Host a tournament</b> and pick how it's played. The lobby opens: players, the boards that joined, and the rules folded into one line (press <b>Change</b> to open them). Everything is saved as you go.</li>
    <li><b>Players:</b> pick club members, or type new names. A new name gets a club profile when the tournament starts, so their games count for their stats. Mark guests as <b>Visitor</b> and they get none.</li>
    <li><b>More boards?</b> Each board needs its own PC with AutoGlow. Open Local Tournament there and choose <b>Join a tournament</b>: it shows up in the lobby right away. One board is enough too: then every match is played here, one after the other.</li>
    <li><b>Press Start tournament.</b> The bracket is built and the boards get their first matches. A board can still join later: it's in at once.</li>
    <li><b>Boards get their matches by themselves.</b> When a board is free, a box pops up on it: who plays next and how to set up the game.</li>
    <li><b>Press ▶ Start game</b> on the board. AutoGlow creates the local X01 game with both players and the match length, starts it and opens the match screen.</li>
    <li><b>Someone isn't there yet?</b> Below Start game is the whole bracket. Tap another open match, then Start game: it comes to this board and the match it had goes back to the others. Faded matches can't be played right now: tap one to see why.</li>
    <li><b>During the match</b> Autodarts' screen shows the round, the race to the winning leg, each player's seed and run so far, and what's at stake. Its own buttons work as always.</li>
    <li><b>Results go to the host by themselves</b> when the match is won, with averages and 180s. Was a board offline? It sends the result when it's back. Autodarts closed during a match? Open it again: the match carries on.</li>
    <li><b>A board is gone?</b> A match it had not started goes to another board after a minute offline (at once when it presses Leave). A match it was playing shows up on top of the host's page: enter the result there, or press <b>Play again</b>.</li>
    <li><b>The host PC is gone?</b> Boards keep playing and search the network for it. After a while a board can <b>Take over as host</b> from its copy of the tournament; the others follow, and the old host becomes a board when it's back.</li>
    <li><b>A result is wrong or missing?</b> On the host, tap the match in the bracket, tap the winner and Save. <b>Walkover</b> is for a player who can't play. The TV dashboard and End tournament are under <b>⋯</b>.</li></ol>
    <div class="row" style="margin-top:14px"><button class="btn" data-act="close">Got it</button></div>`;

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------
  function dialog(html) {
    root.getElementById('dlg').innerHTML = html ? `<div class="dlg"><div class="card">${html}</div></div>` : '';
  }

  /** Host: enter or correct a result. Tap the winner (their legs fill in), tap a number to change it */
  let sheet = null; // {id, to, legs, winner, walkover}
  function resultDialog(id) {
    const m = T().matches.find(x => x.id === id);
    const r = m.result;
    const seen = m.state !== 'done' && m.last_live && m.last_live.legs;
    sheet = { id, to: m.legs_to_win || 1, legs: r && !r.walkover ? r.legs.slice(0, 2) : seen ? seen.slice(0, 2) : [0, 0], winner: r ? r.winner : -1, walkover: !!(r && r.walkover) };
    drawSheet();
  }

  function drawSheet() {
    const m = T().matches.find(x => x.id === sheet.id), s = sheet;
    const tile = i => `<button class="nm ${s.winner === i ? 'win' : ''}" data-act="rwin" data-v="${i}"><span>${sideName(m, i)}</span><b class="leg" data-act="rleg" data-v="${i}">${s.walkover ? (s.winner === i ? 'W' : '–') : s.legs[i]}</b></button>`;
    dialog(`<h3 style="text-align:center">Tap the winner</h3>${m.state === 'done' ? '<div class="small muted" style="text-align:center;margin-top:4px">Later matches that haven\'t started are reset</div>' : ''}
      <div class="row rs">${tile(0)}${tile(1)}</div><div class="small muted" style="text-align:center">Tap a number to change it</div>
      <div class="row" style="margin-top:16px"><button class="btn sec sm ${s.walkover ? 'on' : ''}" data-act="rwo">Walkover</button><span style="flex:1"></span><button class="btn sec" data-act="close">Cancel</button><button class="btn" data-act="rsave">Save</button></div>`);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  // Lobby fields: text is saved when typing pauses; a pick (select, checkbox) at once, and redrawn
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (!lob || !(el.dataset.l || el.dataset.s || el.dataset.k)) return;
    const val = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.l) lob[el.dataset.l] = val;
    if (el.dataset.s) lob.settings[el.dataset.s] = val;
    if (el.dataset.p !== undefined && el.dataset.k) lob.players[+el.dataset.p][el.dataset.k] = val;
    if (typing()) saveLobby(false);
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'pnew') root.querySelector('[data-act="padd"]').click();
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    if (lob && (el.dataset.l || el.dataset.s) && (el.tagName === 'SELECT' || el.type === 'checkbox')) { lastJson = ''; render(); saveLobby(true); }
    if (el.id === 'pvisnew' && lob) lob.visitor = el.checked;
    if (el.dataset.actChange === 'plays') act('plays', { node: el.dataset.node, plays: el.checked });
  });

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    const rerender = () => { lastJson = ''; render(); };
    // The ⋯ menu closes with any click; its own button toggles it
    if (menuOpen || (el && el.dataset.act === 'menu')) { menuOpen = !menuOpen && !!el && el.dataset.act === 'menu'; rerender(); }
    if (!el) return;
    const a = el.dataset.act;
    const v = el.dataset.v;
    if (a === 'tab') { if (data.role === 'host') tab.host = v; else tab.board = v; rerender(); }
    if (a === 'screen') { screen = v; if (v === 'join') scan(); rerender(); }
    if (a === 'rescan') scan();
    if (a === 'host') {
      hosts = null;
      pg.innerHTML = '<div class="card">Checking the network for other hosts…</div>';
      try { hosts = (await api('discover')).hosts; } catch { hosts = []; }
      screen = hosts.some(x => x.tournament) ? 'exists' : 'mode';
      rerender();
    }
    if (a === 'wizard') { screen = 'mode'; rerender(); }
    if (a === 'mode') act('lobby-open', { format: v }, () => { lob = null; screen = 'start'; });
    if (a === 'rules') { lob.rulesOpen = !lob.rulesOpen; rerender(); }
    if (a === 'join') act('join', { address: el.dataset.addr, host_name: el.dataset.host, tournament_name: el.dataset.tour }, () => { screen = 'start'; });
    if (a === 'join-addr') act('join', { address: root.getElementById('addr').value }, () => { screen = 'start'; });
    if (a === 'end-at' && confirm(`End "${el.dataset.tour}" on every board? This can't be undone.`)) {
      act('end-at', { address: el.dataset.addr || '' }, () => { flash('Tournament ended'); screen = 'start'; hosts = null; });
    }
    if (a === 'leave' && (el.textContent.trim() === 'OK' || confirm('Leave the tournament? This board gets no more matches. A match not started yet goes to another board.'))) act('leave', {});
    if (a === 'take-over' && confirm('Carry on the tournament with this PC as the host? Do this on one board only. If the old host comes back, it becomes a board.')) act('take-over', {}, () => flash('This PC is now the host'));
    if (a === 'rename') act('name', { name: root.getElementById('pcname').value });
    // Lobby: every change goes to AutoGlow, so joined boards see the players too
    const changed = () => { rerender(); saveLobby(true); };
    if (a === 'padd') {
      if (addPlayer(root.getElementById('pnew').value, { visitor: lob.visitor })) changed();
      root.getElementById('pnew').focus();
    }
    if (a === 'ppaste') {
      dialog(`<h3>Paste players</h3><div class="muted small" style="margin-bottom:8px">One name per line, best seed first</div><textarea id="plist"></textarea>
        <label class="row small" style="margin-top:10px;color:#e3e5ea"><input type="checkbox" id="plvis" ${lob.visitor ? 'checked' : ''}> All visitors (no club profile)</label>
        <div class="row" style="margin-top:12px"><button class="btn" data-act="ppaste-ok">Add</button><button class="btn sec" data-act="close">Cancel</button></div>`);
    }
    if (a === 'ppaste-ok') {
      const visitor = root.getElementById('plvis').checked;
      root.getElementById('plist').value.split('\n').forEach(n => addPlayer(n, { visitor }));
      dialog('');
      changed();
    }
    if (a === 'radd' || a === 'radd-all') {
      for (const m of (lob.roster || []).filter(m => a === 'radd-all' || m.id === v)) addPlayer(m.name, { ad_name: m.alias || '', member: m.id });
      changed();
    }
    if (a === 'rseed') {
      // Best club average first; players without games here keep their order behind them
      const avg = Object.fromEntries((lob.roster || []).map(m => [m.name.trim().toLowerCase(), (m.summary && m.summary.games && m.summary.average) || 0]));
      lob.players = lob.players.map((p, i) => ({ p, i, a: avg[p.name.trim().toLowerCase()] || 0 })).sort((x, y) => (y.a - x.a) || (x.i - y.i)).map(x => x.p);
      changed();
    }
    if (a === 'pshuffle') { lob.players.sort(() => Math.random() - 0.5); changed(); }
    if (a === 'pup') { const i = +el.dataset.i; if (i > 0) [lob.players[i - 1], lob.players[i]] = [lob.players[i], lob.players[i - 1]]; changed(); }
    if (a === 'pdel') { lob.players.splice(+el.dataset.i, 1); changed(); }
    if (a === 'pvis') { const p = lob.players[+el.dataset.i]; p.visitor = !p.visitor; changed(); }
    if (a === 'pedit') {
      const i = +el.dataset.i, p = lob.players[i];
      dialog(`<h3>Edit player</h3><div class="ff">
        ${p.member ? '' : `<label class="w">Name<input id="pe-name" value="${esc(p.name)}"></label>`}
        <label class="w">Name in Autodarts<input id="pe-ad" value="${esc(p.ad_name)}" placeholder="${esc(p.name.toUpperCase())}"><span class="small muted" style="font-weight:500">Guests: Autodarts writes their name in capitals, which is fine.</span></label>
        ${p.member ? '' : `<label class="w ck"><input type="checkbox" id="pe-vis" ${p.visitor ? 'checked' : ''}> Visitor: no club profile, games not in the club stats</label>`}</div>
        <div class="row" style="margin-top:14px"><button class="btn" data-act="pedit-ok" data-i="${i}">Save</button><button class="btn sec" data-act="close">Cancel</button></div>`);
    }
    if (a === 'pedit-ok') {
      const p = lob.players[+el.dataset.i], vis = root.getElementById('pe-vis'), nm = root.getElementById('pe-name');
      const name = nm ? nm.value.trim() : p.name;
      if (!name || lob.players.some(o => o !== p && o.name.trim().toLowerCase() === name.toLowerCase())) { flash(name ? `${name} is already in` : 'The name is empty'); return; }
      p.name = name;
      p.ad_name = root.getElementById('pe-ad').value.trim();
      if (vis) p.visitor = vis.checked;
      dialog('');
      changed();
    }
    if (a === 'lcancel' && confirm('Close the lobby? Boards that joined are let go.')) { clearTimeout(saveTimer); act('end', {}, () => { lob = null; }); }
    if (a === 'lstart') {
      clearTimeout(saveTimer);
      try { await api('lobby', spec()); } catch (err) { error = err.message; rerender(); return; }
      act('lobby-start', {}, () => {
        const n = data.profiles_added || [];
        flash(data.profiles_error ? `Started, but no club profiles were made: ${data.profiles_error}`
          : n.length ? `Started. New club profile${n.length > 1 ? 's' : ''}: ${n.join(', ')}` : 'Tournament started');
        lob = null;
        // Same page as the boards: Start game on top, the bracket below
        tab.host = 'mine';
      });
    }
    if (a === 'reject') act('approve', { node: el.dataset.node, approve: false });
    if (a === 'claim') act('claim', { match: el.dataset.m }, () => { flash(data.role === 'host' ? 'The match is on this board now' : 'Asked the host for the match…'); tab.host = 'mine'; tab.board = 'mine'; });
    if (a === 'result') resultDialog(el.dataset.m);
    if (a === 'rwin' || a === 'rleg') {
      const i = +v, o = 1 - i, s = sheet;
      if (a === 'rwin') { s.winner = i; s.legs[i] = s.to; if (s.legs[o] >= s.to) s.legs[o] = s.to - 1; } else {
        s.walkover = false;
        s.legs[i] = (s.legs[i] + 1) % (s.to + 1);
        if (s.legs[i] === s.to && s.legs[o] >= s.to) s.legs[o] = s.to - 1;
        s.winner = s.legs[0] === s.to ? 0 : s.legs[1] === s.to ? 1 : -1;
      }
      drawSheet();
    }
    if (a === 'rwo') { sheet.walkover = !sheet.walkover; drawSheet(); }
    if (a === 'rsave') {
      if (sheet.winner < 0) { flash('Tap the winner first'); return; }
      const id = sheet.id;
      dialog('');
      act('result', sheet.walkover ? { match: id, walkover_winner: sheet.winner } : { match: id, legs: sheet.legs });
    }
    if (a === 'close') dialog('');
    if (a === 'help') dialog(HELP_HTML);
    if (a === 'tv') window.open('http://127.0.0.1:8080/tournament/live', '_blank', 'noopener');
    if (a === 'replay') {
      const m = T().matches.find(x => x.id === el.dataset.m);
      if (m && confirm(`Play ${pname(m.sides[0].player)} vs ${pname(m.sides[1].player)} again from the start? The score so far is dropped and the match goes to the next free board.`)) act('replay', { match: m.id });
    }
    if (a === 'start') runStart(false, el.dataset.m);
    if (a === 'side') { bracketSide = v; rerender(); }
    if (a === 'pick') {
      // The host taps a played, running or (when it doesn't play) any match to enter its result
      const t = T(), m = t.matches.find(x => x.id === el.dataset.m);
      const ownTurn = m && m.board === data.node.id && m.state === 'assigned';
      if (data.role === 'host' && m && m.sides.every(sd => sd.player) && !ownTurn && (['done', 'live', 'assigned'].includes(m.state) || (m.state === 'ready' && !playsHere(t)))) resultDialog(m.id);
      else if (el.dataset.why) flash(el.dataset.why);
      else if (!el.classList.contains('done') && !data.board.linked) { picked = el.dataset.m; rerender(); }
    }
    if (a === 'end' && confirm('End the tournament on every board? This can\'t be undone.')) act('end', {});
  });

  async function scan() {
    hosts = null;
    lastJson = '';
    render();
    try { hosts = (await api('discover')).hosts; } catch { hosts = []; }
    lastJson = '';
    render();
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  // Any of Autodarts' own links closes our pages first. Start ("/") seen from "/#autoglow-…" is the
  // same page for Autodarts' router, so it would not navigate and our page would stay.
  document.addEventListener('click', (e) => {
    if (!location.hash.startsWith('#autoglow-') || e.button !== 0) return;
    const path = e.composedPath();
    if (path.some(x => x.hasAttribute && x.hasAttribute('data-autoglow'))) return;
    if (!path.some(x => x.tagName === 'A' && x.getAttribute('href'))) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, true);
  window.addEventListener('popstate', () => { sync(); if (isOpen()) refresh(true); });
  window.addEventListener('hashchange', () => { sync(); if (isOpen()) refresh(true); });
  window.addEventListener('resize', () => { if (isOpen()) placePage(); });
  let lastPath = location.pathname;
  setInterval(() => {
    if (!document.body) return;
    placeNav();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      sync();
    }
    if (isOpen() !== pageHost.isConnected) sync();
    if (isOpen()) placePage();
    if (data) callout();
  }, 500);
  let polling = false;
  setInterval(async () => {
    if (polling || !document.body) return;
    if (!isOpen() && !/^\/matches\//.test(location.pathname) && Date.now() % POLL_CLOSED_MS > POLL_OPEN_MS) return;
    polling = true;
    await refresh(false);
    polling = false;
  }, POLL_OPEN_MS);
})();
