(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __objRest = (source, exclude) => {
    var target = {};
    for (var prop in source)
      if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
        target[prop] = source[prop];
    if (source != null && __getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(source)) {
        if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
          target[prop] = source[prop];
      }
    return target;
  };

  // js/tv-compat.js
  window.__started = 1;
  if (!Array.prototype.flatMap) {
    Object.defineProperty(Array.prototype, "flatMap", {
      configurable: true,
      writable: true,
      value(fn, self) {
        return this.reduce((out, x, i, a) => out.concat(fn.call(self, x, i, a)), []);
      }
    });
  }
  if (!Object.fromEntries) {
    Object.fromEntries = (it) => {
      const o = {};
      for (const [k, v] of it) o[k] = v;
      return o;
    };
  }
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function() {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (let i = 0; i < arguments.length; i++) {
        const n = arguments[i];
        this.appendChild(typeof n === "string" ? document.createTextNode(n) : n);
      }
    };
  }

  // js/tournament-model.js
  var FORMAT_NAME = { single_ko: "Single KO", double_ko: "Double KO", groups: "Groups \u2192 KO", league: "League", swiss: "Swiss" };
  var esc = (s) => String(s != null ? s : "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  var ordinal = (n) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
  var norm = (s) => String(s || "").trim().toLowerCase();
  var real = (m) => m.state !== "skipped" && !m.sides.some((s) => s.bye);
  function sourceText(side) {
    if (side.bye) return "Bye";
    const f = side.from || "";
    if (f.startsWith("W:")) return `Winner ${f.slice(2)}`;
    if (f.startsWith("L:")) return `Loser ${f.slice(2)}`;
    if (f.startsWith("G:")) return `${ordinal(+f.split(":")[2])} Group ${f.split(":")[1]}`;
    return "\u2013";
  }
  function finder(roster2) {
    const byId = new Map(roster2.map((p) => [p.id, p]));
    const byName = /* @__PURE__ */ new Map();
    for (const p of roster2) for (const n of [p.name, p.alias]) if (norm(n)) byName.set(norm(n), p);
    return (p) => byId.get(p.member) || byName.get(norm(p.name)) || byName.get(norm(p.ad_name)) || null;
  }
  function tally(results, sets) {
    var _a2, _b, _c, _d;
    const rows = /* @__PURE__ */ new Map();
    const row = (id) => rows.get(id) || rows.set(id, { id, played: 0, won: 0, legsFor: 0, legsAgainst: 0, avgSum: 0, avgN: 0, t180: 0 }).get(id);
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
        const avg = +((_b = (_a2 = r.stats) == null ? void 0 : _a2.average) == null ? void 0 : _b[i]) || 0;
        if (avg > 0) {
          p.avgSum += avg;
          p.avgN += 1;
          if (!out.best || avg > out.best.value) out.best = { value: avg, id, opp: m.sides[1 - i].player, m };
        }
        const n180 = +((_d = (_c = r.stats) == null ? void 0 : _c["180s"]) == null ? void 0 : _d[i]) || 0;
        p.t180 += n180;
        out.t180 += n180;
      }
    }
    const list = [...rows.values()].map((p) => __spreadProps(__spreadValues({}, p), { avg: p.avgN ? p.avgSum / p.avgN : 0 }));
    out.byAvg = list.filter((p) => p.avg > 0).sort((a, b) => b.avg - a.avg);
    out.by180 = list.filter((p) => p.t180 > 0).sort((a, b) => b.t180 - a.t180 || b.avg - a.avg);
    out.rows = rows;
    return out;
  }
  function stageLabel(T, ms, playing, next) {
    var _a2;
    const cur2 = ((_a2 = playing[0]) == null ? void 0 : _a2.m) || next[0];
    if (!cur2) return T.status === "finished" ? "Finished" : "";
    if (cur2.stage === "group" && T.format === "groups") return "Group stage";
    const many = ms.filter((m) => m.stage === cur2.stage && m.round === cur2.round && real(m)).length > 1;
    return many && /-final$/.test(cur2.label) ? `${cur2.label}s` : cur2.label;
  }
  function derive(body, roster2) {
    var _a2, _b, _c, _d;
    const T = body == null ? void 0 : body.tournament;
    if (!T) return null;
    const find = finder(roster2 || []);
    const who = (p) => {
      const s = find(p);
      return { id: p.id || "", name: p.name || "", seed: p.seed || 0, withdrawn: !!p.withdrawn, nick: (s == null ? void 0 : s.nickname) || "", img: (s == null ? void 0 : s.image) ? `/api/studio/images/${encodeURIComponent(s.image)}` : "" };
    };
    const players = new Map((T.players || []).map((p) => [p.id, who(p)]));
    const boards2 = (T.boards || []).filter((b) => b.approved && !b.left).sort((a, b) => a.number - b.number);
    const sets = (((_a2 = T.settings) == null ? void 0 : _a2.sets) || 0) > 0;
    const M = { T, players, boards: boards2, sets, lobby: T.status === "lobby" || !(T.matches || []).length, finished: T.status === "finished" };
    if (M.lobby) {
      M.entrants = (((_b = T.lobby) == null ? void 0 : _b.players) || T.players || []).map(who);
      M.settings = ((_c = T.lobby) == null ? void 0 : _c.settings) || T.settings || {};
      M.format = ((_d = T.lobby) == null ? void 0 : _d.format) || T.format;
      return M;
    }
    M.settings = T.settings || {};
    M.format = T.format;
    const ms = T.matches;
    const byId = new Map(ms.map((m) => [m.id, m]));
    const boardOf = (m) => (T.boards || []).find((b) => b.node_id === m.board);
    const liveOf = (m) => {
      var _a3;
      const b = boardOf(m);
      return ((_a3 = b == null ? void 0 : b.status) == null ? void 0 : _a3.match) === m.id && b.status.live ? b.status.live : m.last_live || null;
    };
    M.matches = ms;
    M.byId = byId;
    M.playing = ms.filter((m) => m.state === "live" || m.state === "assigned").map((m) => {
      var _a3;
      return { m, board: ((_a3 = boardOf(m)) == null ? void 0 : _a3.number) || 0, live: m.state === "live" ? liveOf(m) : null };
    }).sort((a, b) => a.board - b.board);
    M.next = (T.up_next || []).map((id) => byId.get(id)).filter(Boolean);
    M.results = ms.filter((m) => m.state === "done" && m.result && real(m)).sort((a, b) => b.done_seq - a.done_seq);
    M.stats = tally(M.results, sets);
    const all = ms.filter(real);
    M.progress = { total: all.length, done: all.filter((m) => m.state === "done").length, live: all.filter((m) => m.state === "live").length };
    M.stage = stageLabel(T, ms, M.playing, M.next);
    M.champion = T.champion ? players.get(T.champion) || null : null;
    return M;
  }
  function rulesOf(M) {
    const s = M.settings || {};
    const out = [];
    if (s.base_score) out.push(`${s.base_score} ${norm(s.out_mode) || "double"} out`);
    if (s.sets > 0) out.push(`First to ${s.sets} sets`);
    else if (s.legs) out.push(`First to ${s.legs}`);
    return out;
  }

  // js/tournament-dom.js
  var EASE = "cubic-bezier(.2, .8, .2, 1)";
  var calm = () => document.documentElement.classList.contains("calm");
  function sameKind(a, b) {
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
  }
  function patchNode(old, fresh, entered) {
    if (old.nodeType !== 1) {
      if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
      return;
    }
    for (const a of [...old.attributes]) if (!fresh.hasAttribute(a.name)) old.removeAttribute(a.name);
    for (const a of fresh.attributes) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
    if (!old.classList.contains("num")) patchChildren(old, fresh, entered);
  }
  function patchChildren(old, fresh, entered) {
    const keyed = /* @__PURE__ */ new Map();
    for (const c of old.children) if (c.dataset.k) keyed.set(c.dataset.k, c);
    let cur2 = old.firstChild;
    for (const n of [...fresh.childNodes]) {
      const key = n.nodeType === 1 ? n.dataset.k : "";
      let match = null;
      if (key) match = keyed.get(key);
      else if (cur2 && sameKind(cur2, n) && !(cur2.nodeType === 1 && cur2.dataset.k)) match = cur2;
      if (match && sameKind(match, n)) {
        if (match === cur2) cur2 = cur2.nextSibling;
        else old.insertBefore(match, cur2);
        if (key) keyed.delete(key);
        patchNode(match, n, entered);
      } else {
        old.insertBefore(n, cur2);
        entered.push(n);
      }
    }
    while (cur2) {
      const next = cur2.nextSibling;
      old.removeChild(cur2);
      cur2 = next;
    }
  }
  function patch(el, html) {
    if (el._html === html) return false;
    el._html = html;
    const before = /* @__PURE__ */ new Map();
    el.querySelectorAll("[data-flip]").forEach((n) => before.set(n.dataset.flip, n.getBoundingClientRect()));
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const entered = [];
    patchChildren(el, tpl.content, entered);
    el.querySelectorAll("[data-flip]").forEach((n) => {
      const a = before.get(n.dataset.flip);
      if (!a) return;
      const b = n.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 650, easing: EASE });
    });
    let i = 0;
    for (const n of entered) {
      if (n.nodeType !== 1) continue;
      for (const e of [...n.hasAttribute("data-in") ? [n] : [], ...n.querySelectorAll("[data-in]")]) {
        e.animate(calm() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(1.4rem)" }, { opacity: 1, transform: "none" }], { duration: 480, delay: Math.min(i, 10) * 55, easing: EASE, fill: "backwards" });
        i += 1;
      }
    }
    return true;
  }
  function reset(el) {
    el.replaceChildren();
    el._html = void 0;
    el._slots = void 0;
  }
  function count(el, from, to) {
    cancelAnimationFrame(el._raf);
    const a = Number(from);
    const b = Number(to);
    if (from === void 0 || from === "" || to === "" || Number.isNaN(a) || Number.isNaN(b)) {
      el.textContent = to;
      return;
    }
    const places = (String(to).split(".")[1] || "").length;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 600);
      el.textContent = (a + (b - a) * (1 - (1 - k) ** 3)).toFixed(places);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
    if (b > a && el.hasAttribute("data-pop") && !calm()) el.animate([{ transform: "none" }, { transform: "scale(1.35)" }, { transform: "none" }], { duration: 520, easing: EASE });
  }
  function flap(el, to, pad, first) {
    const s = String(to).padStart(pad, " ");
    if (el.children.length !== s.length) {
      el.innerHTML = [...s].map(() => '<span class="fl"> </span>').join("");
      first = true;
    }
    [...el.children].forEach((t, i) => {
      if (t.textContent === s[i]) return;
      t.textContent = s[i];
      if (!first) t.animate([{ transform: "rotateX(-88deg)" }, { transform: "rotateX(14deg)", offset: 0.6 }, { transform: "none" }], { duration: 480, delay: i * 70, easing: "cubic-bezier(.3, .7, .3, 1)", fill: "backwards" });
    });
  }
  function syncNums(root, tiles) {
    for (const el of root.querySelectorAll(".num")) {
      const to = el.dataset.num;
      const mode = tiles && +el.dataset.pad ? "tiles" : "text";
      if (el._v === to && el._mode === mode) continue;
      const from = el._mode === mode ? el._v : void 0;
      el._v = to;
      el._mode = mode;
      if (mode === "tiles") flap(el, to, +el.dataset.pad, from === void 0);
      else count(el, from, to);
    }
  }
  function flyWinners(body) {
    const now = /* @__PURE__ */ new Map();
    body.querySelectorAll("[data-slot]").forEach((n) => now.set(n.dataset.slot, n.dataset.p || ""));
    const was = body._slots;
    body._slots = now;
    if (!was) return;
    for (const [slot, p] of now) {
      if (!p || was.get(slot) !== "") continue;
      const dest = body.querySelector(`[data-slot="${slot}"]`);
      const src = [...body.querySelectorAll(`[data-p="${p}"]`)].find((n) => n !== dest && n.dataset.slot.split(":")[0] === dest.dataset.from);
      if (!src) continue;
      const a = src.getBoundingClientRect();
      const b = dest.getBoundingClientRect();
      dest.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)`, opacity: 0.4 }, { transform: "none", opacity: 1 }], { duration: 1100, easing: EASE });
    }
  }
  function swap(body, fill) {
    const ghost = body.cloneNode(true);
    ghost.removeAttribute("id");
    ghost.classList.add("is-out");
    body.parentNode.appendChild(ghost);
    const still = calm();
    ghost.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: still ? "none" : "translateX(-3rem)" }], { duration: still ? 700 : 320, easing: "ease-in", fill: "forwards" }).onfinish = () => ghost.remove();
    reset(body);
    fill();
    body.animate([{ opacity: 0, transform: still ? "none" : "translateX(4rem)" }, { opacity: 1, transform: "none" }], { duration: still ? 900 : 560, delay: still ? 300 : 160, easing: EASE, fill: "backwards" });
  }

  // js/tournament-scenes.js
  var hue = (n) => [...n].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  var initials = (n) => (n || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  var fix1 = (v) => Number(v).toFixed(1);
  function av(p) {
    if (!p) return '<span class="av tbd"></span>';
    return p.img ? `<span class="av pic"><img src="${esc(p.img)}" alt="" decoding="async"></span>` : `<span class="av" style="--h:${hue(p.name)}">${esc(initials(p.name))}</span>`;
  }
  var num = (v, cls = "", pad = 0, pop = false) => `<span class="num ${cls}" data-num="${esc(v)}"${pad ? ` data-pad="${pad}"` : ""}${pop ? " data-pop" : ""}></span>`;
  function sideOf(M, m, i) {
    const s = m.sides[i];
    const p = s.player ? M.players.get(s.player) || { name: s.player } : null;
    return { p, text: p ? esc(p.name) : `<span class="src">${esc(sourceText(s))}</span>` };
  }
  var nick = (p) => (p == null ? void 0 : p.nick) ? `<small>${esc(p.nick)}</small>` : "";
  var liveEntry = (M, m) => M.playing.find((e) => e.m.id === m.id);
  function header(M, cfg2, clock2) {
    const { done, total, live } = M.progress;
    const facts = [FORMAT_NAME[M.format] || "", `${[...M.players.values()].filter((p) => !p.withdrawn).length} players`, ...rulesOf(M)].filter(Boolean);
    const pips = total <= 15 ? `<div class="pips">${Array.from({ length: total }, (_, i) => `<i class="${i < done ? "d" : i < done + live ? "l" : ""}"></i>`).join("")}</div>` : `<div class="bar"><i style="transform:scaleX(${total ? done / total : 0})"></i></div>`;
    return `<div class="hd-logo">${cfg2.logo ? `<img src="${esc(cfg2.logo)}" alt="">` : '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3"><circle cx="16" cy="16" r="12"/><circle cx="16" cy="16" r="4.5" fill="currentColor" stroke="none"/></svg>'}</div>
    <div class="hd-t"><h1>${esc(cfg2.title || M.T.name || "Tournament")}</h1><div class="hd-s">${(cfg2.subtitle ? [cfg2.subtitle] : facts).map((f) => `<span>${esc(f)}</span>`).join("")}</div></div>
    ${M.stage ? `<div class="hd-stage"><div><small>${M.finished ? "Tournament" : "Now playing"}</small><b>${esc(M.stage)}</b></div></div>` : ""}
    <div class="hd-prog"><div><b>${num(done)}</b><span>of ${total} matches</span></div>${pips}</div>
    ${cfg2.clock ? `<div class="hd-clock">${num(clock2, "clk", 5)}</div>` : ""}`;
  }
  var scoreOf = (M, live, i) => {
    var _a2, _b;
    return live ? (_b = (_a2 = M.sets ? live.sets : live.legs) == null ? void 0 : _a2[i]) != null ? _b : 0 : "";
  };
  function bug(M, e) {
    const { m, live } = e;
    const row = (i) => {
      var _a2, _b, _c, _d;
      const { p, text } = sideOf(M, m, i);
      return `<div class="pr${live && live.active === i ? " act" : ""}"><i class="thr"></i>${av(p)}<div class="pn"><b>${text}</b>${nick(p)}</div>` + (live ? `${M.sets ? num((_b = (_a2 = live.legs) == null ? void 0 : _a2[i]) != null ? _b : 0, "sub") : ""}${num(scoreOf(M, live, i), "lg", 1, true)}${num((_d = (_c = live.remaining) == null ? void 0 : _c[i]) != null ? _d : "", "rm", 3)}` : "") + "</div>";
    };
    return `<div class="mc ${live ? "live" : "setup"}" data-k="mc-${m.id}" data-flip="mc-${m.id}" data-in>
    <div class="mh"><span class="bd"><small>Board</small>${e.board ? ` ${e.board}` : ""}</span><span class="ml">${esc(m.label)}</span>` + (live ? `<span class="cl l">${M.sets ? "Sets" : "Legs"}</span><span class="cl r">Left</span>` : '<span class="call">Players to the board</span>') + `</div>${row(0)}${row(1)}</div>`;
  }
  function hrow(M, e) {
    const { m, live } = e;
    const act = (i) => live && live.active === i ? " act" : "";
    const pl = (i) => {
      const { p, text } = sideOf(M, m, i);
      return `<div class="pl${i ? " r" : ""}${act(i)}">${av(p)}<div><b>${text}</b>${nick(p)}</div><i class="arr"></i></div>`;
    };
    const rem = (i) => {
      var _a2, _b;
      return num(live ? (_b = (_a2 = live.remaining) == null ? void 0 : _a2[i]) != null ? _b : "" : "", `rm${act(i)}`, 3);
    };
    const sc = (i) => num(scoreOf(M, live, i), "lg", 1, true);
    const sub = (i) => {
      var _a2, _b;
      return M.sets && live ? num((_b = (_a2 = live.legs) == null ? void 0 : _a2[i]) != null ? _b : 0, "sub") : "";
    };
    return `<div class="br ${live ? "live" : "setup"}" data-k="br-${m.id}" data-flip="br-${m.id}" data-in><div class="bno">${e.board || ""}</div>${pl(0)}${rem(0)}<div class="lgs">${sub(0)}${sc(0)}<em>:</em>${sc(1)}${sub(1)}</div>${rem(1)}${pl(1)}<div class="stt"><b>${live ? "<i></i>Live" : "Players to board"}</b><small>${esc(m.label)}</small></div></div>`;
  }
  function boards(M, rows) {
    if (!M.playing.length) return `<div class="mnote" data-k="none">${M.finished ? "All matches played" : "No match on a board right now"}</div>`;
    return M.playing.map((e) => rows ? hrow(M, e) : bug(M, e)).join("");
  }
  function upNext(M, max) {
    return M.next.slice(0, max).map((m) => `<div class="nx" data-k="nx-${m.id}" data-flip="nx-${m.id}" data-in><span class="id">${esc(m.id)}</span><span class="who">${sideOf(M, m, 0).text}<i>vs</i>${sideOf(M, m, 1).text}</span><span class="lb">${m.held ? "On hold" : esc(m.label)}</span></div>`).join("");
  }
  var MIN_PITCH = 7.6;
  var MIN_COL = 19;
  function treeOf(M, stages) {
    const allowed = new Set(stages);
    const shown = (m) => allowed.has(m.stage) && real(m) && !(m.stage === "gf" && m.round === 2 && m.state === "pending");
    const ms = M.matches.filter(shown);
    const kidsOf = (m) => [...new Set(m.sides.map((s) => s.from || "").filter((f) => /^[WL]:/.test(f)).map((f) => M.byId.get(f.slice(2))))].filter((k) => k && shown(k));
    const fed = new Set(ms.flatMap((m) => kidsOf(m).map((k) => k.id)));
    const root = ms.filter((m) => !fed.has(m.id)).pop();
    const node = (m) => ({ m, kids: kidsOf(m).map(node) });
    return root ? node(root) : null;
  }
  function measure(n, cut, d = 0) {
    if (d >= cut || !n.kids.length) return { leaves: 1, depth: 0 };
    const parts = n.kids.map((k) => measure(k, cut, d + 1));
    return { leaves: parts.reduce((a, p) => a + p.leaves, 0), depth: 1 + Math.max(...parts.map((p) => p.depth)) };
  }
  function bracketPages(root, size) {
    const maxLeaves = Math.max(2, Math.floor((size.h - 3.2) / MIN_PITCH));
    const maxCols = Math.max(2, Math.floor(size.w / MIN_COL));
    const fits = (n, cut = Infinity) => {
      const s2 = measure(n, cut);
      return s2.leaves <= maxLeaves && s2.depth + 1 <= maxCols;
    };
    if (fits(root)) return [{ root, cut: Infinity, last: true }];
    const levels = [[root]];
    while (levels[levels.length - 1].some((n) => n.kids.length)) levels.push(levels[levels.length - 1].flatMap((n) => n.kids));
    let s = 1;
    while (s < levels.length - 1 && !levels[s].every((n) => fits(n))) s += 1;
    let c = levels.length - 1;
    while (c > 1 && !fits(root, c)) c -= 1;
    const pages = levels[s].filter((n) => n.kids.length).map((n) => ({ root: n, cut: Infinity }));
    pages.push({ root, cut: c, last: true });
    return pages;
  }
  function place(root, cut) {
    const nodes = [];
    const links = [];
    let leaf = 0;
    const walk = (n, d) => {
      const kids = d < cut ? n.kids : [];
      const ys = kids.map((k) => walk(k, d + 1));
      const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : leaf++;
      nodes.push({ m: n.m, d, y });
      kids.forEach((k, i) => links.push({ d, y, ky: ys[i], done: k.m.state === "done" }));
      return y;
    };
    walk(root, 0);
    return { nodes, links, leaves: leaf, depth: Math.max(...nodes.map((n) => n.d)) };
  }
  function matchBox(M, m, tags) {
    var _a2;
    const done = m.state === "done" && m.result;
    const e = m.state === "live" ? liveEntry(M, m) : null;
    const row = (i) => {
      var _a3;
      const s = m.sides[i];
      const { p, text } = sideOf(M, m, i);
      const cls = done ? m.result.winner === i ? "win" : "lose" : ((_a3 = e == null ? void 0 : e.live) == null ? void 0 : _a3.active) === i ? "act" : "";
      const sc = done ? m.result.walkover ? i === m.result.winner ? "W" : "\u2013" : m.result.legs[i] : (e == null ? void 0 : e.live) ? scoreOf(M, e.live, i) : "";
      return `<div class="bp ${cls}" data-slot="${m.id}:${i}" data-p="${esc(s.player || "")}" data-from="${esc((s.from || "").slice(2))}">${av(p)}<span class="n">${text}</span>${num(sc, "lg", 0, true)}</div>`;
    };
    const board = (e == null ? void 0 : e.board) || ((_a2 = M.playing.find((x) => x.m.id === m.id)) == null ? void 0 : _a2.board);
    const tag = !tags ? "" : m.state === "live" ? `<span class="bm-tag">${board ? `Board ${board} \xB7 ` : ""}Live</span>` : m.state === "assigned" ? `<span class="bm-tag">Next${board ? ` \xB7 Board ${board}` : ""}</span>` : "";
    return `<div class="bm ${m.state}">${tag}${row(0)}${row(1)}</div>`;
  }
  var colTitle = (ms) => {
    const l = ms[0].label.replace(/^Winners /, "").replace(/^Losers round/, "Round");
    return ms.length > 1 && /-final$/.test(l) ? `${l}s` : l;
  };
  function bracketHTML(M, page, size) {
    const { root, cut } = page;
    const split = size.w >= 150 && root.kids.length === 2 && cut > 0;
    let nodes;
    let links;
    let cols;
    let leaves;
    if (split) {
      const [a, b] = root.kids.map((k) => place(k, cut - 1));
      const D = Math.max(a.depth, b.depth) + 1;
      cols = 2 * D + 1;
      leaves = Math.max(a.leaves, b.leaves);
      const half = (h, right) => ({
        nodes: h.nodes.map((n) => ({ m: n.m, col: right ? D + 1 + n.d : D - 1 - n.d, y: (n.y + 0.5) / h.leaves })),
        links: h.links.map((l2) => ({ col: right ? D + 1 + l2.d : D - 1 - l2.d, y: (l2.y + 0.5) / h.leaves, ky: (l2.ky + 0.5) / h.leaves, right, done: l2.done }))
      });
      const [l, r] = [half(a, false), half(b, true)];
      nodes = [...l.nodes, { m: root.m, col: D, y: 0.5, fin: true }, ...r.nodes];
      links = [
        ...l.links,
        ...r.links,
        { col: D, y: 0.5, ky: (a.nodes[a.nodes.length - 1].y + 0.5) / a.leaves, done: root.kids[0].m.state === "done" },
        { col: D, y: 0.5, ky: (b.nodes[b.nodes.length - 1].y + 0.5) / b.leaves, right: true, done: root.kids[1].m.state === "done" }
      ];
    } else {
      const p = place(root, cut);
      cols = p.depth + 1;
      leaves = p.leaves;
      nodes = p.nodes.map((n) => ({ m: n.m, col: p.depth - n.d, y: (n.y + 0.5) / p.leaves }));
      links = p.links.map((l) => ({ col: p.depth - l.d, y: (l.y + 0.5) / p.leaves, ky: (l.ky + 0.5) / p.leaves, done: l.done }));
    }
    const bodyH = size.h - 3.2;
    const pitch = bodyH / leaves;
    const W = Math.min(size.w, cols * 50);
    const cw = W / cols;
    const bh = clamp(Math.min((pitch - 2.8) / 2, cw * 0.16), 3.2, 6.4);
    const g = clamp(cw * 0.06, 0.8, 2);
    const longest = Math.min(18, Math.max(6, ...nodes.flatMap((n) => n.m.sides.map((s) => {
      var _a2;
      return (((_a2 = M.players.get(s.player)) == null ? void 0 : _a2.name) || sourceText(s) || "").length;
    }))));
    const nameW = cw - 2 * g - 1.94 * bh;
    const bf = clamp(Math.min(bh * 0.5, nameW / (longest * 0.52)), 1.8, 3.2);
    const tags = pitch - 2 * bh >= 2.6;
    const gx = g / W * 1e3;
    const paths = links.map((l) => {
      const edge = (l.right ? l.col + 1 : l.col) / cols * 1e3;
      const dir = l.right ? 1 : -1;
      return `<path class="${l.done ? "on" : ""}" vector-effect="non-scaling-stroke" d="M${(edge + dir * gx).toFixed(1)} ${(l.ky * 1e3).toFixed(1)}H${edge.toFixed(1)}V${(l.y * 1e3).toFixed(1)}H${(edge - dir * gx).toFixed(1)}"/>`;
    }).join("");
    const heads = Array.from({ length: cols }, (_, c) => nodes.filter((n) => n.col === c).map((n) => n.m)).map((ms, c) => ms.length ? `<span style="left:${c / cols * 100}%;width:${100 / cols}%">${esc(colTitle(ms))}</span>` : "").join("");
    const boxes = nodes.map((n) => `<div class="bn${n.fin ? " fin" : ""}" data-k="bn-${n.m.id}" style="left:${n.col / cols * 100}%;width:${100 / cols}%;top:calc(${(n.y * 100).toFixed(3)}% - ${bh}rem)">${matchBox(M, n.m, tags)}</div>`).join("");
    return `<div class="bk${split ? " split" : ""}" style="width:${W.toFixed(2)}rem;margin:0 auto;--bh:${bh.toFixed(2)}rem;--g:${g.toFixed(2)}rem;--bf:${bf.toFixed(2)}rem"><div class="bk-h">${heads}</div><div class="bk-b"><svg class="bk-l" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${boxes}</div></div>`;
  }
  function bracketScenes(M, size) {
    const sets = M.format === "double_ko" ? [["Winners", ["wb", "gf"]], ["Losers", ["lb"]]] : M.format === "groups" ? [["Knockout", ["ko"]]] : [["Bracket", ["main"]]];
    const out = [];
    for (const [name, stages] of sets) {
      const root = treeOf(M, stages);
      if (!root) continue;
      const pages = bracketPages(root, size);
      const open = pages.filter((p) => p.last || !allDone(p.root));
      open.forEach((p, i) => out.push({ id: `bracket:${stages[0]}:${p.root.m.id}:${p.last ? "x" : ""}`, kind: "bracket", name, part: open.length > 1 ? `${i + 1}/${open.length}` : "", html: () => bracketHTML(M, p, size) }));
    }
    return out;
  }
  var allDone = (n) => n.m.state === "done" && n.kids.every(allDone);
  function tableHTML(M, t, rows, from, rh, title, narrow) {
    const swiss = M.format === "swiss";
    const adv = M.format === "groups" ? M.T.advance || 0 : 0;
    const head = `<div class="tr th"><span></span><span></span>${narrow ? "" : "<span>P</span>"}<span>W</span><span>L</span><span>Legs</span>${narrow ? "" : `<span>${swiss ? "Buch" : "180"}</span>`}<span>Avg</span></div>`;
    const body = rows.map((r, i) => {
      const rank = from + i;
      const cls = adv ? (rank < adv ? " q" : "") + (rank === adv - 1 && t.rows.length > adv ? " cut" : "") : rank === 0 && r.played ? " q" : "";
      return `<div class="tr${cls}" data-k="tr-${esc(t.name)}-${esc(r.player)}" data-flip="tr-${esc(t.name)}-${esc(r.player)}"><span class="rk">${rank + 1}</span><span class="nm">${av(M.players.get(r.player))}<b>${esc(r.name)}</b></span>${narrow ? "" : `<span>${r.played}</span>`}<span>${r.won}</span><span>${r.lost}</span><span>${r.legs_for}:${r.legs_against}</span>${narrow ? "" : `<span>${swiss ? r.buchholz : r.t180 || 0}</span>`}<span class="avg">${r.average ? fix1(r.average) : "\u2013"}</span></div>`;
    }).join("");
    return `<div class="tb${narrow ? " nar" : ""}" style="--rh:${rh.toFixed(2)}rem">${title ? `<h3>${title}</h3>` : ""}${head}${body}</div>`;
  }
  var widthRh = (rh, tw, narrow) => Math.min(rh, tw / ((narrow ? 12.2 : 16.5) + 1 + 8) / 0.52);
  function groupTally(M, name) {
    const ms = M.matches.filter((m) => m.stage === "group" && m.group === name && real(m));
    const done = ms.filter((m) => m.state === "done").length;
    return done === ms.length ? "done" : `${done}/${ms.length}`;
  }
  function tableScenes(M, size) {
    const tables = M.T.tables || [];
    if (!tables.length) return [];
    const name = M.format === "swiss" ? "Standings" : M.format === "league" ? "Table" : "Groups";
    const scene2 = (i, n, html) => ({ id: `tables:${i}`, kind: "tables", name, part: n > 1 ? `${i + 1}/${n}` : "", html });
    const MIN_RH = 3.6;
    if (tables.length === 1) {
      const t = tables[0];
      const n = t.rows.length;
      const fitRows = Math.floor((size.h - 3.4) / MIN_RH);
      const cols2 = n > fitRows && size.w >= 110 ? 2 : 1;
      const perCol = Math.min(Math.ceil(n / cols2), fitRows);
      const perPage2 = perCol * cols2;
      const pages2 = Math.ceil(n / perPage2);
      const narrow2 = size.w / cols2 < 62;
      const rh2 = widthRh(clamp((size.h - 3.4) / perCol, MIN_RH, 6.6), (size.w - (cols2 - 1) * 2.4) / cols2, narrow2);
      return Array.from({ length: pages2 }, (_, pg) => scene2(pg, pages2, () => {
        const parts = Array.from({ length: cols2 }, (_2, c) => t.rows.slice(pg * perPage2 + c * perCol, pg * perPage2 + (c + 1) * perCol)).filter((r) => r.length);
        return `<div class="tbs" style="grid-template-columns:repeat(${parts.length}, minmax(0, 1fr))">${parts.map((rows, c) => tableHTML(M, t, rows, pg * perPage2 + c * perCol, rh2, "", narrow2)).join("")}</div>`;
      }));
    }
    const maxRows = Math.max(...tables.map((t) => t.rows.length));
    const rhFor = (r) => ((size.h - (r - 1) * 2) / r - 7.4) / maxRows;
    let best = null;
    for (let c = 1; c <= Math.min(tables.length, 4); c += 1) {
      let gridRows = Math.ceil(tables.length / c);
      while (gridRows > 1 && rhFor(gridRows) < MIN_RH) gridRows -= 1;
      const narrow2 = size.w / c < 62;
      const rh2 = widthRh(clamp(rhFor(gridRows), 3, 6), (size.w - (c - 1) * 2.4) / c, narrow2);
      const pages2 = Math.ceil(tables.length / (gridRows * c));
      if (!best || pages2 < best.pages || pages2 === best.pages && rh2 > best.rh + 0.05) best = { cols: c, perPage: gridRows * c, pages: pages2, rh: rh2, narrow: narrow2 };
    }
    const { cols, perPage, pages, rh, narrow } = best;
    return Array.from({ length: pages }, (_, pg) => scene2(pg, pages, () => {
      const part = tables.slice(pg * perPage, (pg + 1) * perPage);
      return `<div class="tbs" style="grid-template-columns:repeat(${Math.min(cols, part.length)}, minmax(0, 1fr))">${part.map((t) => tableHTML(M, t, t.rows, 0, rh, `Group ${esc(t.name)}<small>${groupTally(M, t.name)}</small>`, narrow)).join("")}</div>`;
    }));
  }
  function resultRow(M, m) {
    const r = m.result;
    const p = (i) => {
      var _a2, _b, _c, _d;
      const { p: pl, text } = sideOf(M, m, i);
      const avg = +((_b = (_a2 = r.stats) == null ? void 0 : _a2.average) == null ? void 0 : _b[i]) || 0;
      const t = +((_d = (_c = r.stats) == null ? void 0 : _c["180s"]) == null ? void 0 : _d[i]) || 0;
      const note = [avg ? `avg ${fix1(avg)}` : "", t ? `${t} \xD7 180` : ""].filter(Boolean).join(" \xB7 ");
      return `<span class="rs-p${r.winner === i ? " win" : ""}${i ? " r" : ""}">${av(pl)}<span><b>${text}</b>${note ? `<small>${note}</small>` : ""}</span></span>`;
    };
    const score = r.walkover ? r.winner === 0 ? "W<i>\u2013</i>L" : "L<i>\u2013</i>W" : `${r.legs[0]}<i>\u2013</i>${r.legs[1]}`;
    return `<div class="rs-row" data-k="rs-${m.id}" data-flip="rs-${m.id}" data-in><div class="rs-k">${esc(m.id)} \xB7 ${esc(m.label)}${r.walkover ? " \xB7 walkover" : ""}</div><div class="rs-r">${p(0)}<b class="rs-s">${score}</b>${p(1)}</div></div>`;
  }
  function resultScenes(M, size) {
    if (!M.results.length) return [];
    const u = clamp(size.w / 95, 0.7, 1);
    const cols = size.w >= 150 ? 2 : 1;
    const n = Math.max(1, Math.floor((size.h + 1.6 * u) / (13.2 * u))) * cols;
    return [{ id: "results", kind: "results", name: "Results", part: "", html: () => `<div class="rs" style="--u:${u.toFixed(3)}rem;grid-template-columns:repeat(${cols}, minmax(0, 1fr))">${M.results.slice(0, n).map((m) => resultRow(M, m)).join("")}</div>` }];
  }
  function leaderTiles(M) {
    const st = M.stats;
    const tiles = [];
    if (st.best) tiles.push(["Best match average", fix1(st.best.value), M.players.get(st.best.id)]);
    if (st.by180[0]) tiles.push(["Most 180s", st.by180[0].t180, M.players.get(st.by180[0].id)]);
    const record = [...st.rows.values()].sort((a, b) => b.won - a.won || b.legsFor - b.legsAgainst - (a.legsFor - a.legsAgainst))[0];
    if (record == null ? void 0 : record.won) tiles.push(["Most wins", record.won, M.players.get(record.id)]);
    return tiles;
  }
  function leaderScenes(M, size) {
    const st = M.stats;
    if (!st.byAvg.length && !st.by180.length) return [];
    const u = clamp(size.w / 95, 0.62, 1);
    return [{
      id: "leaders",
      kind: "leaders",
      name: "Leaders",
      part: "",
      html: () => {
        const tiles = leaderTiles(M).slice(0, size.w >= 150 ? 3 : 2);
        const rows = Math.max(0, Math.floor((size.h - 21 * u - 4 * u) / (7 * u)));
        const list = st.byAvg.slice(0, rows);
        return `<div class="ld" style="--u:${u.toFixed(3)}rem"><div class="ld-tiles" style="grid-template-columns:repeat(${tiles.length}, minmax(0, 1fr))">` + tiles.map(([k, v, p]) => `<div class="ld-t" data-k="ld-${k}" data-in>${av(p)}<div><small>${k}</small><b>${num(v)}</b><span>${esc((p == null ? void 0 : p.name) || "")}</span></div></div>`).join("") + "</div>" + (list.length ? `<div class="ld-tb"><div class="ld-h"><span>Tournament average</span><span>Won</span><span>Legs</span><span>180</span><span>Avg</span></div>` + list.map((r, i) => {
          var _a2;
          return `<div class="ld-r" data-k="ld-${r.id}" data-flip="ld-${r.id}" data-in><i>${i + 1}</i>${av(M.players.get(r.id))}<b>${esc(((_a2 = M.players.get(r.id)) == null ? void 0 : _a2.name) || r.id)}</b><span>${r.won}/${r.played}</span><span>${r.legsFor}:${r.legsAgainst}</span><span>${r.t180}</span><em>${fix1(r.avg)}</em></div>`;
        }).join("") + "</div>" : "") + "</div>";
      }
    }];
  }
  function boardScenes(M) {
    if (!M.playing.length) return [];
    return [{ id: "boards", kind: "boards", name: "Live", part: "", html: () => `<div class="bgrid" data-n="${Math.min(M.playing.length, 9)}">${boards(M, false)}</div>` }];
  }
  function scenes(M, size, cfg2) {
    const make = { boards: () => boardScenes(M), bracket: () => bracketScenes(M, size), tables: () => tableScenes(M, size), results: () => resultScenes(M, size), leaders: () => leaderScenes(M, size) };
    let order = cfg2.scenes.filter((s) => make[s.id] && s.secs > 0);
    const koOn = M.matches.some((m) => m.stage === "ko" && m.state !== "pending");
    if (M.format === "groups" && !koOn) order = [...order.filter((s) => s.id === "tables"), ...order.filter((s) => s.id !== "tables")];
    return order.flatMap((s) => make[s.id]().map((sc) => __spreadProps(__spreadValues({}, sc), { secs: s.secs })));
  }
  function idle() {
    return '<div class="ct"><div class="ct-k">AutoGlow</div><h1>No tournament running</h1><div class="ct-s">Start one from Autodarts \u203A Local Tournament</div></div>';
  }
  function lobby(M, cfg2) {
    const n = M.entrants.length;
    const size = n <= 8 ? "l" : n <= 18 ? "m" : "s";
    const facts = [FORMAT_NAME[M.format] || "", ...rulesOf(M), n ? `${n} players` : ""].filter(Boolean);
    return `<div class="ct lobby">${cfg2.logo ? `<img class="ct-logo" src="${esc(cfg2.logo)}" alt="">` : ""}<div class="ct-k">Starting soon</div><h1>${esc(cfg2.title || M.T.name || "Tournament")}</h1>${cfg2.subtitle ? `<div class="ct-sub">${esc(cfg2.subtitle)}</div>` : ""}
    <div class="ct-f">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
    <div class="lb-p ${size}">${M.entrants.map((p) => `<div class="lb-pl" data-k="lp-${esc(p.name)}" data-flip="lp-${esc(p.name)}" data-in>${av(p)}<b>${esc(p.name)}</b></div>`).join("")}</div>
    <div class="lb-b">${M.boards.map((b) => `<span class="${b.online === false ? "off" : ""}" data-k="lb-${b.number}" data-in><i></i>Board ${b.number}</span>`).join("")}<em>${M.boards.length ? `${M.boards.length} board${M.boards.length > 1 ? "s" : ""} ready` : "Boards are joining"}</em></div></div>`;
  }
  function champion(M) {
    const c = M.champion;
    if (!c) return "";
    const mine = M.results.filter((m) => m.sides.some((s) => s.player === c.id));
    const last = mine[0];
    const side = last ? last.sides.findIndex((s) => s.player === c.id) : -1;
    const final = last && /final/i.test(last.label) && !last.result.walkover ? `<div class="ch-f">${esc(last.label)} <b>${last.result.legs[side]} \u2013 ${last.result.legs[1 - side]}</b> against ${sideOf(M, last, 1 - side).text}</div>` : "";
    const st = M.stats.rows.get(c.id);
    const facts = [];
    if (st == null ? void 0 : st.avgN) facts.push([fix1(st.avgSum / st.avgN), "Tournament average"]);
    if (st) facts.push([`${st.won}/${st.played}`, "Matches won"], [`${st.legsFor}:${st.legsAgainst}`, M.sets ? "Sets" : "Legs"]);
    if (st == null ? void 0 : st.t180) facts.push([st.t180, "180s"]);
    const road = mine.slice(0, 6).reverse().map((m) => {
      const i = m.sides.findIndex((s) => s.player === c.id);
      return `<span>${esc(m.label)} <b>${m.result.walkover ? "w/o" : `${m.result.legs[i]} \u2013 ${m.result.legs[1 - i]}`}</b> ${sideOf(M, m, 1 - i).text}</span>`;
    }).join("");
    return `<div class="ch"><div class="ch-pic" data-in>${av(c)}</div><div class="ch-txt"><div class="ch-k" data-in>Champion</div><h1 data-in>${esc(c.name)}</h1>${c.nick ? `<div class="ch-n" data-in>\u201C${esc(c.nick)}\u201D</div>` : ""}${final}
    <div class="ch-s">${facts.map(([v, k]) => `<div data-in><b>${v}</b><small>${k}</small></div>`).join("")}</div><div class="ch-road" data-in>${road}</div></div></div>`;
  }

  // js/tournament-ticker.js
  var SPEED = { slow: 8, normal: 12, fast: 17 };
  var fix12 = (v) => Number(v).toFixed(1);
  function tickerItems(M, cfg2) {
    const on = __spreadValues({ t180: true, averages: true, results: true, upsets: true, next: true }, cfg2.ticker_items || {});
    const own = String(cfg2.ticker_text || "").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => ["", esc(s)]);
    if (!M || M.lobby) return own;
    const name = (id) => {
      var _a2;
      return esc(((_a2 = M.players.get(id)) == null ? void 0 : _a2.name) || id || "");
    };
    const sideName = (m, i) => m.sides[i].player ? name(m.sides[i].player) : "\u2013";
    const st = M.stats;
    const out = [];
    if (on.t180 && st.t180) {
      const who = st.by180.slice(0, 4).map((r) => `${name(r.id)} <b>${r.t180}</b>`).join("<i>\xB7</i>");
      out.push(["180", `<b>${st.t180}</b> \xD7 180 so far<i>\xB7</i>${who}`]);
    }
    if (on.averages && st.best) {
      const b = st.best;
      out.push(["Best average", `${name(b.id)} <b>${fix12(b.value)}</b> against ${name(b.opp)} <small>${esc(b.m.id)}</small>`]);
      if (st.byAvg.length > 1) {
        const all = st.byAvg.reduce((a, r) => a + r.avgSum, 0) / st.byAvg.reduce((a, r) => a + r.avgN, 0);
        out.push(["Averages", `${st.byAvg.slice(0, 3).map((r, i) => `${i + 1}. ${name(r.id)} <b>${fix12(r.avg)}</b>`).join("<i>\xB7</i>")}<i>\xB7</i>Overall <b>${fix12(all)}</b>`]);
      }
    }
    if (on.upsets) {
      for (const m of M.results.slice(0, 8)) {
        const r = m.result;
        if (r.walkover) continue;
        const w = M.players.get(m.sides[r.winner].player);
        const l = M.players.get(m.sides[1 - r.winner].player);
        if ((w == null ? void 0 : w.seed) && (l == null ? void 0 : l.seed) && w.seed - l.seed >= 2) out.push(["Upset", `${esc(w.name)} <small>seed ${w.seed}</small> beats ${esc(l.name)} <small>seed ${l.seed}</small> <b>${r.legs[r.winner]}\u2013${r.legs[1 - r.winner]}</b>`]);
        if (out.filter((x) => x[0] === "Upset").length >= 2) break;
      }
      if (st.deciders) out.push(["Deciders", `<b>${st.deciders}</b> match${st.deciders > 1 ? "es" : ""} went to the last ${M.sets ? "set" : "leg"}`]);
    }
    if (on.results) {
      for (const m of M.results.slice(0, 4)) {
        const r = m.result;
        const score = r.walkover ? "w/o" : `${r.legs[0]}\u2013${r.legs[1]}`;
        out.push(["Result", `<small>${esc(m.id)}</small> ${sideName(m, 0)} <b>${score}</b> ${sideName(m, 1)}`]);
      }
    }
    if (on.next && M.next.length) {
      out.push(["Up next", M.next.slice(0, 3).map((m) => `<small>${esc(m.id)}</small> ${sideName(m, 0)} <i>vs</i> ${sideName(m, 1)}`).join("<i>\xB7</i>")]);
    }
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
  var itemHTML = ([tag, html]) => `<span class="tk-i${tag ? "" : " own"}">${tag ? `<em>${esc(tag)}</em>` : '<i class="tk-star"></i>'}<span>${html}</span></span>`;
  function makeTicker(el) {
    let shown = "";
    let waiting = null;
    let speed = SPEED.normal;
    const track = document.createElement("div");
    track.className = "tk-run";
    el.replaceChildren(track);
    const lay = (html) => {
      shown = html;
      track.style.animation = "none";
      track.innerHTML = `<div class="tk-u">${html}</div>`;
      const unit = track.firstChild;
      const one = unit.scrollWidth || 1;
      const reps = Math.max(1, Math.ceil(el.clientWidth / one));
      unit.innerHTML = html.repeat(reps);
      track.appendChild(unit.cloneNode(true));
      const rem = parseFloat(document.documentElement.style.fontSize) || 10;
      void track.offsetWidth;
      track.style.animation = "";
      track.style.animationDuration = `${(unit.scrollWidth / (speed * rem)).toFixed(2)}s`;
    };
    track.addEventListener("animationiteration", () => {
      if (waiting !== null) {
        const w = waiting;
        waiting = null;
        lay(w);
      }
    });
    return {
      update(items, cfg2) {
        const sp = SPEED[cfg2.ticker_speed] || SPEED.normal;
        const html = items.map(itemHTML).join("");
        el.hidden = !html;
        if (!html) {
          shown = "";
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
        if (shown) lay(waiting != null ? waiting : shown);
        waiting = null;
      }
    };
  }

  // js/tournament.js
  var POLL_MS = 1e3;
  var ROSTER_MS = 3e4;
  var SETTINGS_MS = 3e3;
  var $ = (id) => document.getElementById(id);
  var screen = $("screen");
  var DEFAULTS = {
    layout: "overview",
    theme: "arena",
    accent: "",
    photos: true,
    clock: true,
    boards: true,
    upnext: true,
    safe: 0,
    title: "",
    subtitle: "",
    logo: "",
    scenes: [{ id: "bracket", secs: 14, on: true }, { id: "tables", secs: 14, on: true }, { id: "results", secs: 10, on: true }, { id: "leaders", secs: 10, on: true }],
    ticker: true,
    ticker_speed: "normal",
    ticker_items: {},
    ticker_text: "",
    text: "normal",
    calm: false
  };
  var LAYOUTS = ["overview", "boards", "wall", "single"];
  var THEMES = ["arena", "flap", "poster"];
  var STUDIO_LOOK = { autodarts: "arena", neon: "arena", velocity: "arena", arena: "flap", pub: "flap", tv: "poster", daylight: "poster", glass: "poster" };
  var query = new URLSearchParams(location.search);
  var preview = query.has("preview");
  var saved = {};
  var draft = null;
  var studioLook = { theme: "autodarts", accent: "" };
  var hold = "";
  var cfg = __spreadValues({}, DEFAULTS);
  function resolveCfg() {
    const src = __spreadValues(__spreadValues(__spreadValues({}, DEFAULTS), saved), draft || {});
    if (src.theme === "studio") {
      src.theme = STUDIO_LOOK[studioLook.theme] || "arena";
      src.accent = studioLook.accent || "";
    }
    if (LAYOUTS.includes(query.get("layout"))) src.layout = query.get("layout");
    if (THEMES.includes(query.get("theme"))) src.theme = query.get("theme");
    src.logo = src.logo ? `/api/dashboard/logo/${encodeURIComponent(src.logo)}` : "";
    src.scenes = (src.scenes || []).filter((x) => x.on !== false);
    Object.keys(cfg).forEach((k) => delete cfg[k]);
    Object.assign(cfg, src);
    applyCfg();
  }
  var fitted = "";
  function fit() {
    const k = 1 - 2 * cfg.safe / 100;
    const [w, h] = cfg.text === "large" ? [166.4, 93.6] : [192, 108];
    const root = document.documentElement;
    root.style.setProperty("--sw", w);
    root.style.setProperty("--sh", h);
    root.style.fontSize = `${Math.min(innerWidth * k / w, innerHeight * k / h)}px`;
    const key = `${root.style.fontSize}|${w}`;
    if (key !== fitted) {
      fitted = key;
      ticker == null ? void 0 : ticker.relayout();
    }
  }
  function applyCfg() {
    const root = document.documentElement;
    root.dataset.theme = cfg.theme;
    root.classList.toggle("no-pics", !cfg.photos);
    root.classList.toggle("calm", !!cfg.calm);
    const hex = /^#?([0-9a-f]{6})$/i.exec(cfg.accent || "");
    if (hex) root.style.setProperty("--accent-rgb", [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).join(", "));
    else root.style.removeProperty("--accent-rgb");
    fit();
  }
  var ticker = null;
  addEventListener("resize", fit);
  resolveCfg();
  ticker = makeTicker($("tk"));
  var _a;
  (_a = document.fonts) == null ? void 0 : _a.ready.then(() => ticker.relayout());
  if (preview) $("hint").hidden = true;
  document.addEventListener("dblclick", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {
    });
  });
  setTimeout(() => $("hint").classList.add("gone"), 4e3);
  var HEAD = '<header class="hd" id="hd"></header>';
  var SCENE = '<section class="sc" id="sc"><div class="sc-top"><div class="sc-tabs" id="tabs"></div><div class="sc-bar" id="bar"></div></div><div class="sc-wrap"><div class="sc-body" id="body"></div></div></section>';
  var FRAMES = {
    full: '<div class="full" id="full"></div>',
    overview: `${HEAD}<main class="mn"><section class="lv"><h2 id="lvh"></h2><div class="bds" id="boards"></div><h2 id="nxh">Up next</h2><div class="nxs" id="next"></div></section>${SCENE}</main>`,
    boards: `${HEAD}<main class="mn"><div class="bds" id="boards"></div><div class="lw"><section class="pnl" id="nxp"><h3>Up next</h3><div class="nxs" id="next"></div></section>${SCENE}<section class="pnl" id="side"></section></div></main>`,
    wall: `${HEAD}<main class="mn">${SCENE}<div class="bds" id="boards"></div></main>`,
    single: `${HEAD}<main class="mn">${SCENE}</main>`
  };
  var data = null;
  var roster = [];
  var mounted = "";
  var frame = "";
  var cur = { id: "", at: 0, fresh: false };
  function layoutNow() {
    if (hold) return "single";
    if (cfg.layout === "overview" && !cfg.boards && !cfg.upnext) return "single";
    if (cfg.layout === "boards" && !cfg.boards) return "single";
    return cfg.layout;
  }
  function mount(kind) {
    frame = kind === "run" ? layoutNow() : kind === "end" ? "single" : "full";
    screen.dataset.kind = kind;
    screen.dataset.layout = frame;
    screen.innerHTML = FRAMES[frame];
    screen.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: "ease-out" });
    cur = { id: "", at: 0, fresh: false };
  }
  var clock = () => (/* @__PURE__ */ new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function nextRows(n) {
    if (frame === "boards") return 4;
    return n <= 1 ? 6 : n === 2 ? 4 : n === 3 ? 2 : n === 4 ? 1 : 0;
  }
  function sidePanel(M) {
    const tiles = leaderTiles(M);
    const top = M.stats.byAvg.slice(0, Math.max(0, 4 - tiles.length));
    if (!tiles.length) return '<h3>Leaders</h3><div class="mnote">After the first match</div>';
    return `<h3>Leaders</h3>${tiles.map(([k, v, p]) => `<div class="lr" data-k="lr-${k}" data-in>${av(p)}<div><small>${k}</small><b>${esc((p == null ? void 0 : p.name) || "")}</b></div><span class="num lrv" data-num="${v}" data-pad="${String(v).length}"></span></div>`).join("")}` + top.map((r, i) => {
      var _a2;
      return `<div class="lr" data-k="la-${r.id}" data-in>${av(M.players.get(r.id))}<div><small>Average \xB7 ${i + 1}</small><b>${esc(((_a2 = M.players.get(r.id)) == null ? void 0 : _a2.name) || "")}</b></div><span class="num lrv" data-num="${r.avg.toFixed(1)}" data-pad="${r.avg.toFixed(1).length}"></span></div>`;
    }).join("");
  }
  function scene(M, kind) {
    const body = $("body");
    const rem = parseFloat(document.documentElement.style.fontSize) || 10;
    const size = { w: body.clientWidth / rem, h: body.clientHeight / rem };
    if (size.w < 10 || size.h < 10) return;
    const own = frame === "single" && kind === "run" && cfg.boards ? [{ id: "boards", secs: 14 }, ...cfg.scenes] : cfg.scenes;
    const held = hold && kind === "run" ? scenes(M, size, __spreadProps(__spreadValues({}, cfg), { scenes: [{ id: hold, secs: 3600 }] })) : [];
    let list = held.length ? held : scenes(M, size, __spreadProps(__spreadValues({}, cfg), { scenes: own }));
    if (kind === "end" && M.champion) list = [{ id: "champion", kind: "champion", name: "Champion", part: "", secs: 20, html: () => champion(M) }, ...list];
    if (!list.length) {
      patch($("tabs"), "");
      $("bar").replaceChildren();
      patch(body, '<div class="mnote">The first results show here</div>');
      cur = { id: "", at: 0, fresh: false };
      return;
    }
    const now = Date.now();
    let ix = list.findIndex((s) => s.id === cur.id);
    if (ix < 0) ix = 0;
    else if (now - cur.at > list[ix].secs * 1e3 && list.length > 1) ix = (ix + 1) % list.length;
    if (list[ix].id !== cur.id) cur = { id: list[ix].id, at: now, fresh: true };
    const sc = list[ix];
    const names = [...new Set(list.map((s) => s.name))];
    patch($("tabs"), names.map((n) => `<span class="${n === sc.name ? "on" : ""}" data-k="${n}">${n}${n === sc.name && sc.part ? `<small>${sc.part}</small>` : ""}</span>`).join(""));
    const fill = () => {
      patch(body, sc.html());
      if (sc.kind === "bracket") flyWinners(body);
    };
    if (!cur.fresh) return fill();
    cur.fresh = false;
    $("bar").innerHTML = list.length > 1 ? `<i style="animation-duration:${sc.secs}s"></i>` : "";
    body.dataset.scene = sc.kind;
    swap(body, fill);
  }
  function render() {
    const M = derive(data, roster);
    const kind = !M ? "none" : M.lobby ? "lobby" : M.finished ? "end" : "run";
    const key = `${kind}|${layoutNow()}|${cfg.theme}|${cfg.boards}|${cfg.upnext}`;
    if (key !== mounted) {
      mounted = key;
      mount(kind);
    }
    screen.classList.toggle("no-boards", !cfg.boards);
    screen.classList.toggle("no-next", !cfg.upnext);
    if (kind === "none") patch($("full"), idle());
    else if (kind === "lobby") patch($("full"), lobby(M, cfg));
    else {
      patch($("hd"), header(M, cfg, clock()));
      const n = M.playing.length;
      screen.dataset.n = Math.min(n, 9);
      const bds = cfg.boards ? $("boards") : null;
      if (bds) {
        const rows = frame === "boards" && n <= 4;
        bds.classList.toggle("rows", rows);
        patch(bds, boards(M, rows));
      }
      if ($("lvh")) patch($("lvh"), `${M.progress.live ? '<i class="dot"></i>' : ""}${M.progress.live ? "Live now" : "On the boards"}<span>${M.boards.length ? `${M.playing.length} of ${M.boards.length} board${M.boards.length > 1 ? "s" : ""}` : ""}</span>`);
      if ($("next") && cfg.upnext) {
        const some = patchNext(M, n);
        if ($("nxh")) $("nxh").hidden = !some;
      }
      if ($("side")) patch($("side"), sidePanel(M));
      scene(M, kind);
    }
    syncNums(screen, cfg.theme === "flap");
    const items = cfg.ticker && kind !== "none" ? tickerItems(M, cfg) : [];
    ticker.update(items, cfg);
    $("stage").classList.toggle("with-tk", items.length > 0);
  }
  function patchNext(M, n) {
    const html = upNext(M, nextRows(n));
    patch($("next"), html || (frame === "boards" ? '<div class="mnote">Nothing waiting</div>' : ""));
    return !!html;
  }
  async function loadRoster() {
    var _a2;
    try {
      const r = await fetch("/api/studio", { cache: "no-store" });
      if (r.ok) {
        const body = await r.json();
        const st = (_a2 = body.data) != null ? _a2 : body;
        roster = st.players || [];
        const look = { theme: st.theme || "autodarts", accent: st.accent || "" };
        if (look.theme !== studioLook.theme || look.accent !== studioLook.accent) {
          studioLook = look;
          resolveCfg();
        }
      }
    } catch (err) {
    }
    setTimeout(loadRoster, ROSTER_MS);
  }
  async function poll() {
    var _a2;
    try {
      const r = await fetch("/api/tournament/local", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const body = await r.json();
      data = (_a2 = body.data) != null ? _a2 : body;
      $("offline").hidden = true;
    } catch (err) {
      $("offline").hidden = false;
    }
    try {
      render();
    } catch (err) {
      console.error(err);
      mounted = "";
      reset(screen);
    }
    setTimeout(poll, POLL_MS);
  }
  async function loadSettings() {
    var _a2;
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      if (r.ok) {
        const body = await r.json();
        const _b = (_a2 = body.data) != null ? _a2 : body, { hold: h } = _b, rest = __objRest(_b, ["hold"]);
        saved = rest;
        hold = (h == null ? void 0 : h.scene) || "";
        resolveCfg();
      }
    } catch (err) {
    }
    setTimeout(loadSettings, SETTINGS_MS);
  }
  if (preview && "BroadcastChannel" in window) {
    new BroadcastChannel("autoglow-dashboard-draft").onmessage = (e) => {
      var _a2, _b, _c;
      if (((_a2 = e.data) == null ? void 0 : _a2.type) === "draft") draft = e.data.settings;
      else if (((_b = e.data) == null ? void 0 : _b.type) === "clear") draft = null;
      else if (((_c = e.data) == null ? void 0 : _c.type) === "hold") hold = e.data.scene || "";
      resolveCfg();
      if (data) render();
    };
  }
  Promise.all([loadRoster(), loadSettings()]).then(poll);
})();
