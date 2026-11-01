// AutoGlow Studio output - demo match (?demo=1): a scripted game in the same shape as /api/studio/state,
// so every scene can be checked without playing: 180s, busts, a 9-darter alert, checkouts, leg and match end.

import { ctx, studioPlayersAsPlayers, sleep } from './ctx.js';
import { segmentPosition } from './dartboard.js';

const DART_MS = 1100;
const TAKEOUT_MS = 2400;
const IDLE_MS = 9000;
const LOBBY_MS = 24000;          // players picked in the lobby: versus card and both player cards
const LEG_BREAK_MS = 9000;
const MATCH_END_MS = 32000;
const BULL_OFF_INTRO_MS = 12000; // intro and transitions before the first bull-off dart
const BULL_OFF_DART_MS = 4000;
const BULL_OFF_RESULT_MS = 8000; // the winner stays until "Weiter" is pressed in Autodarts

// Each visit: [player, darts...]; player 0 starts legs 1 and 3, player 1 starts leg 2
const LEGS = [
  [[0, 'T20', 'T20', 'T20'], [1, 'T20', 'T20', 'S20'], [0, 'T20', 'T20', 'S20'], [1, 'S20', 'T20', 'S20'],
    [0, 'T20', 'T20', 'T20'], [1, 'T20', 'T20', 'T20'], [0, 'T20', 'T20', 'S1'], [1, 'T19', 'S16', 'D4']],
  [[1, 'T20', 'T20', 'T20'], [0, 'T20', 'T20', 'T20'], [1, 'T20', 'T20', 'S20'], [0, 'T20', 'T20', 'T20'],
    [1, 'T20', 'T20', 'T20'], [0, 'T20', 'T19', 'D12']],
  [[0, 'T20', 'T20', 'T20'], [1, 'T20', 'S20', 'S5'], [0, 'T20', 'T20', 'S20'], [1, 'T20', 'T20', 'T20'],
    [0, 'T20', 'T20', 'S1'], [1, 'S20', 'S20', 'S20'], [0, 'S20', 'D20']]
];
const LEGS_TO_WIN = 2;

function parseDart(label) {
  if (label === 'Bull') return { number: 25, multiplier: 2, bed: 'Double', value: 50 };
  if (label === '25') return { number: 25, multiplier: 1, bed: 'Single', value: 25 };
  const multiplier = { S: 1, D: 2, T: 3 }[label[0]];
  const number = Number(label.slice(1));
  const bed = multiplier === 3 ? 'Triple' : multiplier === 2 ? 'Double' : (Math.random() < 0.5 ? 'SingleInner' : 'SingleOuter');
  return { number, multiplier, bed, value: number * multiplier };
}

function emptyStats() {
  return { average: 0, first9Average: 0, dartsThrown: 0, total180: 0, plus140: 0, plus100: 0, checkoutPercent: 0, checkoutsHit: 0, checkouts: 0 };
}

let uid = 0;
const nextId = () => `demo-${++uid}`;

// The first two Studio players, so the demo shows their pictures and profiles
function demoNames() {
  const studio = studioPlayersAsPlayers().map(p => p.name);
  return [studio[0] || 'Player One', studio[1] || 'Player Two'];
}

export class DemoFeed {
  constructor() {
    this.state = { live: false, players: [], source: { connected: true, tab_attached: true } };
    this.run();
  }

  current() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async run() {
    for (;;) {
      this.state = { live: false, players: [], source: { connected: true, tab_attached: true } };
      await sleep(IDLE_MS);
      // Two players picked in the Autodarts lobby, match not started yet
      this.state = {
        ...this.state,
        lobby: { id: nextId(), variant: 'X01', base_score: 501, target: `First to ${LEGS_TO_WIN} legs`,
          players: demoNames().map((name, index) => ({ index, name, avatar_url: '', country: '' })) }
      };
      await sleep(LOBBY_MS);
      const matchId = await this.playBullOff();
      await this.playMatch(matchId);
      await sleep(MATCH_END_MS);
    }
  }

  // Bull-off before the first leg (closest to the bull): player one wins and throws first
  async playBullOff() {
    const id = nextId();
    const bo = bullOff(id, 'Normal');
    this.state = { live: true, players: [], source: { connected: true, tab_attached: true }, bull_off: bo };
    await sleep(BULL_OFF_INTRO_MS);
    for (const [i, mm, angle] of [[0, 9.4, 200], [1, 21.7, 70]]) {
      bo.active = i;
      await sleep(BULL_OFF_DART_MS);
      Object.assign(bo.players[i], bullDart(mm, angle));
      bo.leader = leaderOf(bo);
    }
    bo.decided = true;
    bo.winner = 0;
    bo.leader = 0;
    bo.active = null;
    await sleep(BULL_OFF_RESULT_MS);
    return id;
  }

  newMatch(matchId) {
    const names = demoNames();
    this.points = [0, 0];
    this.first9 = [[], []];
    this.state = {
      live: true, demo: true, match_id: matchId || nextId(), variant: 'X01', base_score: 501, out_mode: 'Double',
      target: `First to ${LEGS_TO_WIN} legs`, uses_sets: false, set: 1, leg: 1, round: 1, active: 0,
      finished: false, winner: null, phase: 'throw', checkout: [], source: { connected: true, tab_attached: true },
      players: names.map((name, index) => ({
        index, id: `p${index}`, name, remaining: 501, legs: 0, sets: 0, average: null, avatar_url: '', country: '',
        account_average: null, rounds: [], leg_stats: emptyStats(), match_stats: emptyStats()
      })),
      turn: { id: nextId(), player: 0, darts: [], throws: [], points: 0, busted: false }
    };
  }

  async playMatch(matchId) {
    this.newMatch(matchId);
    for (let legIndex = 0; legIndex < LEGS.length; legIndex++) {
      const s = this.state;
      s.leg = legIndex + 1;
      s.round = 1;
      s.players.forEach(p => { p.remaining = 501; p.rounds = []; p.leg_stats = emptyStats(); });
      this.first9 = [[], []];
      let legWinner = null;
      for (const [player, ...darts] of LEGS[legIndex]) {
        legWinner = await this.playVisit(player, darts);
        if (legWinner !== null) break;
      }
      const winner = s.players[legWinner];
      winner.legs++;
      if (winner.legs >= LEGS_TO_WIN) {
        s.finished = true;
        s.winner = legWinner;
        s.phase = 'idle';
        return;
      }
      s.phase = 'takeout';
      await sleep(LEG_BREAK_MS);
    }
  }

  // Returns the player index when this visit wins the leg
  async playVisit(index, darts) {
    const s = this.state;
    const p = s.players[index];
    const start = p.remaining;
    s.active = index;
    s.phase = 'throw';
    s.turn = { id: nextId(), player: index, darts: [], throws: [], points: 0, busted: false };
    let won = false;
    for (const label of darts) {
      await sleep(DART_MS);
      const dart = parseDart(label);
      const pos = segmentPosition(dart.number, dart.bed, dart.multiplier);
      s.turn.darts.push(label);
      s.turn.throws.push({ id: nextId(), label, number: dart.number, multiplier: dart.multiplier, bed: dart.bed, x: pos.x, y: pos.y });
      const left = p.remaining - dart.value;
      this.countDart(index, dart.value);
      if (left === 0 && dart.multiplier === 2) {
        p.remaining = 0;
        s.turn.points = start;
        won = true;
        break;
      }
      if (left < 2) {
        // Bust: the visit scores nothing
        this.countDart(index, -(start - p.remaining) - dart.value, 0);
        p.remaining = start;
        s.turn.busted = true;
        s.turn.points = 0;
        break;
      }
      p.remaining = left;
      s.turn.points = start - left;
    }
    const scored = s.turn.busted ? 0 : start - p.remaining;
    p.rounds.push(scored);
    for (const stats of [p.leg_stats, p.match_stats]) {
      if (scored === 180) stats.total180++;
      else if (scored >= 140) stats.plus140++;
      else if (scored >= 100) stats.plus100++;
      if (start <= 170) stats.checkouts++;
      if (won) stats.checkoutsHit++;
      stats.checkoutPercent = stats.checkouts ? stats.checkoutsHit / stats.checkouts : 0;
    }
    if (won) return index;
    await sleep(600);
    s.phase = 'takeout_in_progress';
    await sleep(TAKEOUT_MS);
    s.phase = 'takeout_finished';
    if (index === 1 || s.players.length === 1) s.round++;
    return null;
  }

  countDart(index, value, darts = 1) {
    const p = this.state.players[index];
    this.points[index] += value;
    for (const stats of [p.leg_stats, p.match_stats]) stats.dartsThrown += darts;
    if (darts) this.first9[index].push(value);
    const legPoints = 501 - p.remaining;
    p.match_stats.average = p.match_stats.dartsThrown ? +(this.points[index] / p.match_stats.dartsThrown * 3).toFixed(2) : 0;
    p.leg_stats.average = p.leg_stats.dartsThrown ? +(Math.max(0, legPoints) / p.leg_stats.dartsThrown * 3).toFixed(2) : 0;
    const f9 = this.first9[index].slice(0, 9);
    p.match_stats.first9Average = f9.length ? +(f9.reduce((a, b) => a + b, 0) / f9.length * 3).toFixed(2) : 0;
    p.average = p.match_stats.average;
  }
}

// A finished-looking sample for scene cues while no match is running
export function sampleState() {
  const names = demoNames();
  const stats = (avg, d) => ({ ...emptyStats(), average: avg, first9Average: avg + 8, dartsThrown: d, total180: 2, plus140: 3, plus100: 4, checkoutPercent: 0.4 });
  return {
    live: true, match_id: 'sample', variant: 'X01', base_score: 501, out_mode: 'Double', target: 'First to 2 legs',
    uses_sets: false, set: 1, leg: 3, round: 6, active: 0, finished: true, winner: 0, phase: '', checkout: [],
    players: names.map((name, index) => ({
      index, id: `s${index}`, name, remaining: index ? 176 : 0, legs: index ? 1 : 2, sets: 0, average: index ? 88.4 : 97.1,
      avatar_url: '', country: '', account_average: null, rounds: [], leg_stats: stats(index ? 85 : 99, 15), match_stats: stats(index ? 88.4 : 97.1, 45)
    })),
    turn: { id: 'sample', player: 0, darts: [], throws: [], points: 0, busted: false }
  };
}

// --- Bull-off samples (same shape as /api/studio/state › bull_off) ---------------------------------
function bullOff(id, mode) {
  return {
    match_id: id, mode, round: 1, active: 0, decided: false, winner: null, leader: null, history: [],
    variant: 'X01', base_score: 501, target: `First to ${LEGS_TO_WIN} legs`,
    players: demoNames().map((name, index) => ({ index, id: `b${index}`, name, avatar_url: '', country: '', account_average: null, thrown: false }))
  };
}

// A dart `mm` from the bull centre, at `angle` degrees clockwise from the 20
function bullDart(mm, angle) {
  const a = angle * Math.PI / 180;
  const segment = mm <= 6.35 ? 50 : mm <= 15.9 ? 25 : 0;
  const label = segment === 50 ? 'Bull' : segment === 25 ? '25' : 'S20';
  return { thrown: true, distance: mm, segment, label, x: Math.sin(a) * mm / 170, y: Math.cos(a) * mm / 170 };
}

function leaderOf(bo) {
  const thrown = bo.players.filter(p => p.thrown);
  if (!thrown.length) return null;
  return thrown.reduce((best, p) => (p.distance < best.distance ? p : best)).index;
}

// kind: running (one dart thrown, the second player at the board), decided, official (PDC rule),
// tie (second round after a tie)
export function sampleBullOff(kind = 'running') {
  const bo = bullOff('sample-bulloff', kind === 'official' || kind === 'tie' ? 'Official' : 'Normal');
  Object.assign(bo.players[0], bullDart(kind === 'official' ? 4.1 : 23.4, 215));
  bo.active = 1;
  if (kind === 'decided') {
    Object.assign(bo.players[1], bullDart(11.8, 60));
    bo.decided = true;
    bo.winner = 1;
    bo.active = null;
  }
  if (kind === 'tie') {
    bo.round = 2;
    bo.history = [{ round: 1, darts: [bullDart(84.2, 300), bullDart(61.5, 120)].map((d, i) => ({ ...d, label: i ? 'S6' : 'S12' })) }];
  }
  bo.leader = bo.decided ? bo.winner : kind === 'tie' ? null : leaderOf(bo);
  return bo;
}
