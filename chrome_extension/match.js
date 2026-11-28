// Local Tournament match screen: while this board plays a tournament match, Autodarts' match page
// becomes the tournament's own screen. Autodarts' controls stay where they are and keep working;
// around them: the stage and the legs race, seeds and each player's run so far, what's at stake and
// what's next, a walk-on intro when the match starts, a banner for the winner and a ticker.
// How it looks is set on AutoGlow's Overlay page (web/js/features/overlay.js, src/overlay.rs) on the
// host and comes with the tournament as data.overlay: one of the Dashboard's looks, skin "page"
// (the whole Autodarts page restyled in the look) or "panels" (only the tournament panels), and
// which parts show. Landscape (cards beside the board) and portrait (cards above it) each get their
// own layout and their own parts; a box moved on the Overlay page (overlay[orient].boxes: x, y and
// width in % of the screen, s its size) stands there instead of where the layout puts it. Style:
// panel see-through, corners, motion, the page's background, the active card, the display font.
// The overlay never takes a click, except the intro (a click skips it) and the banner.
// tournament.js hands over AutoGlow's /api/tournament/local answer with window.autoglowMatch(data).
// window.autoglowPreview (web/studio/overlay.html): the Overlay page's preview, where switched-off
// parts show faintly; a click selects a part, a drag moves a box (snapping to the screen's middle and
// edges and to the other boxes), the corner handle sizes it and the side handle widens it.
(() => {
  if (window.autoglowMatch) return;
  // `t` is the tournament here, so the translator is tr
  const { tn, srv } = window.agI18n;
  const tr = window.agI18n.t;
  const de = () => window.agI18n.lang() === 'de';
  const PREVIEW = !!window.autoglowPreview;
  /** "first to 3 legs" */
  const firstTo = (n, sets) => (sets ? tn(n, 'first to {n} set', 'first to {n} sets') : tn(n, 'first to {n} leg', 'first to {n} legs'));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------------------
  // Looks: the Dashboard's TV looks (web/studio/tournament-looks.css) as colours and fonts, plus
  // Autodarts' own. light: a light page, where Autodarts' bars turn dark (the look's ink).
  // ---------------------------------------------------------------------------
  const LOOKS = {
    autodarts: { bg: '#01040b', panel: '#1b1f29', panel2: '#292c33', ink: '#fafafa', muted: '#b5b5b5', line: 'rgb(255 255 255 / .12)', accent: '#0b55df', on: '#fff', gold: '#f7d458', live: '#ff6b84',
      fc: '"Bebas Neue",Manrope,sans-serif', fl: '"Manrope Variable",Manrope,system-ui,sans-serif', rad: 16, act: 'linear-gradient(to right bottom,#75148b,#da3954)', fonts: '' },
    arena: { bg: '#060a14', panel: '#0e1526', panel2: '#1a2440', ink: '#f5f7fc', muted: '#8d9cbd', line: 'rgba(255,255,255,.1)', accent: '#2f7bff', on: '#fff', gold: '#ffc531', live: '#ff3b47',
      fc: '"Barlow Condensed","Arial Narrow",sans-serif', fl: '"Barlow Condensed","Arial Narrow",sans-serif', rad: 12, fonts: 'Barlow+Condensed:wght@500;600;700;800' },
    flap: { bg: '#09090a', panel: '#141416', panel2: '#1f1f23', ink: '#f7f2e4', muted: '#8e8b83', line: 'rgba(255,255,255,.09)', accent: '#ffb000', on: '#111', gold: '#ffb000', live: '#ff4d3d',
      fc: '"Oswald","Arial Narrow",sans-serif', fl: '"JetBrains Mono",monospace', rad: 8, fonts: 'Oswald:wght@500;600;700&family=JetBrains+Mono:wght@500;700' },
    poster: { bg: '#efeae0', panel: '#fffdf8', panel2: '#e6dfd1', ink: '#14110f', muted: '#8a8378', line: 'rgba(20,17,15,.18)', accent: '#ff4a1c', on: '#fff', gold: '#ff4a1c', live: '#ff4a1c',
      fc: '"Anton",Impact,sans-serif', fl: '"Archivo",sans-serif', rad: 0, light: true, fonts: 'Anton&family=Archivo:wght@600;700;800' },
    mono: { bg: '#000', panel: '#0b0b0b', panel2: '#161616', ink: '#fff', muted: '#8a8a8a', line: 'rgba(255,255,255,.2)', accent: '#ffffff', on: '#000', gold: '#fff', live: '#ff4d3d',
      fc: '"Inter Tight","Helvetica Neue",Arial,sans-serif', fl: '"Inter Tight","Helvetica Neue",Arial,sans-serif', rad: 0, fonts: 'Inter+Tight:wght@400;500;700;800' },
    gazette: { bg: '#f4efe4', panel: '#faf6ec', panel2: '#e7dfcd', ink: '#1a1814', muted: '#6b6457', line: 'rgba(26,24,20,.24)', accent: '#c41e1e', on: '#fff', gold: '#c41e1e', live: '#c41e1e',
      fc: '"DM Serif Display",Georgia,serif', fl: '"Libre Franklin","Helvetica Neue",Arial,sans-serif', rad: 0, light: true, fonts: 'DM+Serif+Display&family=Libre+Franklin:wght@600;700' },
    blueprint: { bg: '#0a2a5e', panel: '#0e3878', panel2: '#124389', ink: '#eaf2ff', muted: '#9fc0f5', line: 'rgba(234,242,255,.3)', accent: '#ffd23f', on: '#0b2f6b', gold: '#ffd23f', live: '#eaf2ff',
      fc: '"IBM Plex Sans Condensed","Arial Narrow",sans-serif', fl: '"IBM Plex Mono","Courier New",monospace', rad: 0, grid: true, fonts: 'IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@500;600' },
    pop: { bg: '#ffd60a', panel: '#fffdf5', panel2: '#fff1b8', ink: '#141414', muted: '#5c5a52', line: '#141414', accent: '#2f5bff', on: '#fff', gold: '#141414', live: '#ff6b9d',
      fc: '"Archivo Black","Arial Black",sans-serif', fl: '"Space Grotesk","Segoe UI",sans-serif', rad: 14, light: true, hard: true, fonts: 'Archivo+Black&family=Space+Grotesk:wght@500;700' },
    worldcup: { bg: '#140830', panel: '#24104f', panel2: '#37187f', ink: '#fff', muted: '#c3b1f2', line: 'rgba(255,255,255,.13)', accent: '#f7c948', on: '#140830', gold: '#f7c948', live: '#ff4fa3',
      fc: '"Unbounded","Outfit",sans-serif', fl: '"Outfit","Segoe UI",sans-serif', rad: 20, fonts: 'Unbounded:wght@600;700;800&family=Outfit:wght@500;600;700' },
  };
  const TICKER_H = 36;
  /** Style › display font: [CSS family, Google Fonts family] */
  const FONTS = { bebas: ['"Bebas Neue",sans-serif', 'Bebas+Neue'], oswald: ['"Oswald","Arial Narrow",sans-serif', 'Oswald:wght@500;600;700'],
    anton: ['"Anton",Impact,sans-serif', 'Anton'], unbounded: ['"Unbounded",sans-serif', 'Unbounded:wght@600;700;800'],
    serif: ['"DM Serif Display",Georgia,serif', 'DM+Serif+Display'], black: ['"Archivo Black","Arial Black",sans-serif', 'Archivo+Black'] };
  const CORNERS = { square: 0, soft: 10, round: 24 };
  const TICK_SPEED = { slow: 1.6, normal: 1, fast: 0.6 };

  const host = document.createElement('div');
  host.setAttribute('data-autoglow', 'match');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  :host{all:initial}
  *{box-sizing:border-box}
  .ov{position:fixed;inset:0;pointer-events:none;z-index:40;font:500 14px/1.4 var(--fl);color:var(--ink)}
  .box{position:absolute;opacity:0;transition:opacity .35s,translate .35s,transform .35s;transform-origin:0 0}
  .box.on{opacity:1}
  .m-slide .box:not(.on){translate:0 16px}
  .m-pop .box:not(.on){transform:scale(.9)}
  .m-none .box,.m-none .win{transition:none;animation:none}
  .m-none .intro,.m-none .intro *{animation-name:none!important}
  .m-none .tk .tt{animation-duration:var(--tkd,40s)!important;animation-name:tick!important}
  .hdr.panel.solo{padding:14px 18px}
  .clock{padding:8px 16px;text-align:center}
  .clock .t{font-size:38px;line-height:1;font-variant-numeric:tabular-nums}
  .clock .k{font:800 10px/1.4 var(--fl);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .clock .two{display:flex;gap:16px;justify-content:center}
  .note{padding:10px 18px;font:700 20px/1.25 var(--fl);text-align:center;overflow-wrap:anywhere}
  .glow{border-radius:50%;z-index:-1;box-shadow:0 0 0 3px var(--accent),0 0 60px 6px color-mix(in srgb,var(--accent) 55%,transparent);animation:breathe 3.2s ease-in-out infinite}
  .m-none .glow{animation:none}
  @keyframes breathe{50%{box-shadow:0 0 0 3px var(--accent),0 0 90px 16px color-mix(in srgb,var(--accent) 35%,transparent)}}
  .disp{font-family:var(--fc);font-weight:700;text-transform:uppercase;letter-spacing:.01em}
  .tag{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font:800 11px/1.4 var(--fl);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;
    background:color-mix(in srgb,var(--gold) 15%,transparent);color:var(--gold);border:1px solid color-mix(in srgb,var(--gold) 40%,transparent)}
  .panel{background:var(--glass);border:1px solid var(--line);border-radius:var(--rad);backdrop-filter:blur(8px)}
  .hard .panel{box-shadow:4px 4px 0 var(--ink);border:2px solid var(--ink)}
  img.logo{display:block;object-fit:contain;max-width:200px;max-height:58px;margin-bottom:10px}
  .hdr .name{font:700 13px/1.3 var(--fl);color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hdr .stage{font-size:52px;line-height:.95;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
  .hdr .meta{color:var(--muted);font:600 13px/1.4 var(--fl)}
  .hdr.hero{display:flex;align-items:center;gap:22px;padding:16px 22px}
  .hdr.hero img.logo{margin:0;max-height:84px;max-width:180px}
  .hdr.hero .stage{font-size:58px}
  .hdr .stage.long{font-size:36px;line-height:1.05}
  .hdr.rib{display:flex;align-items:center;justify-content:center;gap:10px;padding:5px 16px;white-space:nowrap;overflow:hidden;border-radius:999px}
  .hdr.rib img.logo{margin:0;max-height:26px;max-width:90px}
  .hdr.rib .disp{font-size:22px;line-height:1.1;overflow:hidden;text-overflow:ellipsis}
  .hdr.rib .meta{white-space:nowrap}
  .race{padding:10px 16px}
  .race .top{display:flex;justify-content:space-between;color:var(--muted);font:800 11px/1.4 var(--fl);letter-spacing:.12em;text-transform:uppercase}
  .race .row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;margin-top:6px}
  .race .pn{font-size:24px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
  .race .pn.act{color:var(--ink)}
  .turn{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);margin:0 8px 4px 0;vertical-align:middle}
  .race .sc{font-size:34px;line-height:1;min-width:26px;text-align:right}
  .pips{display:flex;gap:5px;margin-top:4px;grid-column:1 / -1}
  .pips i{flex:1;max-width:38px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--ink) 12%,transparent)}
  .pips i.w{background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 50%,transparent)}
  .puck{text-align:center;padding:6px 10px 7px;border-radius:calc(var(--rad) + 4px)}
  .puck .st{font:800 10px/1.3 var(--fl);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
  .puck .sc{display:flex;justify-content:center;align-items:center;gap:10px;font-size:34px;line-height:1;margin-top:2px}
  .puck .sc i{font-style:normal;color:var(--muted);font-size:22px}
  .puck .sc .lead{color:var(--accent)}
  .puck .ft{font:700 11px/1.3 var(--fl);color:var(--muted);white-space:nowrap}
  .frame{border:2px solid color-mix(in srgb,var(--gold) 40%,transparent);border-radius:calc(var(--rad) + 2px);box-shadow:0 0 0 1px #00000040,0 0 26px color-mix(in srgb,var(--gold) 14%,transparent) inset}
  .frame.act{border-color:var(--gold);box-shadow:0 0 0 1px #00000040,0 0 30px color-mix(in srgb,var(--gold) 34%,transparent),0 0 26px color-mix(in srgb,var(--gold) 20%,transparent) inset}
  .skin .frame{border-color:transparent;box-shadow:none}
  .skin .frame.act{border-color:var(--accent);box-shadow:0 0 34px color-mix(in srgb,var(--accent) 45%,transparent)}
  .seed{position:absolute;top:-12px;left:16px;background:var(--bg);border:1px solid color-mix(in srgb,var(--gold) 55%,transparent);color:var(--gold);border-radius:999px;padding:2px 10px;font:800 11px/1.4 var(--fl);letter-spacing:.1em;white-space:nowrap}
  .card{padding:12px 14px;overflow:hidden}
  .card h4{margin:0 0 6px;font:800 11px/1.4 var(--fl);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chips span{font:700 12px/1.5 var(--fl);padding:2px 8px;border-radius:7px;background:color-mix(in srgb,var(--ink) 7%,transparent);white-space:nowrap}
  .chips span.w{background:#2fbf7124;color:#3fcf86}.chips span.l{background:#ff6b8424;color:#ff7d92}
  .stat{display:flex;gap:16px;margin-top:8px;color:var(--muted);font:700 12px/1.4 var(--fl)}.stat b{color:var(--ink);font-size:14px}
  .stake{font-size:24px;line-height:1.1}.stake small{display:block;font:600 12px/1.4 var(--fl);color:var(--muted);text-transform:none;letter-spacing:0;margin-top:4px}
  .ln{display:flex;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--line);font-size:13px}.ln:first-of-type{border-top:0}
  .ln .id{color:var(--muted);font-weight:800;min-width:28px}.ln .r{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--live);box-shadow:0 0 8px var(--live);display:inline-block}
  table{border-collapse:collapse;width:100%;font-size:13px}td{padding:3px 4px}td.n{text-align:right;color:var(--muted)}tr.me td{color:var(--gold);font-weight:800}
  /* Ticker along the bottom */
  .tk{left:0;right:0;bottom:0;height:${TICKER_H}px;display:flex;align-items:center;overflow:hidden;background:var(--panel);border-top:1px solid var(--line);font:700 15px/1 var(--fl);white-space:nowrap}
  .tk .lbl{flex:none;align-self:stretch;display:flex;align-items:center;gap:8px;padding:0 16px;background:var(--accent);color:var(--on);font:800 12px/1 var(--fl);letter-spacing:.12em;text-transform:uppercase;z-index:1}
  .tk .tw{flex:1;overflow:hidden}
  .tk .tt{display:inline-flex;gap:44px;padding-left:100%;animation:tick var(--tkd,40s) linear infinite}
  .tk .tt b{color:var(--accent);font-weight:800}.tk .tt em{font-style:normal;color:var(--muted)}
  @keyframes tick{to{transform:translateX(-100%)}}
  /* Walk-on intro */
  .intro{position:fixed;inset:0;z-index:5;pointer-events:auto;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;
    background:radial-gradient(ellipse at 50% 45%,color-mix(in srgb,var(--accent) 42%,var(--bg)),var(--bg) 72%);animation:fadeout .6s ease var(--introd,3.4s) forwards}
  .intro img.logo{max-height:min(14vh,120px);max-width:50vw;margin:0 0 6px;animation:rise .5s ease both}
  .intro .t1{animation:rise .5s ease both}
  .intro .st{font-size:min(13vw,15vh,120px);line-height:.9;animation:zoom .6s cubic-bezier(.2,1.4,.4,1) .15s both;color:var(--ink)}
  .intro .vs{display:flex;align-items:center;gap:min(4vw,48px);margin-top:10px}
  .intro .p{font-size:min(8vw,9vh,76px);line-height:1;text-align:center;color:var(--ink)}
  .intro .p small{display:block;font:800 12px/1.4 var(--fl);letter-spacing:.14em;color:var(--gold);margin-top:6px}
  .intro .p.a{animation:inl .55s cubic-bezier(.2,1,.3,1) .55s both}.intro .p.b{animation:inr .55s cubic-bezier(.2,1,.3,1) .55s both}
  .intro .x{font-size:min(5vw,6vh,44px);color:var(--muted);animation:rise .4s ease .9s both}
  .intro .ft{color:var(--muted);font:700 14px/1.4 var(--fl);letter-spacing:.06em;animation:rise .4s ease 1.1s both}
  .portrait .intro .vs{flex-direction:column;gap:2vh}
  .win{position:fixed;z-index:4;left:0;right:0;margin:0 auto;width:max-content;bottom:120px;pointer-events:auto;cursor:default;text-align:center;padding:18px 40px;border-radius:calc(var(--rad) + 2px);
    background:var(--panel);border:1px solid var(--gold);box-shadow:0 10px 50px #000a,0 0 40px color-mix(in srgb,var(--gold) 22%,transparent);animation:zoom .5s cubic-bezier(.2,1.4,.4,1) both;max-width:92vw}
  .win .cl{position:absolute;top:4px;right:12px;cursor:pointer;color:var(--muted);font-size:22px;line-height:1}.win .cl:hover{color:var(--ink)}
  .win .nx{margin-top:10px;color:var(--muted);font-size:13px}
  .win .go{margin-top:12px;background:var(--accent);color:var(--on);border:0;border-radius:10px;padding:10px 20px;font:800 14px var(--fl);cursor:pointer}.win .go:hover{filter:brightness(1.1)}.win .go:disabled{opacity:.6;cursor:default}
  .win .w1{font-size:46px;line-height:1;color:var(--gold)}.win .w2{color:var(--ink);font-weight:700;margin-top:6px}
  /* Autodarts' parts drawn anew: the score, the cards, the darts, the board, the moments */
  .scx{display:flex;justify-content:center;align-items:center}
  .sv{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:calc(var(--h)*.06);line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;--h:80px}
  .sv .dg{display:inline-block;text-align:center}
  .sv.plain,.sv.broadcast,.sv.neon{gap:0}
  .sv.plain .dg,.sv.broadcast .dg,.sv.neon .dg{height:var(--h);line-height:var(--h)}
  .sv.plain{font:800 calc(var(--h)*1.3)/1 var(--fl);letter-spacing:-.02em}
  .sv.broadcast{font-family:var(--fc);font-weight:700;font-size:calc(var(--h)*1.36)}
  .sv.broadcast .dg.flip{animation:bcin .4s cubic-bezier(.2,1.4,.4,1)}
  @keyframes bcin{from{transform:translateY(-30%);opacity:0}}
  .sv.flap .dg{position:relative;width:calc(var(--h)*.68);height:var(--h);border-radius:calc(var(--h)*.08);background:linear-gradient(#2a2a30 50%,#1d1d22 50%);color:#f7f2e4;
    font:700 calc(var(--h)*.84)/var(--h) var(--fc);box-shadow:0 3px 0 #0009,inset 0 0 0 1px #ffffff14;overflow:hidden}
  .sv.flap .dg::after{content:'';position:absolute;left:0;right:0;top:50%;height:max(1px,calc(var(--h)*.02));background:#000c}
  .sv.flap .dg.flip{animation:flap .36s ease-in-out}
  @keyframes flap{50%{transform:perspective(400px) rotateX(-90deg);filter:brightness(.5)}}
  .sv.roll{font:800 calc(var(--h)*1.04)/var(--h) var(--fc);gap:0}
  .sv.roll .dg{height:var(--h);overflow:hidden}
  .sv.roll .dg b{display:flex;flex-direction:column;transition:transform .6s cubic-bezier(.3,1.25,.5,1)}
  .sv.roll .dg b i{height:var(--h);font-style:normal;display:block}
  .sv.led{padding:calc(var(--h)*.12) calc(var(--h)*.16);background:#000d;border-radius:calc(var(--h)*.1);box-shadow:inset 0 0 0 1px #ffffff14;gap:calc(var(--h)*.12);--lc:color-mix(in srgb,var(--accent) 72%,#fff)}
  .sv.led .dg{width:calc(var(--h)*.6);height:var(--h)}
  .sv.led svg{width:100%;height:100%;display:block;transform:skewX(-6deg)}
  .sv.led path{fill:var(--lc);opacity:.09}
  .sv.led path.on{opacity:1;filter:drop-shadow(0 0 4px var(--lc))}
  .sv.neon{font:700 calc(var(--h)*1.3)/var(--h) var(--fc);color:#fff;text-shadow:0 0 2px #fff,0 0 10px var(--accent),0 0 22px var(--accent),0 0 42px var(--accent)}
  .sv.neon .dg.flip{animation:flick .6s linear}
  @keyframes flick{0%,18%,22%,60%{opacity:1}20%,58%{opacity:.25}}
  .dlt{position:absolute;right:0;bottom:100%;margin-bottom:calc(var(--h)*.06);font:800 clamp(12px,calc(var(--h)*.2),22px)/1 var(--fl);padding:.25em .55em;border-radius:999px;background:#000c;color:#fff;
    white-space:nowrap;letter-spacing:0;text-shadow:none;animation:dlt 2.6s ease forwards}
  .dlt.cn{top:10px;right:12px;bottom:auto;margin:0;z-index:1;font:800 clamp(13px,calc(var(--ch) * .08),22px)/1 var(--fl)}
  .oc.lower>.dlt.cn{top:auto;bottom:calc(30% + 8px)}
  @keyframes dlt{0%{opacity:0;transform:translateY(40%)}12%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}
  .oc{display:flex;color:var(--ink);background:var(--panel);border-radius:var(--rad);box-shadow:inset 0 0 0 1px var(--line);font-family:var(--fl)}
  .hard .oc{box-shadow:inset 0 0 0 3px var(--ink)}
  .oc .nm{font-size:clamp(18px,calc(var(--ch)*.15),52px);line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .oc .mt{display:flex;gap:6px 14px;flex-wrap:wrap;font:700 clamp(11px,calc(var(--ch)*.07),18px)/1.3 var(--fl);color:var(--muted)}
  .oc .mt b{color:var(--ink)}
  .oc .num{display:flex;align-items:center;justify-content:center;min-width:0}
  .oc.co:not(.lower) .mt{visibility:hidden}
  .oc.co:not(.lower) .num{padding-bottom:calc(var(--fh) + 12px)}
  .oc.co.lower .num{padding-top:calc(var(--fh) + 24px)}
  .oc.strip{align-items:stretch;padding-right:calc(var(--cw) * .03)}
  .oc.strip .l{flex:1 1 44%;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:10px;padding-left:7%}
  .oc.strip .num{flex:1 1 56%}
  .oc.strip.act{background:linear-gradient(90deg,var(--accent) 0 8px,var(--panel2) 8px);box-shadow:inset 0 0 0 2px var(--accent),0 0 30px color-mix(in srgb,var(--accent) 35%,transparent)}
  .oc.lower{flex-direction:column}
  .oc.lower .num,.oc.minimal .num{flex:1 1 0;min-height:0}
  .oc.lower .bar{flex:none;height:30%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 6%;background:var(--panel2);border-radius:0 0 var(--rad) var(--rad);min-width:0}
  .oc.lower .bar .nm{flex:1;min-width:0}
  .oc.lower .bar .mt{flex:none;flex-wrap:nowrap}
  .oc.lower .bar .mt .av{display:none}
  .oc.lower.act{box-shadow:inset 0 0 0 2px var(--accent)}
  .oc.lower.act .bar{background:var(--accent);color:var(--on)}
  .oc.lower.act .bar .mt,.oc.lower.act .bar .mt b{color:var(--on)}
  .oc.minimal{flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:12px 0;background:none;box-shadow:none;opacity:.45}
  .oc.minimal.on{opacity:.45}.oc.minimal.act.on{opacity:1}
  .oc.minimal .num{width:100%;padding:0 4%}
  .oc.minimal.act .nm{color:var(--accent)}
  .oc.minimal .mt{justify-content:center}
  .fin{height:var(--fh);display:flex;align-items:center;justify-content:center;gap:.5em;padding:0 .8em;border-radius:999px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line),0 4px 18px #0007;
    font-family:var(--fc);font-weight:700;white-space:nowrap;overflow:hidden;color:var(--ink)}
  .fin .k{font:800 .5em/1 var(--fl);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
  .fin b{font-weight:inherit;padding:.08em .4em;border-radius:6px;background:color-mix(in srgb,var(--ink) 10%,transparent)}
  .fin b.t{background:color-mix(in srgb,var(--accent) 35%,transparent)}
  .fin b.d{background:var(--accent);color:var(--on)}
  .thr{display:flex;gap:8px;padding:6px;align-items:stretch;background:var(--panel);border-radius:var(--rad);box-shadow:inset 0 0 0 1px var(--line)}
  .thr .tl{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:2px;border-radius:calc(var(--rad)*.6);background:color-mix(in srgb,var(--ink) 8%,transparent);font:800 calc(var(--th)*.42)/1 var(--fc);color:var(--ink);white-space:nowrap;overflow:hidden}
  .thr .tl small{font-size:.62em;color:var(--muted);margin-right:1px}
  .thr .tl i{width:26%;max-width:28px;aspect-ratio:1;border-radius:50%;border:2px dashed color-mix(in srgb,var(--ink) 25%,transparent)}
  .thr .tl.nx{box-shadow:inset 0 0 0 2px var(--accent)}
  .thr .tl.t{background:color-mix(in srgb,var(--accent) 26%,transparent)}.thr .tl.t small{color:var(--ink)}
  .thr .tl.d{background:color-mix(in srgb,var(--gold) 24%,transparent)}
  .thr .tl.b{background:color-mix(in srgb,var(--live) 30%,transparent)}
  .thr .tl.m{color:var(--muted)}
  .thr .tl.sg{background:none;box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--ink) 22%,transparent);color:color-mix(in srgb,var(--ink) 55%,transparent);font-size:calc(var(--th)*.34)}
  .thr .tl.sg.nx{box-shadow:inset 0 0 0 2px var(--accent)}
  .thr .tot{flex:0 0 24%;display:grid;place-items:center;border-radius:calc(var(--rad)*.6);background:var(--accent);color:var(--on);font-size:calc(var(--th)*.56);line-height:1;white-space:nowrap;overflow:hidden}
  .thr.bust .tot{background:var(--live);font-size:calc(var(--th)*.34)}
  .brd svg{width:100%;height:100%;display:block;overflow:visible}
  .brd .tg *{fill:rgb(255 255 255 / .42);stroke:#fff;stroke-width:6;filter:drop-shadow(0 0 10px var(--accent));animation:tgp 1.4s ease-in-out infinite}
  .brd .tg .ringp{fill:none;stroke:rgb(255 255 255 / .55)}
  @keyframes tgp{50%{opacity:.4}}
  .brd .fr.leds circle{fill:var(--accent);opacity:.2;animation:led 3s linear infinite}
  @keyframes led{0%,100%{opacity:.18}5%{opacity:1}}
  .brd.party .fr.leds circle{fill:var(--gold);animation:party .3s steps(2) infinite}
  @keyframes party{50%{opacity:.15}}
  .brd .fr.rings .rg{fill:none;stroke:var(--accent);stroke-width:8;filter:drop-shadow(0 0 12px var(--accent))}
  .brd .fr.rings .rg2{fill:none;stroke:color-mix(in srgb,var(--accent) 50%,transparent);stroke-width:3}
  .brd.party .fr.rings .rg{stroke:var(--gold);animation:party .3s steps(2) infinite}
  .brd .mk circle{fill:var(--accent);stroke:#fff;stroke-width:4;filter:drop-shadow(0 2px 4px #000a)}
  .brd .mk text{fill:var(--on);font:800 21px var(--fl);text-anchor:middle}
  .mo{position:fixed;z-index:6;pointer-events:none;text-align:center;white-space:nowrap;animation:mo 2.3s cubic-bezier(.2,1.2,.3,1) forwards}
  .mo .big{font-size:var(--ms);line-height:.95;color:#fff;-webkit-text-stroke:2px var(--accent);text-shadow:0 0 30px var(--accent),0 6px 30px #000c}
  .mo.max .big{color:var(--gold);-webkit-text-stroke:2px #000}
  .mo.bust .big{color:var(--live);-webkit-text-stroke:2px #000}
  .mo .sm{margin-top:6px;font:800 max(14px,calc(var(--ms)*.16))/1.2 var(--fl);letter-spacing:.14em;text-transform:uppercase;color:#fff;text-shadow:0 2px 10px #000}
  @keyframes mo{0%{opacity:0;transform:scale(.4)}12%{opacity:1;transform:scale(1.06)}20%{transform:none}80%{opacity:1}100%{opacity:0;transform:scale(1.04)}}
  .m-none .mo,.m-none .brd *,.m-none .sv *{animation:none!important;transition:none!important}
  /* The Overlay page's preview: a click selects a part, a drag moves it; switched-off parts show faintly */
  .pick [data-part]{pointer-events:auto;cursor:pointer}
  .pick [data-key]{cursor:grab}
  .pick .glow{pointer-events:none}
  .pick [data-part]:hover{outline:2px solid color-mix(in srgb,var(--accent) 70%,transparent);outline-offset:3px}
  .sel{position:fixed;z-index:9;pointer-events:none;outline:2px solid #fff;outline-offset:4px;box-shadow:0 0 0 7px #0006;border-radius:4px;display:none}
  .sel.on{display:block}
  .sel b{position:absolute;left:-6px;top:-34px;background:#fff;color:#111;font:800 12px/1 var(--fl);padding:5px 8px;border-radius:6px;white-space:nowrap;letter-spacing:.04em}
  .sel i{position:absolute;pointer-events:auto;background:#fff;border:2px solid #111;box-shadow:0 0 0 2px #fff8}
  .sel .hs{right:-14px;bottom:-14px;width:18px;height:18px;border-radius:50%;cursor:nwse-resize}
  .sel .hw{right:-12px;top:50%;width:10px;height:34px;margin-top:-17px;border-radius:5px;cursor:ew-resize}
  .sel.fixed i{display:none}
  .guide{position:fixed;z-index:8;background:#ff3bd4;pointer-events:none;display:none}
  .guide.on{display:block}
  .guide.x{top:0;bottom:0;width:1px}.guide.y{left:0;right:0;height:1px}
  .gridov{position:fixed;inset:0;z-index:-2;pointer-events:none;display:none;
    background:linear-gradient(90deg,#fff2 1px,transparent 1px) 0 0/5% 100%,linear-gradient(#fff2 1px,transparent 1px) 0 0/100% 5%}
  .gridov.on{display:block}
  .pick .ghost{opacity:.3!important;filter:grayscale(1);outline:2px dashed var(--muted);outline-offset:3px;animation:none!important}
  .pick .intro.ghost{opacity:.45!important}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
  @keyframes zoom{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:none}}
  @keyframes inl{from{opacity:0;transform:translateX(-40vw)}to{opacity:1;transform:none}}
  @keyframes inr{from{opacity:0;transform:translateX(40vw)}to{opacity:1;transform:none}}
  @keyframes fadeout{to{opacity:0;visibility:hidden}}
  </style><div class="ov" id="ov"></div>`;
  const ov = root.getElementById('ov');

  // ---------------------------------------------------------------------------
  // The page itself: hiding what the tournament panels replace, room for the ticker, and the skin
  // ("page"): Autodarts' background, player cards and bars in the look. Autodarts' elements are found
  // by what they are (the player cards, boxes with a background, text) and marked with data-ag-*.
  // ---------------------------------------------------------------------------
  const baseStyle = document.createElement('style');
  baseStyle.setAttribute('data-autoglow', 'base');
  baseStyle.textContent = `[data-ag-hide]{visibility:hidden!important}
  [data-ag-fade]{opacity:0!important;transition:none!important}
  [data-ag-board] path[fill="#E72946" i]{fill:var(--agb-red)!important}
  [data-ag-board] path[fill="#009856" i]{fill:var(--agb-green)!important}
  [data-ag-board] [fill="#01040B" i]{fill:var(--agb-dark)!important}
  [data-ag-board] path[fill="#EAD3C4" i]{fill:var(--agb-light)!important}
  [data-ag-board] [stroke="#8EA3C1" i]{stroke:var(--agb-wire)!important}
  [data-ag-board="wire"] [stroke="#8EA3C1" i]{stroke-width:3px!important}
  [data-ag-board] .cls-10{fill:var(--agb-sur)!important}
  [data-ag-board] .cls-9{fill:var(--agb-num)!important}
  [data-ag-markers] .dart-segment-blink{fill:color-mix(in srgb,var(--agb-hit) 60%,transparent)!important}
  [data-ag-markers] > svg:last-of-type circle[style*="fill"]{opacity:0!important}
  html[data-ag-ticker="bottom"] [data-ag-shell]{padding-bottom:${TICKER_H}px!important;box-sizing:border-box!important}
  html[data-ag-ticker="top"] [data-ag-shell]{padding-top:${TICKER_H}px!important;box-sizing:border-box!important}`;
  const skinStyle = document.createElement('style');
  skinStyle.setAttribute('data-autoglow', 'skin');
  skinStyle.textContent = `
  html[data-ag-skin] body{background:radial-gradient(ellipse 90% 55% at 50% -5%,color-mix(in srgb,var(--ag-accent) 20%,transparent),transparent 70%),var(--ag-bg)!important;color:var(--ag-ink)}
  html[data-ag-skin][data-ag-bg="plain"] body{background:var(--ag-bg)!important}
  html[data-ag-skin][data-ag-bg="spot"] body{background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--ag-accent) 30%,transparent),transparent 62%),var(--ag-bg)!important}
  html[data-ag-skin][data-ag-bg="grid"] body{background:linear-gradient(color-mix(in srgb,var(--ag-ink) 7%,transparent) 1px,transparent 1px) 0 0/48px 48px,linear-gradient(90deg,color-mix(in srgb,var(--ag-ink) 7%,transparent) 1px,transparent 1px) 0 0/48px 48px,var(--ag-bg)!important}
  html[data-ag-skin][data-ag-bg="dots"] body{background:radial-gradient(color-mix(in srgb,var(--ag-ink) 16%,transparent) 1.5px,transparent 2px) 0 0/26px 26px,var(--ag-bg)!important}
  html[data-ag-skin][data-ag-bg="lines"] body{background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--ag-accent) 10%,transparent) 0 2px,transparent 2px 22px),var(--ag-bg)!important}
  html[data-ag-skin][data-ag-bg="look"][data-ag-grid] body{background:linear-gradient(rgba(234,242,255,.07) 1px,transparent 1px) 0 0/40px 40px,linear-gradient(90deg,rgba(234,242,255,.07) 1px,transparent 1px) 0 0/40px 40px,var(--ag-bg)!important}
  html[data-ag-skin] [data-ag-card]{background:var(--ag-panel)!important;color:var(--ag-ink)!important;border-radius:var(--ag-rad)!important;box-shadow:inset 0 0 0 1px var(--ag-line)!important;transition:background .3s}
  html[data-ag-skin] [data-ag-card="act"]{background:var(--ag-act)!important;color:var(--ag-on)!important;box-shadow:none!important}
  html[data-ag-skin][data-ag-cards="outline"] [data-ag-card="act"]{background:var(--ag-panel)!important;color:var(--ag-ink)!important;box-shadow:inset 0 0 0 4px var(--ag-accent)!important}
  html[data-ag-skin][data-ag-cards="glow"] [data-ag-card="act"]{background:var(--ag-panel2)!important;color:var(--ag-ink)!important;box-shadow:inset 0 0 0 2px var(--ag-accent),0 0 46px color-mix(in srgb,var(--ag-accent) 55%,transparent)!important}
  html[data-ag-skin][data-ag-hard] [data-ag-card]{box-shadow:inset 0 0 0 3px var(--ag-ink)!important}
  html[data-ag-skin] [data-ag-card] [data-ag-ink]{color:inherit!important}
  html[data-ag-skin] [data-ag-score]{font-family:var(--ag-fc)!important;color:inherit!important;align-items:center!important}
  html[data-ag-skin] [data-ag-chip]{background:var(--ag-ink)!important;color:var(--ag-bg)!important}
  html[data-ag-skin] [data-ag-card="act"] [data-ag-chip]{background:var(--ag-on)!important;color:var(--ag-accent)!important}
  html[data-ag-skin]:not([data-ag-cards="fill"]) [data-ag-card="act"] [data-ag-chip]{background:var(--ag-accent)!important;color:var(--ag-on)!important}
  html[data-ag-skin] [data-ag-chip] *{color:inherit!important;font-family:var(--ag-fc)!important}
  html[data-ag-skin] [data-ag-panel]{background:var(--ag-bar)!important;color:var(--ag-bar-ink)!important;border-color:var(--ag-line)!important;border-radius:var(--ag-rad)!important}
  html[data-ag-skin] [data-ag-panel] [data-ag-ink]{color:var(--ag-bar-ink)!important}
  html[data-ag-skin] [data-ag-pill]{background:var(--ag-panel2)!important;color:var(--ag-ink)!important;border-color:var(--ag-line)!important}
  html[data-ag-skin] [data-ag-pill] *{color:inherit!important}
  html[data-ag-skin] [data-ag-ink="p"]{color:var(--ag-ink)!important}
  html[data-ag-skin] [data-ag-btn]{background:var(--ag-accent)!important;color:var(--ag-on)!important;border-color:var(--ag-accent)!important}
  html[data-ag-skin] [data-ag-btn] *{color:inherit!important}
  html[data-ag-skin] [data-ag-obtn]{border-color:var(--ag-accent)!important;color:var(--ag-ink)!important}
  html[data-ag-skin] [data-ag-panel] [data-ag-obtn]{color:var(--ag-bar-ink)!important}
  html[data-ag-skin] [data-ag-obtn] *{color:inherit!important}
  html[data-ag-skin] [data-ag-big]{font-family:var(--ag-fc)!important}`;

  let data = null;
  let ctx = null;       // { ad, mid, tid }: the tournament match on this Autodarts match page
  let introDone = '';
  let introForce = false;   // the preview asked for the intro again
  let winShown = '';    // the match whose winner banner was closed
  const cards = {};     // player name -> the element of Autodarts' player card

  const T = () => data && data.tournament;
  const player = (id) => ((T() && T().players) || []).find(p => p.id === id) || null;
  const pname = (id) => (player(id) || {}).name || '';
  /** The look and parts from the host; an older host sends none: Autodarts' look, panels only */
  const OV = () => (data && data.overlay) || null;
  const OFF = ['ticker', 'clock', 'note', 'glow'];
  const orient = () => (window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
  /** This screen shape's settings: its parts and moved boxes (an older host: one set of parts) */
  const SCR = () => { const o = OV() || {}; return o[orient()] || { parts: o.parts || {}, boxes: {} }; };
  const partOn = (k) => { const p = SCR().parts || {}; return k in p ? p[k] !== false : !OFF.includes(k); };
  const ST = () => (OV() || {}).style || {};
  let dragBox = null;   // the preview: the box being dragged, {key, box}
  /** Where a box was moved to (in px), or null: it stays where the layout puts it */
  function moved(key) {
    const b = dragBox && dragBox.key === key ? dragBox.box : (SCR().boxes || {})[key];
    if (!b) return null;
    const vw = window.innerWidth, vh = window.innerHeight;
    return { x: b.x * vw / 100, y: b.y * vh / 100, w: b.w * vw / 100, s: b.s || 1 };
  }
  const tickerPos = () => (partOn('ticker') ? ((OV() || {}).style || {}).ticker_pos || 'bottom' : '');
  /** The screen's height a moved box may use: not under the ticker */
  const yRoom = () => { const tk = tickerPos(); return [tk === 'top' ? TICKER_H : 0, window.innerHeight - (tk === 'bottom' ? TICKER_H : 0)]; };
  const skinOn = () => (OV() || {}).skin === 'page';
  /** This Autodarts match page's id ("preview" in the Overlay page's preview) */
  const pageMatch = () => (PREVIEW ? 'preview' : (/^\/matches\/([^/?#]+)/.exec(location.pathname) || [])[1] || null);

  /** Autodarts' card of a player: the box around their name that is big enough to be a card */
  function cardFor(names) {
    const key = names.join('|');
    const old = cards[key];
    if (old && old.isConnected && old.checkVisibility() && fits(old.getBoundingClientRect())) return old;
    const want = names.map(n => n.trim().toUpperCase()).filter(Boolean);
    const leaf = [...document.body.querySelectorAll('span, div, p, h1, h2, h3')].find(e => e.childElementCount === 0
      && want.includes((e.textContent || '').trim().toUpperCase()) && !e.closest('[data-autoglow]') && e.checkVisibility());
    // The outermost box around the name that still holds one player only
    let el = leaf, card = null;
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (!fits(r) || (card && others(el, want))) break;
      if (r.width >= 200 && r.height >= 150) card = el;
      el = el.parentElement;
    }
    cards[key] = card;
    return card;
  }
  /** Small enough to be one player's card: in portrait the two cards are each half the screen wide,
   * so only a box of nearly the whole width (or height) is too big */
  const fits = (r) => { const vw = window.innerWidth; return r.width < vw * (vw < 1000 ? 0.98 : 0.6) && r.height < window.innerHeight * 0.8; };
  // A new window size (or the screen turned): find the cards again
  addEventListener('resize', () => { for (const k of Object.keys(cards)) delete cards[k]; scanAt = 0; });
  /** Another player's name inside: the box is wider than one card */
  const others = (el, want) => [...el.querySelectorAll('span, div, p')].some(e => e.childElementCount === 0 && /\S/.test(e.textContent)
    && !want.includes(e.textContent.trim().toUpperCase()) && ctx.a.players.some(p => [p.ad_name, p.name].some(n => n && n.trim().toUpperCase() === e.textContent.trim().toUpperCase())));


  // ---------------------------------------------------------------------------
  // Look: colours on the overlay, fonts, and the page skin
  // ---------------------------------------------------------------------------
  const onColor = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 165 ? '#111' : '#fff';
  };
  function lookOf() {
    const o = OV() || {};
    const base = LOOKS[o.look] || LOOKS.autodarts;
    const own = /^#[0-9a-f]{6}$/i.test(o.accent || '') ? o.accent.toLowerCase() : '';
    const accent = own || base.accent;
    const font = FONTS[ST().font];
    return { ...base, accent, on: own ? onColor(own) : base.on, gold: own && base.gold === base.accent ? own : base.gold,
      fc: font ? font[0] : base.fc, fonts2: font ? font[1] : '', rad: ST().corners in CORNERS ? CORNERS[ST().corners] : base.rad };
  }
  const fontsLoaded = new Set();
  function loadFonts(f) {
    if (!f || fontsLoaded.has(f)) return;
    fontsLoaded.add(f);
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?family=${f}&display=swap`;
    l.setAttribute('data-autoglow', 'font');
    document.head.appendChild(l);
  }
  const SKIN_VARS = ['bg', 'panel', 'panel2', 'ink', 'muted', 'line', 'accent', 'on', 'fc', 'fl', 'rad', 'act', 'bar', 'bar-ink'];
  let lookKey = '';
  function applyLook(portrait) {
    const L = lookOf();
    const skin = skinOn();
    const st = ST();
    const key = JSON.stringify([L, skin, portrait, PREVIEW, st]);
    if (key === lookKey) return;
    lookKey = key;
    const v = { bg: L.bg, panel: L.panel, panel2: L.panel2, ink: L.ink, muted: L.muted, line: L.line, accent: L.accent, on: L.on, gold: L.gold, live: L.live,
      fc: L.fc, fl: L.fl, rad: `${L.rad}px`, glass: `color-mix(in srgb,${L.panel} ${st.opacity == null ? (skin ? 100 : 88) : st.opacity}%,transparent)` };
    for (const [k, x] of Object.entries(v)) ov.style.setProperty(`--${k}`, x);
    ov.className = `ov m-${st.motion || 'fade'}${skin ? ' skin' : ''}${L.hard ? ' hard' : ''}${portrait ? ' portrait' : ''}${PREVIEW ? ' pick' : ''}`;
    loadFonts(L.fonts);
    loadFonts(L.fonts2);
    const html = document.documentElement;
    if (!skin) { unskin(); return; }
    const sv = { bg: L.bg, panel: L.panel, panel2: L.panel2, ink: L.ink, muted: L.muted, line: L.line, accent: L.accent, on: L.on, fc: L.fc, fl: L.fl, rad: `${L.rad}px`,
      act: L.act && L.accent === LOOKS.autodarts.accent ? L.act : `linear-gradient(135deg,${L.accent},color-mix(in srgb,${L.accent} 55%,${L.bg}))`,
      // A light page gets dark bars (the look's ink), like the Dashboard's poster and gazette rows
      bar: L.light ? L.ink : L.panel, 'bar-ink': L.light ? L.bg : L.ink };
    for (const k of SKIN_VARS) html.style.setProperty(`--ag-${k}`, sv[k]);
    html.setAttribute('data-ag-skin', L.light ? 'light' : 'dark');
    html.toggleAttribute('data-ag-grid', !!L.grid);
    html.toggleAttribute('data-ag-hard', !!L.hard);
    html.setAttribute('data-ag-bg', st.bg || 'look');
    html.setAttribute('data-ag-cards', st.card || 'fill');
    if (!skinStyle.isConnected) document.head.appendChild(skinStyle);
  }
  function unskin() {
    const html = document.documentElement;
    html.removeAttribute('data-ag-skin');
    html.removeAttribute('data-ag-grid');
    html.removeAttribute('data-ag-hard');
    html.removeAttribute('data-ag-bg');
    html.removeAttribute('data-ag-cards');
    for (const k of SKIN_VARS) html.style.removeProperty(`--ag-${k}`);
    skinStyle.remove();
    untag();
  }

  // ---------------------------------------------------------------------------
  // Reading Autodarts' page: the dartboard, its bars, and (with the skin) marking what gets the look
  // ---------------------------------------------------------------------------
  const TAGS = ['data-ag-card', 'data-ag-ink', 'data-ag-score', 'data-ag-chip', 'data-ag-panel', 'data-ag-pill', 'data-ag-btn', 'data-ag-obtn', 'data-ag-big'];
  let tagged = new Set();
  function untag() {
    for (const e of tagged) for (const a of TAGS) e.removeAttribute(a);
    tagged = new Set();
  }
  const clearBg = (cs) => cs.backgroundImage === 'none' && (cs.backgroundColor === 'transparent' || /rgba\(.*,\s*0\)$/.test(cs.backgroundColor));
  const hasText = (e) => e.childElementCount === 0 && /\S/.test(e.textContent || '');
  let scanAt = 0;
  let found = { board: null, bars: [], pills: [], turn: null };

  // Whose turn, as Autodarts shows it: the waiting player's card is plain dark (bg-black-80), the
  // thrower's has the colour (-1 when that can't be told). Its small dot marks who began the leg.
  function turnOf(cardEls) {
    const idle = cardEls.map(c => !!c && c.isConnected && (c.classList.contains('bg-black-80') || !!c.querySelector('.bg-black-80')));
    if (!cardEls[0] || !cardEls[1] || idle[0] === idle[1]) return -1;
    return idle[0] ? 1 : 0;
  }
  /** Every 1.2 s at most: Autodarts re-renders, so the marks are set again each time */
  function scan(cardEls, active) {
    if (Date.now() - scanAt < 1200) return found;
    scanAt = Date.now();
    // Autodarts' top bar sits beside main, in the same screen-high column
    const main = shellEl() || document.body;
    const inCard = (e) => cardEls.some(c => c && c.contains(e));
    // The dartboard: the biggest square picture
    let board = null, area = 0;
    for (const e of main.querySelectorAll('svg, img, canvas')) {
      if (e.closest('[data-autoglow]') || (e.parentElement && e.parentElement.closest('svg'))) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 200 || Math.abs(r.width - r.height) > r.width * 0.08 || r.width * r.height <= area) continue;
      area = r.width * r.height;
      board = e;
    }
    // Boxes with their own background: wide ones are Autodarts' bars, small ones its chips
    const bars = [], pills = [];
    for (const e of main.querySelectorAll('div, nav, header, footer, section, span')) {
      if (e.closest('[data-autoglow]') || inCard(e) || cardEls.some(c => c && e.contains(c)) || (board && e.contains(board))) continue;
      const cs = getComputedStyle(e);
      if (clearBg(cs) && !e.hasAttribute('data-ag-panel') && !e.hasAttribute('data-ag-pill')) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || cs.visibility === 'hidden') continue;
      if (r.width >= 220 && r.height >= 44 && r.height < window.innerHeight * 0.4) { if (!bars.some(b => b.contains(e))) bars.push(e); } else if (r.height >= 16 && r.height <= 44 && r.width < 420 && !bars.some(b => b.contains(e))) pills.push(e);
    }
    // Whose turn, as Autodarts shows it, until AutoGlow has the live score
    const turn = turnOf(cardEls);
    found = { board, bars, pills: pills.filter(p => !bars.some(b => b.contains(p))), turn: turn < 0 ? null : turn };
    if (skinOn()) mark(main, cardEls, active == null ? found.turn : active, board);
    return found;
  }

  function mark(main, cardEls, active, board) {
    const now = new Set();
    const set = (e, a, v = '') => { if (e.getAttribute(a) !== v) e.setAttribute(a, v); now.add(e); };
    // The player cards: the coloured box, its text, the big score and the name chip
    cardEls.forEach((card, i) => {
      if (!card) return;
      const R = card.getBoundingClientRect();
      const box = [card, ...card.querySelectorAll('div')].find(e => { const r = e.getBoundingClientRect(); return r.width >= R.width * 0.9 && r.height >= R.height * 0.9 && !clearBg(getComputedStyle(e)); }) || card;
      set(box, 'data-ag-card', active === i ? 'act' : 'idle');
      let big = null, bigSize = 0;
      for (const e of box.querySelectorAll('*')) {
        if (!hasText(e) || e.closest('svg')) continue;
        let chip = null;
        for (let p = e; p && p !== box; p = p.parentElement) if (!clearBg(getComputedStyle(p)) || p.hasAttribute('data-ag-chip')) { chip = p; break; }
        if (chip) { if (chip.getBoundingClientRect().width < R.width * 0.7) set(chip, 'data-ag-chip'); continue; }
        set(e, 'data-ag-ink', 'c');
        const fs = parseFloat(getComputedStyle(e).fontSize);
        if (fs > bigSize) { bigSize = fs; big = e; }
      }
      if (big) set(big, 'data-ag-score');
    });
    for (const b of found.bars) {
      set(b, 'data-ag-panel');
      for (const e of b.querySelectorAll('*')) {
        if (e.closest('svg') && e.tagName !== 'svg') continue;
        if (e.tagName === 'BUTTON') {
          const cs = getComputedStyle(e);
          if (!clearBg(cs) || e.hasAttribute('data-ag-btn')) set(e, 'data-ag-btn');
          else if (parseFloat(cs.borderTopWidth) > 0) set(e, 'data-ag-obtn');
          else set(e, 'data-ag-ink', 'b');
        } else if (hasText(e)) {
          set(e, 'data-ag-ink', 'b');
          if (parseFloat(getComputedStyle(e).fontSize) >= 30) set(e, 'data-ag-big');
        }
      }
    }
    for (const p of found.pills) set(p, 'data-ag-pill');
    // The rest of the page's text and icon buttons (the top bar): the look's ink
    // (text of its own beside an icon, like Autodarts' viewer count, counts too; icons take the ink)
    const ownText = (e) => [...e.childNodes].some(n => n.nodeType === 3 && /\S/.test(n.textContent));
    for (const e of main.querySelectorAll('span, p, a, button, h1, h2, h3, h4, div, label, svg')) {
      if (now.has(e) || e.closest('[data-autoglow]') || (board && (board.contains(e) || e.contains(board))) || cardEls.some(c => c && c.contains(e))
        || found.bars.some(b => b.contains(e)) || found.pills.some(p => p.contains(e))) continue;
      if (e.tagName === 'svg') { if (!e.closest('button') && e.getBoundingClientRect().width < 64) set(e, 'data-ag-ink', 'p'); continue; }
      if (e.tagName === 'BUTTON' ? clearBg(getComputedStyle(e)) && parseFloat(getComputedStyle(e).borderTopWidth) === 0 : hasText(e) || ownText(e)) set(e, 'data-ag-ink', 'p');
      else if (e.tagName === 'BUTTON' && clearBg(getComputedStyle(e))) set(e, 'data-ag-obtn');
    }
    for (const e of tagged) if (!now.has(e)) for (const a of TAGS) e.removeAttribute(a);
    tagged = now;
  }

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

  /** A box of the overlay: shown when there is room and its part is on (the preview shows it faintly
   * when off). key: a box that can be moved; moved, it stands where it was put, whole on the screen. */
  function show(el, part, x, y, w, room = true, key = null) {
    const mv = key && moved(key);
    let k = Number(el.dataset.k) || 1;   // fitIn: shrunk to fit its room
    // Moved: wherever it was put, as long as it has something to show
    if (mv) { ({ x, y, w } = mv); k = mv.s; room = el.innerHTML.trim() !== ''; }
    if (w) el.style.width = `${Math.round(w)}px`;
    if (mv) {
      // Never narrower than what it shows, and whole on the screen however big it was made
      const vw = window.innerWidth;
      const [y0, y1] = yRoom();
      fitWidth(el, vw);
      k = Math.min(k, vw / el.offsetWidth, (y1 - y0) / Math.max(1, el.offsetHeight));
      x = Math.max(0, Math.min(x, vw - el.offsetWidth * k));
      y = Math.max(y0, Math.min(y, y1 - el.offsetHeight * k));
    }
    el.style.scale = k !== 1 ? String(Math.round(k * 1000) / 1000) : '';
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    const on = partOn(part);
    el.dataset.part = part;
    if (key) el.dataset.key = key; else delete el.dataset.key;
    el.classList.toggle('on', room && (on || PREVIEW));
    el.classList.toggle('ghost', PREVIEW && !on);
  }
  /** A box narrower than its words (or wider than the screen): as wide as they need */
  function fitWidth(el, vw) {
    const want = el.style.width;
    el.style.width = 'min-content';
    const need = el.offsetWidth;
    el.style.width = want;
    if (el.offsetWidth < need) el.style.width = `${Math.min(vw, need)}px`;
    if (el.offsetWidth > vw) el.style.width = `${vw}px`;
  }
  /** Shrink a box (down to 62 %) so it fits a height; false when it would not fit even so */
  function fitIn(el, maxH) {
    el.dataset.k = '';
    el.style.scale = '';
    const h = el.offsetHeight;
    if (!h || h <= maxH) return maxH > 0;
    const k = maxH / h;
    if (k < 0.62) return false;
    el.dataset.k = k.toFixed(3);
    return true;
  }
  const unfit = (...els) => els.forEach(el => { el.dataset.k = ''; });
  const hide = (...els) => els.forEach(el => el.classList.remove('on'));
  /** A wide look's font: the round's name shrinks until it fits its box */
  function fitText(el, min = 22) {
    if (!el) return;
    el.style.fontSize = '';
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && fs > min) { fs -= 3; el.style.fontSize = `${fs}px`; }
  }

  function box(id, cls) {
    let el = root.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      ov.appendChild(el);
    }
    const c = `box ${cls || ''}`.trim();
    if (el.dataset.c !== c) { el.dataset.c = c; el.className = c; }
    return el;
  }
  const html = (el, h) => { if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; } };

  function clear() {
    if (host.isConnected) host.remove();
    ov.innerHTML = '';
    baseStyle.remove();
    document.documentElement.removeAttribute('data-ag-ticker');
    for (const e of document.querySelectorAll('[data-ag-hide]')) e.removeAttribute('data-ag-hide');
    for (const e of document.querySelectorAll('[data-ag-shell]')) e.removeAttribute('data-ag-shell');
    unskin();
    unface();
    lookKey = '';
  }

  /** The tournament match on this page, if this page is one: also after its result went to the host */
  function current() {
    const b = data && data.board;
    const a = b && b.assignment;
    const t = T();
    const ad = pageMatch();
    if (!t || !ad) return null;
    if (a && b.linked && b.linked === ad) ctx = { ad, mid: a.match, tid: t.id, a };
    if (!ctx || ctx.ad !== ad || ctx.tid !== t.id) return null;
    const m = t.matches.find(x => x.id === ctx.mid);
    if (!m) return null;
    const linked = !!(a && a.match === ctx.mid && b.linked === ad);
    return { m, a: ctx.a, live: linked ? b.live || {} : null };
  }

  // The event logo: the preview has its address, a board asks its own AutoGlow (which asks the host)
  const logos = {};
  function logoSrc() {
    const o = OV() || {};
    if (!o.logo || !partOn('logo')) return '';
    if (o.logo_url) return o.logo_url;
    if (!(o.logo in logos)) {
      logos[o.logo] = '';
      try {
        chrome.runtime.sendMessage({ type: 'tournament', path: `overlay-logo?name=${encodeURIComponent(o.logo)}` }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) return;
          logos[o.logo] = r.data.data || '';
          if (data) render();
        });
      } catch { /* the extension was reloaded */ }
    }
    return logos[o.logo];
  }
  const logoImg = (cls = 'logo') => { const s = logoSrc(); return s ? `<img class="${cls}" data-part="logo" src="${esc(s)}" alt="">` : ''; };
  /** The event's name from the Dashboard, else "Local Tournament" */
  const eventName = () => esc((OV() || {}).title || '') || tr('Local Tournament');

  // ---------------------------------------------------------------------------
  // Walk-on intro, winner banner, ticker
  // ---------------------------------------------------------------------------
  function intro(m, a, live, need, sets) {
    const t = T();
    const key = `${t.id}:${m.id}`;
    let seen = false;
    try { seen = sessionStorage.getItem('autoglow-intro') === key; } catch { /* private mode */ }
    // Decided once, when the page first sees the match: a fresh match (nothing scored yet) gets it
    const fresh = live && ![live.legs, live.sets].some(x => x && (x[0] || x[1])) && !(live.remaining || []).some(r => r != null && r !== a.settings.base_score);
    if (live && introDone !== key) introDone = key; else seen = true;
    if (introForce) { introForce = false; seen = false; root.querySelectorAll('.intro').forEach(e => e.remove()); } else if (seen || !fresh || (!partOn('intro') && !PREVIEW)) return;
    if (!PREVIEW) try { sessionStorage.setItem('autoglow-intro', key); } catch { /* private mode */ }
    const secs = Math.max(2, Math.min(10, Number((OV() || {}).intro_secs) || 4));
    const p = (i) => player(a.players[i].id) || {};
    const el = document.createElement('div');
    el.className = `intro${PREVIEW && !partOn('intro') ? ' ghost' : ''}`;
    el.dataset.part = 'intro';
    el.style.setProperty('--introd', `${secs - 0.6}s`);
    el.innerHTML = `${logoImg()}<div class="tag t1">🏆 ${eventName()}${(OV() || {}).title ? '' : ` · ${esc(t.name)}`}</div><div class="st disp">${esc(srv(m.label))}</div>
      <div class="vs"><div class="p a disp">${esc(a.players[0].name)}<small>${p(0).seed ? tr('SEED {n}', { n: p(0).seed }) : ''}</small></div><div class="x disp">vs</div><div class="p b disp">${esc(a.players[1].name)}<small>${p(1).seed ? tr('SEED {n}', { n: p(1).seed }) : ''}</small></div></div>
      <div class="ft">${STAGE[m.stage] && m.stage !== 'gf' ? `${esc(STAGE[m.stage])} · ` : ''}${cap(firstTo(need, sets))} · X01 ${a.settings.base_score}</div>`;
    if (!PREVIEW) el.addEventListener('click', () => el.remove());
    setTimeout(() => el.remove(), secs * 1000 + 300);
    ov.appendChild(el);
    // A long round or name in a wide font: smaller until it fits the screen
    const max = window.innerWidth - 48;
    const shrink = (box, els) => {
      for (let i = 0; i < 30 && box.scrollWidth > max; i++) {
        for (const t of els) t.style.fontSize = `${Math.max(16, parseFloat(getComputedStyle(t).fontSize) * 0.92)}px`;
      }
    };
    for (const t of el.querySelectorAll('.st, .tag')) { t.style.maxWidth = 'none'; t.style.whiteSpace = 'nowrap'; shrink(t, [t]); }
    const vs = el.querySelector('.vs');
    if (vs) { vs.querySelectorAll('.p').forEach(t => { t.style.whiteSpace = 'nowrap'; }); shrink(vs, vs.querySelectorAll('.p, .x')); }
  }

  function winner(m, a, score, need, live) {
    const t = T();
    const result = m.state === 'done' && m.result;
    const won = result ? result.winner : live && score[0] >= need ? 0 : live && score[1] >= need ? 1 : -1;
    let win = root.getElementById('win');
    if (won < 0 || winShown === m.id || (!partOn('winner') && !PREVIEW)) { if (win) win.remove(); return; }
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
      win.dataset.part = 'winner';
      if (!PREVIEW) {
        win.addEventListener('click', (e) => {
          const go = (e.target.closest('[data-go]') || {}).dataset;
          if (!go) return;
          if (go.go === 'close') { winShown = win.dataset.m; win.remove(); }
          if (go.go === 'page') window.autoglowShowPage();
          if (go.go === 'start' && window.autoglowStartNext) { e.target.textContent = tr('Starting…'); e.target.disabled = true; window.autoglowStartNext(); }
        });
      }
      ov.appendChild(win);
    }
    win.classList.toggle('ghost', PREVIEW && !partOn('winner'));
    win.dataset.m = m.id;
    win.dataset.key = 'winner';
    html(win, h);
    const mv = moved('winner');
    if (mv) {
      const vw = window.innerWidth;
      win.style.width = `${Math.round(Math.min(mv.w, vw))}px`;
      win.style.margin = '0';
      win.style.bottom = 'auto';
      fitWidth(win, vw);
      const [y0, y1] = yRoom();
      const k = Math.min(mv.s, vw / win.offsetWidth, (y1 - y0) / Math.max(1, win.offsetHeight));
      win.style.scale = k !== 1 ? String(Math.round(k * 1000) / 1000) : '';
      win.style.transformOrigin = '0 0';
      win.style.left = `${Math.round(Math.max(0, Math.min(mv.x, vw - win.offsetWidth * k)))}px`;
      win.style.top = `${Math.round(Math.max(y0, Math.min(mv.y, y1 - win.offsetHeight * k)))}px`;
    } else {
      for (const k of ['width', 'margin', 'left', 'top', 'scale', 'transformOrigin']) win.style[k] = '';
      win.style.bottom = `${(tickerPos() === 'bottom' ? TICKER_H : 0) + 120}px`;
    }
  }

  /** The outermost screen-high column around Autodarts' main (its top bar sits in it too), else main */
  function shellEl() {
    const main = document.querySelector('main');
    let best = null;
    for (let e = main; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'flex' && cs.flexDirection === 'column' && Math.abs(e.getBoundingClientRect().height - window.innerHeight) <= 2) best = e;
    }
    return best || main;
  }

  /** Along the bottom: the other boards live, the latest results, what's next */
  function ticker(m) {
    const t = T();
    const el = box('tk', 'tk');
    const on = partOn('ticker');
    const pos = (ST().ticker_pos) || 'bottom';
    if (on) document.documentElement.setAttribute('data-ag-ticker', pos); else document.documentElement.removeAttribute('data-ag-ticker');
    // Room for it: the page's screen-high column (Autodarts' top bar and main inside it) gets shorter
    const sh = shellEl();
    if (sh && !sh.hasAttribute('data-ag-shell')) { for (const e of document.querySelectorAll('[data-ag-shell]')) e.removeAttribute('data-ag-shell'); sh.setAttribute('data-ag-shell', ''); }
    el.style.top = pos === 'top' ? '0' : 'auto';
    el.style.bottom = pos === 'top' ? 'auto' : '0';
    el.style.borderTop = pos === 'top' ? '0' : '';
    el.style.borderBottom = pos === 'top' ? '1px solid var(--line)' : '';
    if (!on && !PREVIEW) { hide(el); return; }
    const board = (id) => { const b = (t.boards || []).find(x => x.node_id === id); return b ? tr('Board {n}', { n: b.number }) : ''; };
    const items = [];
    for (const x of t.matches.filter(x => x.state === 'live' && x.id !== m.id)) {
      const b = (t.boards || []).find(y => y.node_id === x.board);
      const l = (b && b.status && b.status.match === x.id && b.status.live) || x.last_live || {};
      items.push(`<span><span class="dot"></span> <b>${esc(board(x.board) || x.id)}</b> ${esc(pname(x.sides[0].player))} ${l.legs ? `${l.legs[0]}–${l.legs[1]}` : 'vs'} ${esc(pname(x.sides[1].player))}</span>`);
    }
    const done = t.matches.filter(x => x.state === 'done' && x.result && !x.sides.some(s => s.bye)).sort((a, b) => (b.done_seq || 0) - (a.done_seq || 0)).slice(0, 5);
    for (const x of done) {
      const r = x.result;
      const w = r.winner;
      items.push(`<span><em>${esc(short(x.label))}</em> <b>${esc(pname(x.sides[w].player))}</b> ${r.walkover ? tr('w/o') : `${r.legs[w]}–${r.legs[1 - w]}`} ${esc(pname(x.sides[1 - w].player))}</span>`);
    }
    const byId = Object.fromEntries(t.matches.map(x => [x.id, x]));
    for (const x of (t.up_next || []).map(id => byId[id]).filter(x => x && x.id !== m.id).slice(0, 3)) {
      items.push(`<span><em>${tr('Up next')}</em> ${esc(pname(x.sides[0].player))} – ${esc(pname(x.sides[1].player))}</span>`);
    }
    const sub = (OV() || {}).subtitle;
    if (sub) items.push(`<span>${esc(sub)}</span>`);
    if (!items.length) items.push(`<span>🏆 ${eventName()} · ${esc(t.name)}</span>`);
    const text = items.join('');
    const speed = TICK_SPEED[(OV() || {}).ticker_speed] || 1;
    html(el, `<span class="lbl">🏆 ${eventName()}</span><div class="tw"><div class="tt" style="--tkd:${Math.round(Math.max(18, text.replace(/<[^>]+>/g, '').length * 0.22) * speed)}s">${text}</div></div>`);
    el.dataset.part = 'ticker';
    el.classList.add('on');
    el.classList.toggle('ghost', PREVIEW && !on);
  }

  // ---------------------------------------------------------------------------
  // Layouts. Side: the cards stand left and right of the board (landscape). Top: the cards sit
  // above the board (portrait, narrow windows). Each box only shows where it has room.
  // ---------------------------------------------------------------------------
  function headerHtml(m, need, sets, kind, narrow = false) {
    const t = T();
    const stage = STAGE[m.stage] && m.stage !== 'gf' ? ` · ${esc(STAGE[m.stage])}` : '';
    const label = srv(m.label);
    // The ribbon in a narrow top bar: the trophy stands for the event's name
    if (kind === 'rib') return `${logoImg()}<span class="tag">🏆${narrow ? '' : ` ${eventName()}`}</span><span class="disp">${esc(label)}</span><span class="meta">${esc(m.id)} · ${tr('first to {n}', { n: need })}</span>`;
    const body = `<span class="tag">🏆 ${eventName()}</span><div class="name">${esc(t.name)}${stage}</div>
      <div class="stage disp${label.length > 13 ? ' long' : ''}">${esc(label)}</div><div class="meta">${tr('Match {id}', { id: esc(m.id) })} · ${firstTo(need, sets)}</div>`;
    return kind === 'hero' ? `${logoImg()}<div style="min-width:0">${body}</div>` : `${logoImg()}${body}`;
  }
  function raceHtml(a, score, active, need, sets, leftSide) {
    const row = (i) => `<div class="row"><span class="pn disp ${active === i ? 'act' : ''}">${active === i ? '<i class="turn"></i>' : ''}${esc(a.players[i].name)}</span><span class="sc disp">${score[i] || 0}</span>
      <div class="pips">${Array.from({ length: Math.min(need, 13) }, (_, k) => `<i class="${k < (score[i] || 0) ? 'w' : ''}"></i>`).join('')}</div></div>`;
    return `<div class="top"><span>${sets ? 'Sets' : 'Legs'}</span><span>${tr('first to {n}', { n: need })}</span></div>${row(leftSide)}${row(1 - leftSide)}`;
  }
  function puckHtml(m, score, need, sets, leftSide) {
    const [x, y] = [score[leftSide] || 0, score[1 - leftSide] || 0];
    return `<div class="st">${esc(short(m.label))} · ${sets ? 'Sets' : 'Legs'}</div><div class="sc disp"><span class="${x > y ? 'lead' : ''}">${x}</span><i>:</i><span class="${y > x ? 'lead' : ''}">${y}</span></div><div class="ft">${tr('first to {n}', { n: need })}</div>`;
  }
  function runHtml(a, i, m) {
    const run = runOf(a.players[i].id, m.id);
    return `<h4>${tr('Tournament run')}</h4>${run.chips.length ? `<div class="chips">${run.chips.join('')}</div>` : `<div style="color:var(--muted);font-size:13px">${tr('First match in this tournament')}</div>`}
      ${run.played ? `<div class="stat"><span>${tr('Won')} <b>${run.won}/${run.played}</b></span>${run.avg ? `<span>${tr('Avg')} <b>${run.avg.toFixed(1)}</b></span>` : ''}${run.t180 ? `<span>${tr('180s')} <b>${run.t180}</b></span>` : ''}</div>` : ''}`;
  }
  function stakeHtml(m, a) {
    const st = stakes(m);
    return st ? `<h4>${tr('At stake')}</h4><div class="stake disp">${st.big}<small>${st.small}</small></div>` : tableFor(m, a);
  }

  function render() {
    const cur = current();
    if (!cur) { clear(); return; }
    const { m, a, live } = cur;
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (!baseStyle.isConnected) document.head.appendChild(baseStyle);
    const vw = window.innerWidth, vh = window.innerHeight;
    applyLook(vh > vw);
    const sets = !!a.settings.sets;
    const need = legsToWin(m, a);
    const result = m.state === 'done' && m.result;
    const score = result ? result.legs : live && (sets ? live.sets : live.legs) || [0, 0];
    const names = a.players.map(p => [p.ad_name || p.name, p.name]);
    const els = [cardFor(names[0]), cardFor(names[1])];
    const s = scan(els, live && live.active != null ? live.active : null);
    const active = live && live.active != null ? live.active : result ? null : s.turn;
    watchFace();

    ticker(m);
    intro(m, a, live, need, sets);
    winner(m, a, score, need, live);

    const hdr = box('hdr', 'hdr');
    const race = box('race');
    const runs = [box('run0', 'panel card'), box('run1', 'panel card')];
    const stake = box('stake', 'panel card');
    const next = box('next', 'panel card');
    const frames = [box('f0', 'frame'), box('f1', 'frame')];
    const clock = box('clock', 'panel clock');
    const note = box('note', 'panel note');
    const glow = box('glow', 'glow');
    unfit(hdr, race, ...runs, stake, next);
    const rects = els.map(e => e && e.getBoundingClientRect());
    if (!rects[0] || !rects[1]) { hide(hdr, race, ...runs, stake, next, ...frames, clock, note, glow); face({ a, els, active, score }); return; }

    // Frames and seeds on Autodarts' cards
    for (const i of [0, 1]) {
      const f = frames[i];
      const r = rects[i];
      f.classList.toggle('act', active === i);
      f.style.height = `${Math.round(r.height)}px`;
      const p = player(a.players[i].id);
      html(f, p && p.seed ? `<span class="seed">${tr('SEED {n}', { n: p.seed })}</span>` : '');
      show(f, 'seeds', r.left, r.top, r.width);
    }

    const leftSide = rects[0].left <= rects[1].left ? 0 : 1;
    const [L, R] = [rects[leftSide], rects[1 - leftSide]];
    const b = s.board && s.board.getBoundingClientRect();
    const tk = tickerPos();
    const top = tk === 'top' ? TICKER_H : 0;
    const bottom = (tk === 'bottom' ? vh - TICKER_H : vh) - 8;
    // Autodarts' bar under the board (its buttons): the boxes stop above it
    const barTop = Math.min(bottom, ...s.bars.map(x => x.getBoundingClientRect()).filter(r => r.top > vh * 0.6).map(r => r.top - 10));
    const side = b && L.right <= b.left + 40 && R.left >= b.right - 40;
    for (const p of s.pills) p.removeAttribute('data-ag-hide');
    const runKey = (i) => (i === leftSide ? 'runL' : 'runR');
    // Board ring, clock and the own note: wherever the layout is
    if (b && (partOn('glow') || PREVIEW)) {
      glow.style.height = `${Math.round(b.height)}px`;
      show(glow, 'glow', b.left, b.top, b.width);
    } else hide(glow);
    // The clock and the note go last: into a free spot once everything else stands
    // Autodarts' own parts after the layout (the checkout keeps clear of the boxes), then the clock
    // and the note go last: into a free spot once everything else stands
    try { layout(); makeWay(); } finally { face({ a, els, active, score }); clockBox(clock, m, b, els); noteBox(note, b, els); }
    function layout() {

    // A moved header is a panel of its own: wide enough, the band; else stacked
    const hdrMoved = moved('header');
    if (hdrMoved) {
      const wide = hdrMoved.w >= 460;
      hdr.className = `box panel hdr ${wide ? 'hero' : 'solo'}`;
      html(hdr, headerHtml(m, need, sets, wide ? 'hero' : 'side'));
      hdr.style.maxHeight = '';
      show(hdr, 'header', 0, 0, 0, true, 'header');
      fitText(hdr.querySelector('.stage'));
    }
    // A moved race is the race panel, never the puck
    const raceMoved = moved('race');
    if (raceMoved) {
      race.className = 'box panel race';
      html(race, raceHtml(a, score, active, need, sets, leftSide));
      show(race, 'race', 0, 0, 0, true, 'race');
    }

    if (side) {
      // Above the left card: tournament, stage, match. Above the right one: the race to the winning leg.
      const room = L.top - 90 - top;
      if (!hdrMoved) {
        hdr.className = 'box hdr';
        html(hdr, headerHtml(m, need, sets, 'side'));
        hdr.style.width = `${Math.round(L.width)}px`;
        fitText(hdr.querySelector('.stage'));
        // Above the card, shrunk a little when the room is short
        const ok = room > 60 && fitIn(hdr, L.top - 16 - (70 + top));
        show(hdr, 'header', L.left, L.top - 16 - hdr.offsetHeight * (Number(hdr.dataset.k) || 1), L.width, ok, 'header');
      }
      if (!raceMoved) {
        race.className = 'box panel race';
        html(race, raceHtml(a, score, active, need, sets, leftSide));
        race.style.width = `${Math.round(R.width)}px`;
        const ok = R.top - top > 130 && fitIn(race, R.top - 16 - (70 + top));
        show(race, 'race', R.left, R.top - 16 - race.offsetHeight * (Number(race.dataset.k) || 1), R.width, ok, 'race');
      }
      // Below each card: the player's run; further down what's at stake (or the table) and what's next
      let below = 0;
      for (const i of [0, 1]) {
        const r = rects[i];
        html(runs[i], runHtml(a, i, m));
        runs[i].style.maxHeight = '';
        show(runs[i], 'run', r.left, r.bottom + 14, r.width, r.bottom + 14 + (runs[i].offsetHeight || 80) < barTop, runKey(i));
        if (!moved(runKey(i))) below = Math.max(below, r.bottom + 14 + (partOn('run') || PREVIEW ? runs[i].offsetHeight || 80 : 0));
      }
      below = Math.max(below, L.bottom, R.bottom);
      const sh = stakeHtml(m, a);
      html(stake, sh);
      stake.style.maxHeight = '';
      show(stake, 'stake', L.left, below + 12, L.width, !!sh && below + 12 + (stake.offsetHeight || 90) < bottom, 'stake');
      const nx = upNext(m);
      html(next, nx);
      next.style.maxHeight = '';
      show(next, 'next', R.left, below + 12, R.width, !!nx && below + 12 + (next.offsetHeight || 90) < bottom, 'next');
      return;
    }

    // Top: the cards above the board. Between them (or under them) the band, below the board the rest.
    const cardsBottom = Math.max(L.bottom, R.bottom);
    const topEdge = Math.max(cardsBottom, ...s.bars.map(x => x.getBoundingClientRect()).filter(r => r.top >= cardsBottom - 4 && (!b || r.bottom <= b.top + 8)).map(r => r.bottom));
    const gapTop = b ? b.top - topEdge : 0;
    const w = vw - 32;
    if (gapTop >= 130) {
      // A hero band in the room above the board: the stage left, the race right. Autodarts' buttons
      // there (the camera button at the board's corner) stay free.
      let bl = 16, brt = vw - 16;
      for (const e of (document.querySelector('main') || document.body).querySelectorAll('button, a')) {
        const r = e.getBoundingClientRect();
        if (!r.width || r.width > 240 || r.bottom <= topEdge + 4 || r.top >= b.top) continue;
        if (r.right < vw * 0.35) bl = Math.max(bl, r.right + 12); else if (r.left > vw * 0.65) brt = Math.min(brt, r.left - 12);
      }
      const bw = brt - bl;
      const hw = (partOn('race') || PREVIEW) && !raceMoved ? bw * 0.58 : bw;
      if (!hdrMoved) {
        hdr.className = 'box panel hdr hero';
        html(hdr, headerHtml(m, need, sets, 'hero'));
        hdr.style.maxHeight = '';
        hdr.style.width = `${Math.round(hw)}px`;
        fitText(hdr.querySelector('.stage'));
        const ok = fitIn(hdr, gapTop - 24);
        show(hdr, 'header', bl, topEdge + 12, hw, ok, 'header');
      }
      if (!raceMoved) {
        race.className = 'box panel race';
        html(race, raceHtml(a, score, active, need, sets, leftSide));
        race.style.width = `${Math.round(bw * 0.42 - 12)}px`;
        const ok = fitIn(race, gapTop - 24);
        const hh = hdrMoved ? 0 : (hdr.offsetHeight || 120) * (Number(hdr.dataset.k) || 1);
        const rh = (race.offsetHeight || 110) * (Number(race.dataset.k) || 1);
        show(race, 'race', bl + bw * 0.58 + 12, topEdge + 12 + Math.max(0, (hh - rh) / 2), bw * 0.42 - 12, ok, 'race');
      }
    } else {
      // No room: a ribbon in the top bar (in place of Autodarts' own match line) and a score puck between the cards
      if (!hdrMoved) {
        hdr.className = 'box panel hdr rib';
        const rw = Math.min(vw - 320, 620);
        html(hdr, headerHtml(m, need, sets, 'rib', rw < 560));
        hdr.style.maxHeight = '';
        show(hdr, 'header', (vw - rw) / 2, Math.max(6 + top, top + (L.top - top - 44) / 2), rw, rw > 220 && L.top - top >= 44, 'header');
        fitText(hdr.querySelector('.disp'), 14);
        if (hdr.classList.contains('on')) {
          const hr = { left: (vw - rw) / 2, right: (vw + rw) / 2, top: 0, bottom: L.top };
          for (const p of s.pills) { const r = p.getBoundingClientRect(); if (r.right > hr.left && r.left < hr.right && r.top < hr.bottom && r.bottom > hr.top) p.setAttribute('data-ag-hide', ''); }
        }
      }
      if (!raceMoved) {
        race.className = 'box panel puck';
        html(race, puckHtml(m, score, need, sets, leftSide));
        const pw = 132;
        const seam = (L.right + R.left) / 2;
        // Low on the seam, under the big scores (wide fonts reach the middle higher up)
        show(race, 'race', seam - pw / 2, Math.min(L.bottom, R.bottom) - (race.offsetHeight || 76) - 10, pw, R.left - L.right < 60, 'race');
      }
    }
    // Below the board: the runs on the outside, at stake (or what's next) in the middle. A box too
    // tall for the room shrinks a little, else it waits for room (it is never cut off).
    const gapB = b ? barTop - b.bottom - 10 : 0;
    const cw = (w - 24) / 3;
    const y = b ? b.bottom + 8 : 0;
    const sh = stakeHtml(m, a);
    const nx = upNext(m);
    html(stake, sh);
    html(next, nx);
    // At stake in the middle, what's next beside it when a run was moved away (or in its place)
    const slots = [[runs[leftSide], 'run', runKey(leftSide)], [sh ? stake : next, sh ? 'stake' : 'next', sh ? 'stake' : 'next'], [runs[1 - leftSide], 'run', runKey(1 - leftSide)]];
    const rest = sh ? [next, 'next', 'next'] : null;
    for (const [i, slot] of slots.entries()) {
      let [el, part, key] = slot;
      // A run moved elsewhere: what's next takes its column
      if ((el === runs[0] || el === runs[1]) && moved(key) && rest && !rest.used && !moved('next')) {
        html(el, runHtml(a, el === runs[0] ? 0 : 1, m));
        el.style.maxHeight = '';
        show(el, part, 0, 0, 0, true, key);
        [el, part, key] = rest;
        rest.used = true;
      }
      if (el === runs[0] || el === runs[1]) html(el, runHtml(a, el === runs[0] ? 0 : 1, m));
      el.style.maxHeight = '';
      if (moved(key)) { show(el, part, 0, 0, 0, true, key); continue; }
      el.style.width = `${Math.round(cw)}px`;
      const html0 = el === stake ? sh : el === next ? nx : 'x';
      const ok = !!html0 && fitIn(el, gapB);
      const k = Number(el.dataset.k) || 1;
      show(el, part, 16 + i * (cw + 12) + (cw - cw * k) / 2, y, cw, ok, key);
    }
    if (rest && !rest.used) {
      if (moved('next')) { next.style.maxHeight = ''; show(next, 'next', 0, 0, 0, !!nx, 'next'); } else hide(next);
    }
    if (!sh) hide(stake);
    }
  }

  /** A box the layout placed under one that was moved: to a free spot nearby, else out of the way */
  function makeWay() {
    const shown = [...ov.querySelectorAll('.box.on')].filter(e => e.dataset.key && !['clock', 'note'].includes(e.id));
    const fixed = shown.filter(e => moved(e.dataset.key)).map(e => e.getBoundingClientRect());
    if (!fixed.length) return;
    for (const e of shown) {
      if (moved(e.dataset.key)) continue;
      const r = e.getBoundingClientRect();
      if (!fixed.some(o => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top)) continue;
      const at = freeSpot(e, [r.left, r.top], ['clock', 'note']);
      if (!at.free) { hide(e); continue; }
      e.dataset.k = String(at.k);
      e.style.scale = at.k !== 1 ? String(at.k) : '';
      e.style.left = `${Math.round(at.x)}px`;
      e.style.top = `${Math.round(at.y)}px`;
    }
  }

  /** The clock: the time of day, the time since the match began, or both */
  const started = {};
  function clockBox(el, m, b, L) {
    const mode = (OV() || {}).clock || 'time';
    const key = `${(T() || {}).id}:${m.id}`;
    if (!started[key]) {
      let t0 = 0;
      try { t0 = Number(sessionStorage.getItem(`autoglow-clock:${key}`)) || 0; } catch { /* private mode */ }
      started[key] = t0 || Date.now();
      try { sessionStorage.setItem(`autoglow-clock:${key}`, String(started[key])); } catch { /* private mode */ }
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const sec = Math.max(0, Math.floor((Date.now() - started[key]) / 1000));
    const mt = sec >= 3600 ? `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}` : `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
    const one = (k, t) => `<div><div class="t disp">${t}</div><div class="k">${k}</div></div>`;
    const time = one(tr('Time'), `${pad(now.getHours())}:${pad(now.getMinutes())}`);
    const match = one(tr('Match time'), mt);
    html(el, mode === 'both' ? `<div class="two">${time}${match}</div>` : mode === 'match' ? match : time);
    el.style.width = '';
    el.style.width = `${Math.max(el.offsetWidth, 120)}px`;
    // A free spot near the board's top-right corner
    const vw = window.innerWidth;
    const at = moved('clock') ? null : freeSpot(el, b ? [b.right, b.top] : [vw - 16, 16], ['note']);
    el.dataset.k = at ? String(at.k) : '';
    show(el, 'clock', at ? at.x : 0, at ? at.y : 0, el.offsetWidth, true, 'clock');
  }

  /** A spot for a box where it covers nothing: not Autodarts' cards, bars, buttons or chips, not the
   * dartboard (a circle), not the other boxes. Searched on a grid, nearest to `near`; a little smaller
   * when nothing is free; remembered until the page changes. */
  const spots = {};
  function freeSpot(el, near, skip = []) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const pad = 6;
    const R = (r) => [r.left - pad, r.top - pad, r.right + pad, r.bottom + pad];
    const obst = [];
    const main = document.querySelector('main') || document.body;
    for (const e of [...Object.values(cards), ...found.bars, ...found.pills, ...main.querySelectorAll('button, a, header svg, header p, header span, header img')]) {
      if (!e || !e.isConnected || e.closest('[data-autoglow]') || (found.board && found.board.contains(e))) continue;
      const r = e.getBoundingClientRect();
      if (r.width && r.height && r.width < vw * 0.9) obst.push(R(r));
    }
    for (const e of ov.querySelectorAll('.box.on')) {
      if (e === el || ['glow', 'frame', 'brd', 'scx', 'oc', 'thr'].some(c => e.classList.contains(c)) || skip.includes(e.id)) continue;
      obst.push(R(e.getBoundingClientRect()));
    }
    const br = found.board && found.board.getBoundingClientRect();
    const circle = br && { x: br.left + br.width / 2, y: br.top + br.height / 2, r: br.width / 2 + pad };
    const w0 = el.offsetWidth, h0 = el.offsetHeight;
    const key = JSON.stringify([vw, vh, w0, h0, near.map(Math.round), obst.map(o => o.map(Math.round)), circle && Math.round(circle.r)]);
    if (spots[el.id] && spots[el.id].key === key) return spots[el.id].at;
    const tk = tickerPos();
    const y0 = tk === 'top' ? TICKER_H + 4 : 4, y1 = vh - (tk === 'bottom' ? TICKER_H + 4 : 4);
    const hits = (x, y, w, h) => {
      for (const o of obst) if (x < o[2] && x + w > o[0] && y < o[3] && y + h > o[1]) return true;
      if (circle) {
        const cx = Math.max(x, Math.min(circle.x, x + w)), cy = Math.max(y, Math.min(circle.y, y + h));
        if ((cx - circle.x) ** 2 + (cy - circle.y) ** 2 < circle.r ** 2) return true;
      }
      return false;
    };
    let at = null;
    for (const k of [1, 0.85, 0.7]) {
      const w = w0 * k, h = h0 * k;
      let best = null;
      for (let y = y0; y + h <= y1; y += 8) {
        for (let x = 4; x + w <= vw - 4; x += 8) {
          if (hits(x, y, w, h)) continue;
          // Nearest to the wanted corner: the box's own corner nearest to it
          const d = Math.hypot(Math.min(Math.abs(x - near[0]), Math.abs(x + w - near[0])), Math.min(Math.abs(y - near[1]), Math.abs(y + h - near[1])));
          if (!best || d < best.d) best = { d, x, y };
        }
      }
      if (best) { at = { x: best.x, y: best.y, k, free: true }; break; }
    }
    // Nowhere free: at the wanted corner, small
    if (!at) at = { x: Math.max(4, Math.min(near[0] - w0 * 0.7, vw - w0 * 0.7 - 4)), y: Math.max(y0, Math.min(near[1], y1 - h0 * 0.7)), k: 0.7 };
    spots[el.id] = { key, at };
    return at;
  }

  /** The own line of text (Overlay › Parts): the board's bottom-right corner unless it was moved */
  function noteBox(el, b) {
    const text = (OV() || {}).note || '';
    if (!text && !PREVIEW) { hide(el); return; }
    html(el, esc(text || '…'));
    // As wide as its words, up to a fifth of the screen; a free spot near the board's bottom-right corner
    el.style.width = 'max-content';
    const w = Math.min(Math.max(el.offsetWidth, 120), Math.max(260, window.innerWidth * 0.3));
    el.style.width = `${Math.round(w)}px`;
    const vw = window.innerWidth, vh = window.innerHeight;
    const at = moved('note') ? null : freeSpot(el, b ? [b.right, b.bottom] : [vw - 16, vh - 16]);
    el.dataset.k = at ? String(at.k) : '';
    show(el, 'note', at ? at.x : 0, at ? at.y : 0, w, !!text || PREVIEW, 'note');
  }

  // ---------------------------------------------------------------------------
  // Autodarts' own parts drawn anew (Overlay › Score & board, overlay.face): the score in a style,
  // the player cards in a layout, the three darts as tiles, the dartboard's colours, a frame of
  // lights round it, the hit markers numbered, the checkout route and its target, the big moments.
  // Autodarts' part stays where it is, faded out: it keeps its place, keeps working and is read on
  // every change, so a corrected score (an undo, an edited dart) shows at once, up as well as down.
  // ---------------------------------------------------------------------------
  const FACE = () => ({ score: 'auto', card: 'classic', throws: 'classic', board: 'classic', frame: 'none', markers: 'look', checkout: true, target: true, moments: true, logos: true, ...((OV() || {}).face || {}) });
  /** Score › Auto: each look's own score */
  const AUTO_SCORE = { autodarts: 'classic', arena: 'broadcast', flap: 'flap', poster: 'roll', mono: 'led', gazette: 'roll', blueprint: 'led', pop: 'roll', worldcup: 'neon' };
  const scoreStyle = () => { const f = FACE().score; return f === 'auto' ? AUTO_SCORE[(OV() || {}).look] || 'classic' : f; };
  const isC = (e, c) => e && e.classList && e.classList.contains(c);

  /** In a player's card: the score (its biggest number) and the averages (numbers like 61.3) */
  function cardParts(card) {
    let score = null, fs = 0;
    const avgs = [];
    for (const e of card.querySelectorAll('div, span, p, b')) {
      if (e.childElementCount || e.closest('svg') || e.closest('[data-autoglow]')) continue;
      const t = e.textContent.trim();
      if (/^\d{1,4}$/.test(t)) { const f = parseFloat(getComputedStyle(e).fontSize); if (f > fs) { fs = f; score = e; } } else if (/^\d+[.,]\d+$/.test(t)) avgs.push(t);
    }
    return { score, fs, value: score ? Number(score.textContent.trim()) : null, avgs };
  }
  /** Autodarts' three darts: a row of three slots, the turn's total beside it. A slot not thrown yet
   * may hold Autodarts' own checkout suggestion (class text-checkout-suggestion) or, when no finish is
   * on this turn, its setup darts (text-checkout-setup): read apart, those are not thrown */
  const isHint = (x) => isC(x, 'text-checkout-suggestion') || isC(x, 'text-checkout-setup');
  function throwsOf() {
    const main = shellEl() || document.body;
    for (const d of main.querySelectorAll('div')) {
      if (!isC(d, '@container')) continue;
      const row = d.parentElement;
      const slots = row ? [...row.children].filter(c => isC(c, '@container')) : [];
      if (slots.length !== 3 || slots[0] !== d) continue;
      const sum = isC(row.nextElementSibling, '@container') ? row.nextElementSibling : null;
      const read = (x) => (x.textContent || '').replace(/\s+/g, '').toUpperCase();
      const sug = slots.map(x => isHint(x));
      const text = slots.map((x, i) => (sug[i] ? '' : read(x)));
      const suggest = slots.map((x, i) => (sug[i] ? read(x) : '')).filter(Boolean);
      const total = sum ? (sum.textContent || '').trim() : '';
      const setup = slots.some(x => isC(x, 'text-checkout-setup'));
      return { row, slots, sum, text, suggest, setup, total, bust: /^(bust|überworfen)$/i.test(total) };
    }
    return null;
  }

  // Checkout: the route for what is left, with the darts left, ending on a double (or as the game ends)
  const DPREF = [20, 16, 18, 12, 10, 8, 14, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2, 1];
  const THROWS = (() => {
    const all = [];
    for (let n = 20; n >= 1; n--) {
      all.push({ t: `T${n}`, v: 3 * n, c: 1.2 + (20 - n) * 0.3, k: 'T' });
      all.push({ t: `D${n}`, v: 2 * n, c: 7 + DPREF.indexOf(n) * 0.25, k: 'D' });
      all.push({ t: String(n), v: n, c: 0.3 + (20 - n) * 0.25, k: 'S' });
    }
    all.push({ t: '25', v: 25, c: 5, k: 'S' }, { t: 'BULL', v: 50, c: 5, k: 'D' });
    return all;
  })();
  const routes = {};
  function checkout(rest, darts, out) {
    const mode = /master/i.test(out || '') ? 'M' : /straight|single/i.test(out || '') ? 'S' : 'D';
    const key = `${rest}:${darts}:${mode}`;
    if (key in routes) return routes[key];
    const ends = THROWS.filter(x => (mode === 'S' ? true : mode === 'M' ? x.k !== 'S' : x.k === 'D'));
    const endCost = (x) => (x.k === 'D' ? (x.t === 'BULL' ? 4 : DPREF.indexOf(x.v / 2) * 0.5) : x.k === 'T' ? 2 + (20 - x.v / 3) * 0.3 : 3 + (20 - x.v) * 0.2);
    let best = null;
    for (let d = 1; d <= darts && !best; d++) {
      const go = (left, n, path, cost) => {
        if (n === 0) {
          for (const e of ends) if (e.v === left) { const c = cost + endCost(e); if (!best || c < best.c) best = { c, path: [...path, e.t] }; }
          return;
        }
        for (const x of THROWS) if (x.v < left && (!path.length || x.v <= path[path.length - 1].v)) go(left - x.v, n - 1, [...path, x], cost + x.c);
      };
      if (rest <= 60 * (d - 1) + 50 || mode !== 'D') go(rest, d - 1, [], 0);
      if (best) best.path = best.path.map(x => (typeof x === 'string' ? x : x.t));
    }
    routes[key] = best ? best.path : null;
    return routes[key];
  }

  // The score as a picture: digits that flip, roll, light up or glow when they change
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
  const SEGP = { a: 'M9 5l5-5h32l5 5-5 5H14z', g: 'M9 50l5-5h32l5 5-5 5H14z', d: 'M9 95l5-5h32l5 5-5 5H14z',
    f: 'M5 9l5 5v28l-5 5-5-5V14z', b: 'M55 9l5 5v28l-5 5-5-5V14z', e: 'M5 53l5 5v28l-5 5-5-5V58z', c: 'M55 53l5 5v28l-5 5-5-5V58z' };
  const ledDigit = (n) => `<svg viewBox="-2 -2 64 104">${Object.entries(SEGP).map(([k, d]) => `<path d="${d}" class="${SEG[n].includes(k) ? 'on' : ''}"/>`).join('')}</svg>`;
  const rollCol = () => `<b>${Array.from({ length: 10 }, (_, i) => `<i>${i}</i>`).join('')}</b>`;
  /** Draw value in el at digit height h, as wide as w at most; animated when only the value changed */
  function paintScore(el, value, style, h, w) {
    const v = value == null ? '' : String(value);
    const sig = `${style}|${v.length}`;
    let sv = el.querySelector('.sv');
    const old = sv ? sv.dataset.v : null;
    if (!sv || sv.dataset.sig !== sig) {
      el.innerHTML = `<span class="sv ${style}"></span>`;
      sv = el.firstChild;
      sv.dataset.sig = sig;
      sv.innerHTML = [...v].map(() => `<span class="dg">${style === 'roll' ? rollCol() : ''}</span>`).join('');
    }
    // The LED display's glass is a little taller than its digits: h is the whole box
    if (style === 'led') h /= 1.24;
    sv.style.setProperty('--h', `${Math.round(h)}px`);
    const dgs = [...sv.children].filter(x => isC(x, 'dg'));
    [...v].forEach((c, i) => {
      const dg = dgs[i];
      const was = old != null && old.length === v.length ? old[i] : null;
      if (dg.dataset.c === c) return;
      dg.dataset.c = c;
      if (style === 'roll') dg.firstChild.style.transform = `translateY(${-Number(c) * 10}%)`;
      else if (style === 'led') dg.innerHTML = ledDigit(c);
      else dg.textContent = c;
      if (was != null && was !== c && style !== 'roll') { dg.classList.remove('flip'); void dg.offsetWidth; dg.classList.add('flip'); }
    });
    sv.dataset.v = v;
    // As wide as there is room: smaller digits when the number is wider
    const nat = sv.offsetWidth;
    if (w && nat > w) sv.style.setProperty('--h', `${Math.max(12, Math.floor(h * w / nat))}px`);
    return sv;
  }
  /** "−60" for a dart that took the score down; nothing for a correction (an undo, an edited dart,
   * a bust taking the score back). On an own card it stands in the card's corner, else over the score */
  function scoreDrop(el, from, to, dart, corner) {
    const at = corner || el.querySelector('.sv');
    if (!at) return;
    for (const old of (corner || el).querySelectorAll('.dlt')) old.remove();
    if (!dart || from == null || to == null || to >= from || PREVIEW) return;
    const d = document.createElement('span');
    d.className = `dlt${corner ? ' cn' : ''}`;
    d.textContent = `−${from - to}`;
    at.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }

  // The dartboard in Autodarts' picture: 1000 × 1000, the middle at 500, 20 at the top
  const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const RING = { bull: [0, 15.556], outer: [15.556, 37.778], in: [37.778, 215.556], T: [215.556, 237.778], out: [237.778, 355.556], D: [355.556, 377.778] };
  const arc = (r0, r1, a0, a1) => {
    const p = (r, a) => `${(r * Math.sin(a)).toFixed(1)} ${(-r * Math.cos(a)).toFixed(1)}`;
    if (r0 === 0) return `M0 0L${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}Z`;
    return `M${p(r0, a0)}L${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z`;
  };
  /** The board's area for a throw like T20, D16, 7, 25, BULL */
  function targetPath(t) {
    if (t === 'BULL') return `<circle r="${RING.bull[1]}"/>`;
    if (t === '25') return `<circle r="${(RING.outer[0] + RING.outer[1]) / 2}" fill="none" stroke-width="${RING.outer[1] - RING.outer[0]}" class="ringp"/>`;
    const m = /^([TD]?)(\d+)$/.exec(t);
    if (!m) return '';
    const i = ORDER.indexOf(Number(m[2]));
    if (i < 0) return '';
    const a0 = (i - 0.5) * Math.PI / 10, a1 = (i + 0.5) * Math.PI / 10;
    if (m[1]) return `<path d="${arc(...RING[m[1]], a0, a1)}"/>`;
    return `<path d="${arc(...RING.in, a0, a1)}"/><path d="${arc(...RING.out, a0, a1)}"/>`;
  }
  /** Board colours: [red rings, green rings, dark singles, light singles, wires, surround, numbers] */
  function boardColors(kind, L) {
    if (kind === 'mono') return ['#f2f2f2', '#8c8c8c', '#0b0b0b', '#3a3a3a', '#5a5a5a', '#000', '#bdbdbd'];
    if (kind === 'neon') return ['#ff2bd6', '#19f0ff', '#05060c', '#141b30', '#2c3d6e', '#030409', '#9fb3ff'];
    if (kind === 'wire') return ['#ffd23f', '#eaf2ff', '#0a2a5e', '#0e3878', '#9fc0f5', '#08224d', '#eaf2ff'];
    const gold = L.gold !== L.accent ? L.gold : `color-mix(in srgb,${L.accent} 45%,${L.ink})`;
    return L.light ? [L.accent, gold, L.ink, L.panel, L.muted, L.ink, L.bg]
      : [L.accent, gold, `color-mix(in srgb,${L.bg} 70%,#000)`, `color-mix(in srgb,${L.ink} 78%,${L.bg})`, L.muted, L.bg, L.muted];
  }
  const BOARD_VARS = ['red', 'green', 'dark', 'light', 'wire', 'sur', 'num'];

  /** The tournament's boxes over an area (not Autodarts' parts drawn here, not the frames) */
  const boxesOver = (r) => [...ov.querySelectorAll('.box.on')].filter(o => !/^(cd|sc|fin)\d$|^(thr|brd|tk|glow)$/.test(o.id) && !o.classList.contains('frame'))
    .map(o => o.getBoundingClientRect()).filter(q => q.width && q.bottom > r.top && q.top < r.bottom && q.right > r.left && q.left < r.right);
  /** The checkout bar's height on a card */
  const finH = (R) => Math.max(26, Math.min(46, R.height * 0.17));
  let faded = new Set();
  const face0 = { legs: null, turn: { n: 0, who: null }, bust: false, val: [null, null], thrown: 0, shot: 0 };
  let faceArgs = null;
  /** Autodarts' parts in the chosen looks; called with each render and on each change on the page */
  function face(args) {
    faceArgs = args;
    const { a, els, score } = args;
    // Autodarts' page changes before AutoGlow's live score does: its turn wins
    const shown = args.active == null ? -1 : turnOf(els);
    const active = shown < 0 ? args.active : shown;
    const F = FACE();
    const L = lookOf();
    const now = new Set();
    const fade = (e) => { if (!e) return; if (!e.hasAttribute('data-ag-fade')) e.setAttribute('data-ag-fade', ''); now.add(e); };
    const style = scoreStyle();
    const own = F.card !== 'classic';
    const tw = throwsOf();
    const thrown = tw ? tw.text.filter(Boolean).length : 0;
    // A dart came in since the last look (an undo or a new turn is not one)
    const dart = thrown > face0.thrown;
    face0.thrown = thrown;
    const out = (a.settings || {}).out_mode;
    let target = null;
    for (const i of [0, 1]) {
      const card = els[i];
      const cb = box(`cd${i}`, `oc ${F.card}${active === i ? ' act' : ''}`);
      const sb = box(`sc${i}`, 'scx');
      const fb = box(`fin${i}`, 'fin');
      cb.style.zIndex = '-1'; sb.style.zIndex = '-1';
      if (!card) { hide(cb, sb, fb); continue; }
      const R = card.getBoundingClientRect();
      const cp = cardParts(card);
      const val = cp.value;
      // A changed score: "−140" when it went down
      const prev = face0.val[i];
      face0.val[i] = val;
      // The leg's last dart: the score down to 0
      if (prev && val === 0 && dart) face0.out = { i, v: prev };
      // The way out: Autodarts' own suggestion when it shows one, else worked out here
      const route = !(F.checkout && active === i && val != null && val <= 170) ? null
        : tw && tw.setup && thrown < 3 ? null
        : tw && tw.suggest.length && thrown < 3 ? tw.suggest.map(x => (/^(DB|BULL|BULLSEYE|50)$/.test(x) ? 'BULL' : x.replace(/^S(?=\d)/, '')))
          : checkout(val, thrown >= 3 ? 3 : 3 - thrown, out);
      if (route && !target) target = route[0];
      if (own) {
        fade(card);
        hide(sb);
        cb.style.width = `${Math.round(R.width)}px`;
        cb.style.height = `${Math.round(R.height)}px`;
        const p = player(a.players[i].id) || {};
        const nm = esc(a.players[i].name);
        const legs = score[i] || 0;
        const avg = cp.avgs.length ? cp.avgs[cp.avgs.length - 1] : '';
        const meta = `<span class="lg">${(a.settings || {}).sets ? tr('Sets') : tr('Legs')} <b>${legs}</b></span>${avg ? `<span class="av">Ø <b>${esc(avg)}</b></span>` : ''}${p.seed ? `<span class="av">#${p.seed}</span>` : ''}`;
        const sig = `${F.card}|${nm}|${meta}`;
        if (cb.dataset.sig !== sig) {
          cb.dataset.sig = sig;
          cb.innerHTML = F.card === 'strip' ? `<div class="l"><div class="nm disp">${nm}</div><div class="mt">${meta}</div></div><div class="num"></div>`
            : F.card === 'lower' ? `<div class="num"></div><div class="bar"><span class="nm disp">${nm}</span><span class="mt">${meta}</span></div>`
              : `<div class="nm disp">${nm}</div><div class="num"></div><div class="mt">${meta}</div>`;
        }
        cb.style.setProperty('--ch', `${Math.round(R.height)}px`);
        cb.style.setProperty('--cw', `${Math.round(R.width)}px`);
        const num = cb.querySelector('.num');
        const st = style === 'classic' ? 'plain' : style;
        cb.style.left = `${Math.round(R.left)}px`;
        cb.style.top = `${Math.round(R.top)}px`;
        cb.classList.add('on');
        // Room for the checkout (bottom, or top in the lower third) before the score takes the rest
        cb.classList.toggle('co', !!route);
        cb.style.setProperty('--fh', `${Math.round(finH(R))}px`);
        // Clear of the tournament's boxes standing on the card (the legs puck between the cards)
        for (const part of cb.querySelectorAll('.num, .bar, .l, .oc.minimal > .nm, .oc.minimal > .mt')) {
          part.style.paddingLeft = part.style.paddingRight = '';
          const nr = part.getBoundingClientRect();
          let inL = 0, inR = 0;
          for (const o of boxesOver(nr)) {
            if (o.left + o.width / 2 >= nr.left + nr.width / 2) inR = Math.max(inR, nr.right - o.left + 8); else inL = Math.max(inL, o.right - nr.left + 8);
          }
          if (inL || inR) { const bc = getComputedStyle(part); part.style.paddingLeft = `${Math.max(parseFloat(bc.paddingLeft), inL)}px`; part.style.paddingRight = `${Math.max(parseFloat(bc.paddingRight), inR)}px`; }
        }
        // The name as big as fits (once the card's parts stand clear)
        const nmEl = cb.querySelector('.nm');
        if (nmEl) { nmEl.style.fontSize = ''; let fs = parseFloat(getComputedStyle(nmEl).fontSize); while (nmEl.scrollWidth > nmEl.clientWidth + 1 && fs > 12) { fs -= 2; nmEl.style.fontSize = `${fs}px`; } }
        const ncs = getComputedStyle(num);
        const room = num.clientHeight - parseFloat(ncs.paddingTop) - parseFloat(ncs.paddingBottom) - 4;
        const h = Math.max(16, Math.min(R.height * 0.5, 170, room));
        paintScore(num, val, st, h, num.clientWidth - parseFloat(ncs.paddingLeft) - parseFloat(ncs.paddingRight) - 8);
        if (prev != null && val !== prev) scoreDrop(num, prev, val, dart, cb);
      } else {
        hide(cb);
        if (style === 'classic' || !cp.score) { hide(sb); } else {
          // Over Autodarts' own score, as big, never over the legs box beside it
          fade(cp.score);
          const r = cp.score.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          let lo = R.left + 12, hi = R.right - 12;
          for (const o of (cp.score.parentElement ? [...cp.score.parentElement.children] : [])) {
            if (o === cp.score) continue;
            const q = o.getBoundingClientRect();
            if (!q.width || q.bottom < r.top || q.top > r.bottom) continue;
            if (q.left >= cx) hi = Math.min(hi, q.left - 8); else lo = Math.max(lo, q.right + 8);
          }
          const w = Math.max(40, 2 * Math.min(cx - lo, hi - cx));
          const h = Math.min(cp.fs * 0.74, R.height * 0.36);
          sb.style.color = getComputedStyle(cp.score).color;
          sb.style.width = `${Math.round(w)}px`;
          const sv = paintScore(sb, val, style, h, w);
          if (prev != null && val !== prev) scoreDrop(sb, prev, val, dart);
          const bh = sv.offsetHeight;
          sb.style.height = `${Math.round(bh)}px`;
          sb.style.left = `${Math.round(cx - w / 2)}px`;
          sb.style.top = `${Math.round(Math.max(R.top + 4, Math.min(r.top + r.height / 2 - bh / 2, R.bottom - bh - 4)))}px`;
          sb.classList.add('on');
        }
      }
      // The route: along the bottom of the player's card (in the lower third: its top)
      if (route) {
        const h = finH(R);
        fb.style.setProperty('--fh', `${Math.round(h)}px`);
        html(fb, `<span class="k">${tr('Checkout')}</span>${route.map(x => `<b class="${x[0] === 'T' ? 't' : x[0] === 'D' || x === 'BULL' ? 'd' : ''}">${esc(x)}</b>`).join('')}`);
        // (in the lower third below the seed badge on the card's top edge)
        const y = own && F.card === 'lower' ? R.top + 18 : R.bottom - h - 8;
        // Across the card, clear of the tournament's boxes there (the legs puck between the cards)
        let lo = R.left + 10, hi = R.right - 10;
        for (const q of boxesOver({ left: lo, right: hi, top: y, bottom: y + h })) {
          if (q.left + q.width / 2 >= (lo + hi) / 2) hi = Math.min(hi, q.left - 8); else lo = Math.max(lo, q.right + 8);
        }
        fb.style.width = `${Math.round(Math.max(0, hi - lo))}px`;
        const fit = () => {
          let fs = h * 0.5;
          fb.style.fontSize = `${fs}px`;
          while (fb.scrollWidth > fb.clientWidth + 1 && fs > 10) { fs -= 1; fb.style.fontSize = `${fs}px`; }
          return fb.scrollWidth <= fb.clientWidth + 1;
        };
        // Short of room: without the word, else not at all (never cut)
        const k = fb.querySelector('.k');
        let fits = fit();
        if (!fits && k) { k.remove(); fb.dataset.h = ''; fits = fit(); }
        fb.style.left = `${Math.round(lo)}px`;
        fb.style.top = `${Math.round(y)}px`;
        fb.classList.toggle('on', fits);
        if (own) cb.classList.add('co');
      } else { hide(fb); cb.classList.remove('co'); }
    }
    throwTiles(F, tw, now, fade);
    boardFace(F, L, target, now, fade);
    moments(F, tw, thrown, active, args);
    for (const e of faded) if (!now.has(e)) e.removeAttribute('data-ag-fade');
    faded = now;
  }

  /** The three darts as tiles: what each hit, the next one lit, the turn's total */
  function throwTiles(F, tw, now, fade) {
    const el = box('thr', 'thr');
    el.style.zIndex = '-1';
    if (F.throws !== 'tiles' || !tw) { hide(el); return; }
    const r0 = tw.row.getBoundingClientRect();
    const r1 = tw.sum ? tw.sum.getBoundingClientRect() : r0;
    fade(tw.row);
    if (tw.sum) fade(tw.sum);
    const n = tw.text.filter(Boolean).length;
    const sg = tw.slots.map((x, i) => (isHint(x) ? (x.textContent || '').replace(/\s+/g, '').toUpperCase() : ''));
    const tile = (t, i) => {
      if (!t && sg[i]) return `<span class="tl sg${i === n ? ' nx' : ''}">${esc(sg[i])}</span>`;
      if (!t) return `<span class="tl${i === n ? ' nx' : ''}"><i></i></span>`;
      const m = /^([TDS]?)(\d+)$/.exec(t);
      const k = t === 'BULL' || t === 'BULLSEYE' || t === '50' || t === 'DB' ? 'b' : m ? (m[1] || 'S').toLowerCase() : /^M|MISS|^0$/.test(t) ? 'm' : 's';
      const label = k === 'b' ? 'BULL' : k === 'm' ? '×' : m ? `${m[1] && m[1] !== 'S' ? `<small>${m[1]}</small>` : ''}${m[2]}` : esc(t);
      return `<span class="tl ${k}">${label}</span>`;
    };
    html(el, `${tw.text.map(tile).join('')}<span class="tot disp">${esc(tw.bust ? tr('Bust') : tw.total || '0')}</span>`);
    el.classList.toggle('bust', !!tw.bust);
    el.style.left = `${Math.round(r0.left)}px`;
    el.style.top = `${Math.round(r0.top)}px`;
    el.style.width = `${Math.round(r1.right - r0.left)}px`;
    el.style.height = `${Math.round(r0.height)}px`;
    el.style.setProperty('--th', `${Math.round(r0.height)}px`);
    el.classList.add('on');
    // A wide font: each tile's words smaller until they fit
    for (const t of el.children) {
      t.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(t).fontSize);
      for (let k = 0; k < 14 && t.scrollWidth > t.clientWidth + 1 && fs > 9; k++) { fs *= 0.9; t.style.fontSize = `${fs}px`; }
    }
  }

  /** The board: its colours, its logos, a frame of lights, the checkout target, the hit markers */
  function boardFace(F, L, target, now, fade) {
    const el = box('brd', 'brd');
    el.style.zIndex = '-1';
    const board = found.board && found.board.isConnected ? found.board : null;
    const b = board && board.getBoundingClientRect();
    const wrap = board && board.parentElement;
    for (const e of document.querySelectorAll('[data-ag-board]')) if (e !== wrap) { e.removeAttribute('data-ag-board'); e.removeAttribute('data-ag-markers'); }
    if (!board || !b || board.tagName !== 'svg') { hide(el); return; }
    const layers = [...wrap.children].filter(e => e.tagName === 'svg');
    // Colours: Autodarts' own picture, recoloured
    if (F.board !== 'classic') {
      wrap.setAttribute('data-ag-board', F.board);
      boardColors(F.board, L).forEach((c, i) => wrap.style.setProperty(`--agb-${BOARD_VARS[i]}`, c));
    } else { wrap.removeAttribute('data-ag-board'); }
    wrap.toggleAttribute('data-ag-markers', F.markers === 'look');
    wrap.style.setProperty('--agb-hit', L.accent);
    if (!F.logos) for (const s of layers) if (s !== board && s.querySelector('[class^="cls-"]') && !s.querySelector('.cls-10, .cls-9')) fade(s);
    // The overlay's picture over the board
    const marks = [];
    if (F.markers === 'look') {
      const hits = layers.length ? layers[layers.length - 1] : null;
      for (const c of hits ? hits.querySelectorAll('circle[style*="fill"]') : []) {
        const q = c.getBoundingClientRect();
        if (!q.width) continue;
        marks.push([((q.left + q.width / 2 - b.left) / b.width) * 1000 - 500, ((q.top + q.height / 2 - b.top) / b.height) * 1000 - 500]);
      }
    }
    const frame = F.frame === 'leds' ? Array.from({ length: 60 }, (_, i) => { const a = i * Math.PI / 30; return `<circle cx="${(488 * Math.sin(a)).toFixed(1)}" cy="${(-488 * Math.cos(a)).toFixed(1)}" r="6" style="animation-delay:${(i * 0.05).toFixed(2)}s"/>`; }).join('')
      : F.frame === 'rings' ? '<circle r="494" class="rg"/><circle r="384" class="rg2"/>' : '';
    const tg = F.target && target ? targetPath(target) : '';
    const svg = `<svg viewBox="-500 -500 1000 1000"><g class="fr ${F.frame}">${frame}</g><g class="tg">${tg}</g><g class="mk">${marks.map(([x, y], i) => `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="17"/><text y="7">${i + 1}</text></g>`).join('')}</g></svg>`;
    html(el, svg);
    el.style.left = `${Math.round(b.left)}px`;
    el.style.top = `${Math.round(b.top)}px`;
    el.style.width = `${Math.round(b.width)}px`;
    el.style.height = `${Math.round(b.height)}px`;
    el.classList.toggle('on', !!(frame || tg || marks.length));
  }

  /** 180, 140+, 100+, bust and the leg's last dart: big over the board for a moment */
  function moments(F, tw, thrown, active, args) {
    const who = active;
    const t0 = face0.turn;
    let fire = null;
    if (face0.out) {
      fire = { big: tr('Game shot'), small: `${face0.out.v} · ${args.a.players[face0.out.i].name}`, cls: 'max' };
      face0.out = null;
      face0.shot = Date.now();
    }
    if (tw) {
      if (fire) { /* the leg's last dart says it all */ } else if (tw.bust && !face0.bust && t0.who === who) fire = { big: tr('Bust'), cls: 'bust' };
      else if (thrown === 3 && t0.n < 3 && t0.who === who) {
        const v = Number(tw.total) || 0;
        if (v === 180) fire = { big: '180', small: tr('One hundred and eighty!'), cls: 'max' };
        else if (v >= 140) fire = { big: String(v), small: tr('Ton forty plus') };
        else if (v >= 100) fire = { big: String(v), small: tr('Ton plus') };
      }
      face0.bust = !!tw.bust;
      face0.turn = { n: thrown, who };
    }
    const legs = (args.score[0] || 0) + (args.score[1] || 0);
    if (face0.legs != null && legs > face0.legs && !fire && Date.now() - face0.shot > 8000) fire = { big: tr('Game shot'), cls: 'max', small: '' };
    face0.legs = legs;
    if (fire && F.moments) moment(fire);
  }
  function moment(f) {
    const b = found.board && found.board.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const cx = b ? b.left + b.width / 2 : vw / 2, cy = b ? b.top + b.height / 2 : vh / 2;
    const size = Math.min(b ? b.width : vw * 0.5, vw * 0.9);
    root.querySelectorAll('.mo').forEach(e => e.remove());
    const el = document.createElement('div');
    el.className = `mo ${f.cls || ''}`;
    el.innerHTML = `<div class="big disp">${esc(f.big)}</div>${f.small ? `<div class="sm">${esc(f.small)}</div>` : ''}`;
    el.style.setProperty('--ms', `${Math.round(size * (f.big.length > 4 ? 0.17 : 0.26))}px`);
    ov.appendChild(el);
    // Never wider than the board (or the screen)
    const big = el.firstChild;
    for (let i = 0; i < 20 && el.offsetWidth > size * 0.96; i++) big.style.fontSize = `${parseFloat(getComputedStyle(big).fontSize) * 0.9}px`;
    el.style.left = `${Math.round(Math.max(4, Math.min(cx - el.offsetWidth / 2, vw - el.offsetWidth - 4)))}px`;
    el.style.top = `${Math.round(Math.max(4, Math.min(cy - el.offsetHeight / 2, vh - el.offsetHeight - 4)))}px`;
    const brd = root.getElementById('brd');
    if (brd) { brd.classList.remove('party'); void brd.offsetWidth; brd.classList.add('party'); setTimeout(() => brd.classList.remove('party'), 2200); }
    setTimeout(() => el.remove(), 2300);
  }
  // A change on Autodarts' page (a dart, an undo, an edited dart): drawn again at once
  let faceQueued = false;
  const faceObs = new MutationObserver((list) => {
    if (faceQueued || !faceArgs || !list.some(m => !host.contains(m.target))) return;
    faceQueued = true;
    setTimeout(() => { faceQueued = false; if (faceArgs && host.isConnected) face(faceArgs); }, 60);
  });
  let faceWatch = null;
  function watchFace() {
    const main = document.querySelector('main');
    if (!main || faceWatch === main) return;
    faceObs.disconnect();
    faceObs.observe(main, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    faceWatch = main;
  }
  function unface() {
    faceObs.disconnect();
    faceWatch = null;
    faceArgs = null;
    for (const e of document.querySelectorAll('[data-ag-fade]')) e.removeAttribute('data-ag-fade');
    for (const e of document.querySelectorAll('[data-ag-board], [data-ag-markers]')) { e.removeAttribute('data-ag-board'); e.removeAttribute('data-ag-markers'); }
    faded = new Set();
  }
  if (PREVIEW) window.autoglowMoment = (k) => moment(k === 'bust' ? { big: tr('Bust'), cls: 'bust' } : k === 'leg' ? { big: tr('Game shot'), cls: 'max' } : { big: '180', small: tr('One hundred and eighty!'), cls: 'max' });

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  // opts.intro: the Overlay page's preview plays the walk-on again
  window.autoglowMatch = (d, opts) => {
    data = d;
    if (dragBox && dragBox.done) dragBox = null;
    if (opts && opts.intro) { introForce = true; introDone = ''; }
    scanAt = 0;
    render();
    if (PREVIEW) editor.update();
  };
  window.agI18n.onChange(() => { if (data) render(); });
  // Autodarts moves its cards around (window size, its own menus): follow them
  setInterval(() => { if (data && pageMatch()) { render(); if (PREVIEW) editor.update(); } else if (host.isConnected) clear(); }, 400);

  // ---------------------------------------------------------------------------
  // The Overlay page's preview: select, move and size the boxes. A drag snaps a box's edges and
  // middle to the screen's, to the other boxes and to Autodarts' cards and board (Alt: no snapping).
  // Arrow keys nudge (Shift: further), Delete switches the part off, Esc lets go.
  // ---------------------------------------------------------------------------
  const editor = (() => {
    if (!PREVIEW) return null;
    const NAMES = { header: 'Stage', race: 'Legs', runL: 'Run left', runR: 'Run right', stake: 'At stake', next: 'Up next', winner: 'Winner', clock: 'Clock', note: 'Note',
      seeds: 'Seeds', intro: 'Walk-on', ticker: 'Ticker', logo: 'Logo', glow: 'Board glow', run: 'Run' };
    const SNAP = 8;
    const sel = document.createElement('div');
    sel.className = 'sel';
    sel.innerHTML = '<b></b><i class="hs" title="Size"></i><i class="hw" title="Width"></i>';
    const gx = document.createElement('div'); gx.className = 'guide x';
    const gy = document.createElement('div'); gy.className = 'guide y';
    const grid = document.createElement('div'); grid.className = 'gridov';
    let cur = null;      // { key, part }: what is selected
    let drag = null;
    const post = (msg) => window.parent.postMessage(msg, location.origin);
    const byKey = (k) => root.querySelector(`[data-key="${k}"]`);
    const byPart = (p) => root.querySelector(`[data-part="${p}"]:not([data-key])`) || root.querySelector(`[data-part="${p}"]`);
    const target = () => (cur ? (cur.key ? byKey(cur.key) : byPart(cur.part)) : null);
    const scaleOf = (el) => Number(el.style.scale) || 1;
    const pct = (b) => {
      const vw = window.innerWidth, vh = window.innerHeight, r2 = (v) => Math.round(v * 100) / 100;
      return { x: r2(b.x / vw * 100), y: r2(b.y / vh * 100), w: r2(b.w / vw * 100), s: Math.round(b.s * 100) / 100, h: r2((b.h || 0) * b.s / vh * 100) };
    };
    /** Where a box is now, in px (the layout's place for a box not moved yet) */
    const boxOf = (el) => ({ x: parseFloat(el.style.left) || el.getBoundingClientRect().left, y: parseFloat(el.style.top) || el.getBoundingClientRect().top, w: el.offsetWidth, h: el.offsetHeight, s: scaleOf(el) });

    function update() {
      for (const e of [sel, gx, gy, grid]) if (!e.isConnected) ov.appendChild(e);
      const el = target();
      const on = !!el && (el.classList.contains('on') || el.classList.contains('intro') || el.classList.contains('win'));
      sel.classList.toggle('on', on);
      if (!on) return;
      const r = el.getBoundingClientRect();
      Object.assign(sel.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      sel.classList.toggle('fixed', !cur.key);
      const label = NAMES[cur.key || cur.part] || cur.part;
      const k = scaleOf(el);
      sel.firstChild.textContent = cur.key ? `${label} · ${Math.round(k * 100)} %${moved(cur.key) ? '' : ' · auto'}` : label;
      // The label stays on the screen
      sel.firstChild.style.top = r.top < 40 ? `${r.height + 10}px` : '';
    }
    function select(key, part, tell = true) {
      cur = key || part ? { key, part: part || key } : null;
      update();
      if (tell) {
        const el = target();
        post({ type: 'ag-select', key: key || null, part: cur ? cur.part : null, box: el && key ? pct(boxOf(el)) : null, moved: !!(key && moved(key)), orient: orient() });
      }
    }

    /** Snap an edge or the middle of a box to the screen, the other boxes, the cards and the board */
    function snap(x, y, w, h, el) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const xs = [16, vw / 2, vw - 16], ys = [16, vh / 2, vh - 16];
      const others = [...root.querySelectorAll('.box.on, .win')].filter(e => e !== el && !e.classList.contains('tk')).map(e => e.getBoundingClientRect());
      for (const c of Object.values(cards)) if (c && c.isConnected) others.push(c.getBoundingClientRect());
      if (found.board) others.push(found.board.getBoundingClientRect());
      for (const r of others) { xs.push(r.left, r.right, (r.left + r.right) / 2); ys.push(r.top, r.bottom, (r.top + r.bottom) / 2); }
      const best = (pos, size, list) => {
        let out = null;
        for (const t of list) for (const [off, edge] of [[0, 0], [size / 2, 1], [size, 2]]) {
          const d = Math.abs(pos + off - t);
          if (d <= SNAP && (!out || d < out.d)) out = { d, pos: t - off, line: t, edge };
        }
        return out;
      };
      const sx = best(x, w, xs), sy = best(y, h, ys);
      return { x: sx ? sx.pos : x, y: sy ? sy.pos : y, lx: sx && sx.line, ly: sy && sy.line };
    }
    const guides = (lx, ly) => {
      gx.classList.toggle('on', lx != null); gy.classList.toggle('on', ly != null);
      if (lx != null) gx.style.left = `${lx}px`;
      if (ly != null) gy.style.top = `${ly}px`;
    };

    ov.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.hs, .hw');
      const el = handle ? target() : e.target.closest('[data-key]') || e.target.closest('[data-part]');
      if (!el) return;
      e.preventDefault();
      if (!handle) {
        const key = el.dataset.key || null;
        const part = el.dataset.part;
        if (!cur || cur.key !== key || cur.part !== part) select(key, part, false);
      }
      if (!cur || !cur.key) { select(cur && cur.key, cur && cur.part); return; }
      drag = { el, mode: handle ? (handle.classList.contains('hs') ? 'size' : 'width') : 'move', sx: e.clientX, sy: e.clientY, b: boxOf(el), h: el.offsetHeight, did: false };
      el.style.cursor = 'grabbing';
      window.focus();
    });
    addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.did && Math.hypot(dx, dy) < 4) return;
      drag.did = true;
      const b = { ...drag.b };
      const vw = window.innerWidth;
      if (drag.mode === 'move') {
        b.x += dx; b.y += dy;
        if (!e.altKey) { const sn = snap(b.x, b.y, b.w * b.s, drag.h * b.s, drag.el); b.x = sn.x; b.y = sn.y; guides(sn.lx, sn.ly); } else guides();
        // Whole on the screen
        const [y0, y1] = yRoom();
        b.x = Math.max(0, Math.min(b.x, vw - b.w * b.s));
        b.y = Math.max(y0, Math.min(b.y, y1 - drag.h * b.s));
      } else if (drag.mode === 'width') {
        b.w = Math.max(vw * 0.06, Math.min(vw, b.w + dx / b.s));
        guides();
      } else {
        b.s = Math.max(0.4, Math.min(3, b.s * (b.w * b.s + dx) / (b.w * b.s)));
        guides();
      }
      dragBox = { key: cur.key, box: pct(b) };
      render();
      update();
    });
    addEventListener('pointerup', () => {
      if (!drag) return;
      drag.el.style.cursor = '';
      guides();
      if (drag.did && dragBox) {
        dragBox.done = true;
        post({ type: 'ag-move', key: cur.key, box: dragBox.box, orient: orient() });
      } else select(cur.key, cur.part);
      drag = null;
    });
    addEventListener('keydown', (e) => {
      if (!cur) return;
      if (e.key === 'Escape') { select(null, null); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { post({ type: 'ag-hide', part: cur.part, orient: orient() }); return; }
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const el = target();
      if (!step || !cur.key || !el) return;
      e.preventDefault();
      const b = boxOf(el);
      const n = e.shiftKey ? 20 : 2;
      b.x = Math.max(0, Math.min(b.x + step[0] * n, window.innerWidth - b.w * b.s));
      b.y = Math.max(0, Math.min(b.y + step[1] * n, window.innerHeight - b.h * b.s));
      dragBox = { key: cur.key, box: pct(b), done: true };
      render();
      update();
      post({ type: 'ag-move', key: cur.key, box: dragBox.box, orient: orient() });
    });
    /** The Overlay page picked a part (its list), or wants the grid */
    window.autoglowSelect = (key, part) => select(key, part, true);
    window.autoglowGrid = (on) => grid.classList.toggle('on', !!on);
    return { update };
  })();
})();
