'use strict';
/**
 * 大头麻将 · 局域网四人麻将服务端
 * HTTP 静态页面 + WebSocket 实时对局
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const wsmini = require('./wsmini');
const mj = require('./mj');

const PORT = +(process.env.PORT || 8420);
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let p = '/';
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { /* ignore */ }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const clients = new Set(); // 所有活跃连接
const rooms = new Map();
const socks = new Map(); // conn -> {room, seat}

const CLAIM_MS = 10000;  // 吃碰杠胡等待
const TURN_MS = 20000;   // 出牌限时
const END_MS = 15000;    // 结算界面最长等待

const BOT_NAMES = ['机器人·小雀', '机器人·阿福', '机器人·旺财', '机器人·阿宝', '机器人·铁头', '机器人·幺鸡'];
const WIND_LABEL = ['东', '南', '西', '北'];

function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
const now = () => Date.now();
const delay = (min, max) => min + Math.random() * (max - min);

class Room {
  constructor() {
    this.code = newCode();
    this.seats = [null, null, null, null];
    this.scores = [0, 0, 0, 0];
    this.roundNo = 0;
    this.dealer = 0;
    this.host = 0;
    this.phase = 'lobby';
    this.game = null;
    this.timers = [];
    this.token = 0;
    this.evtId = 0;
    rooms.set(this.code, this);
  }

  /* ---------- 基础工具 ---------- */
  bump() { this.token++; this.timers.forEach(clearTimeout); this.timers = []; }
  after(ms, fn) {
    const tok = this.token;
    const t = setTimeout(() => { if (this.token === tok && rooms.has(this.code)) fn(); }, ms);
    this.timers.push(t);
  }
  humans() { return this.seats.filter((s) => s && !s.bot && s.connected); }
  sendTo(seatIdx, obj) {
    const p = this.seats[seatIdx];
    if (p && p.ws && p.connected && !p.ws.closed) {
      try { p.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }
  broadcast() {
    for (let i = 0; i < 4; i++) this.sendTo(i, this.viewFor(i));
  }
  event(kind, extra) {
    this.evtId++;
    return Object.assign({ kind, evtId: this.evtId }, extra || {});
  }

  /* ---------- 座位管理 ---------- */
  addPlayer(ws, name) {
    for (let i = 0; i < 4; i++) {
      if (!this.seats[i]) {
        this.seats[i] = { ws, name, bot: false, connected: true, ready: false };
        return i;
      }
    }
    return -1;
  }
  rejoin(ws, name) {
    const i = this.seats.findIndex((s) => s && !s.bot && s.name === name
      && (!s.connected || !s.ws || s.ws.closed));
    if (i >= 0) {
      const p = this.seats[i];
      p.ws = ws; p.connected = true; p.ready = false; p.takeover = false;
    }
    return i;
  }
  addBot() {
    for (let i = 0; i < 4; i++) {
      if (!this.seats[i]) {
        const used = new Set(this.seats.filter(Boolean).map((s) => s.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) || '机器人·小雀';
        this.seats[i] = { ws: null, name, bot: true, connected: true, ready: false };
        return i;
      }
    }
    return -1;
  }
  removeSeat(i) {
    if (i < 0 || i > 3 || !this.seats[i]) return;
    this.seats[i] = null;
    this.fixHost();
  }
  fixHost() {
    if (!this.seats[this.host] || this.seats[this.host].bot || !this.seats[this.host].connected) {
      const h = this.seats.findIndex((s) => s && !s.bot && s.connected);
      this.host = h >= 0 ? h : this.seats.findIndex((s) => s) >= 0 ? this.seats.findIndex((s) => s) : 0;
    }
  }
  maybeDestroy() {
    if (this.phase === 'lobby' && this.humans().length === 0) rooms.delete(this.code);
  }

  onDisconnect(seatIdx) {
    const p = this.seats[seatIdx];
    if (!p) return;
    p.connected = false;
    p.ws = null;
    if (this.phase === 'lobby') {
      this.removeSeat(seatIdx);
      this.maybeDestroy();
      if (rooms.has(this.code)) this.broadcast();
    } else {
      // 对局中断线 → 托管（机器人接管）
      p.takeover = true;
      this.broadcast();
      // 若正在等他响应，直接交给机器人逻辑处理
      this.driveBots();
    }
  }

  /* ---------- 视图 ---------- */
  viewFor(seatIdx) {
    const base = {
      t: 'state',
      phase: this.phase,
      code: this.code,
      you: seatIdx,
      host: this.host,
      evtId: this.evtId,
    };
    if (this.phase === 'lobby') {
      base.seats = this.seats.map((s, i) => ({
        seat: i, wind: WIND_LABEL[i],
        name: s ? s.name : null, bot: s ? !!s.bot : false,
        connected: s ? !!s.connected : false, takeover: s ? !!s.takeover : false,
        host: i === this.host,
      }));
      return base;
    }
    const g = this.game;
    const reveal = this.phase === 'end';
    base.roundNo = this.roundNo;
    base.dealer = g.dealer;
    base.turn = g.turn;
    base.wallCount = g.wall.length;
    base.seats = this.seats.map((s, i) => ({
      seat: i,
      wind: WIND_LABEL[(i - g.dealer + 4) % 4],
      dealer: i === g.dealer,
      name: s ? s.name : '空',
      bot: s ? !!(s.bot || s.takeover) : false,
      connected: s ? !!s.connected : false,
      takeover: s ? !!s.takeover : false,
      ready: s ? !!s.ready : false,
      score: this.scores[i],
      handCount: g.hands[i].length,
      hand: (reveal || i === seatIdx) ? g.hands[i] : null,
      melds: g.melds[i],
      river: g.rivers[i],
    }));
    base.hand = g.hands[seatIdx];
    base.drawnId = g.drawnId;
    base.canDiscard = this.phase === 'play' && g.turn === seatIdx && g.canDiscard && !g.claim;
    base.selfActs = (this.phase === 'play' && g.turn === seatIdx && g.canDiscard && g.selfActs)
      ? { hu: g.selfActs.hu, gangs: g.selfActs.gangs } : null;
    if (this.phase === 'play' && g.claim) {
      base.claim = { tile: g.claim.tile, from: g.claim.from, rob: g.claim.rob };
      if (g.claim.eligible[seatIdx]) base.claim.opts = g.claim.eligible[seatIdx];
    } else {
      base.claim = null;
    }
    // 给"你"的倒计时（出牌或响应窗口），相对毫秒避免各设备时钟偏差
    base.deadlineIn = 0;
    if (this.phase === 'play') {
      if (g.claim && g.claim.eligible[seatIdx]) base.deadlineIn = Math.max(0, g.claim.deadline - now());
      else if (g.turn === seatIdx && g.canDiscard && !g.claim) base.deadlineIn = Math.max(0, g.turnDeadline - now());
    }
    // 全员可见的当前行动倒计时（出牌者限时 / 响应窗口限时）
    base.turnDeadlineIn = 0;
    if (this.phase === 'play') {
      if (g.claim) base.turnDeadlineIn = Math.max(0, g.claim.deadline - now());
      else if (g.canDiscard) base.turnDeadlineIn = Math.max(0, g.turnDeadline - now());
    }
    base.lastEvent = g.lastEvent;
    if (this.phase === 'end') base.summary = this.summaryView();
    return base;
  }

  summaryView() {
    const s = this.game.summary;
    if (!s) return null;
    return {
      draw: !!s.draw,
      winner: s.winner,
      winnerName: s.winner != null ? this.seats[s.winner].name : null,
      source: s.source || null,
      fan: s.fan || 0,
      items: s.items || [],
      deltas: s.deltas || [0, 0, 0, 0],
      winTile: s.winTile || null,
      hands: this.game.hands,
      scores: this.scores,
    };
  }

  /* ---------- 开局 ---------- */
  startGame() {
    if (this.phase !== 'lobby') return;
    if (this.seats.some((s) => !s)) return;
    this.phase = 'play';
    this.roundNo = 0;
    this.scores = [0, 0, 0, 0];
    this.dealer = 0;
    this.startRound();
  }

  startRound() {
    if (this.humans().length === 0 && this.phase === 'end') { rooms.delete(this.code); return; }
    this.bump();
    this.roundNo++;
    this.seats.forEach((s) => { if (s) s.ready = false; });
    const wall = mj.shuffle(mj.buildTiles());
    const hands = [[], [], [], []];
    for (let k = 0; k < 13; k++) for (let s = 0; s < 4; s++) hands[s].push(wall.pop());
    hands.forEach((h) => mj.sortHand(h));
    this.game = {
      dealer: this.dealer,
      turn: this.dealer,
      wall,
      hands,
      melds: [[], [], [], []],
      rivers: [[], [], [], []],
      drawnId: null,
      canDiscard: false,
      claim: null,
      selfActs: null,
      afterKong: false,
      turnDeadline: 0,
      lastEvent: this.event('roundStart', { roundNo: this.roundNo }),
      summary: null,
    };
    this.phase = 'play';
    this.beginTurn(this.dealer, false);
  }

  /* ---------- 回合推进 ---------- */
  beginTurn(seat, afterKong) {
    this.bump();
    const g = this.game;
    g.turn = seat;
    g.drawnId = null;
    g.claim = null;
    g.afterKong = !!afterKong;
    if (g.wall.length === 0) { this.endDraw(); return; }
    const tile = g.wall.pop();
    g.hands[seat].push(tile); // 摸的牌保持在末尾，前端单独展示
    g.drawnId = tile.id;
    g.canDiscard = true;
    g.selfActs = {
      hu: mj.handIsWin(g.hands[seat]),
      gangs: mj.selfGangOptions(g.hands[seat], g.melds[seat]),
    };
    g.lastEvent = this.event('draw', { seat });
    g.turnDeadline = now() + TURN_MS;
    this.broadcast();
    this.driveSeat(seat);
  }

  /** 轮到 seat 行动（出牌/自摸/杠）；机器人或断线托管自动出，真人限时 */
  driveSeat(seat) {
    const g = this.game;
    if (this.phase !== 'play' || g.turn !== seat || !g.canDiscard) return;
    const p = this.seats[seat];
    if (p.bot || p.takeover || !p.connected) {
      this.after(delay(700, 1400), () => this.botMove(seat));
    } else {
      this.after(TURN_MS + 30, () => {
        if (this.game.turn === seat && this.game.canDiscard) {
          const t = mj.aiDiscard(this.game.hands[seat]);
          this.doDiscard(seat, t.id);
        }
      });
    }
  }

  /** 碰/吃之后：直接出牌（不摸牌） */
  beginDiscardOnly(seat) {
    this.bump();
    const g = this.game;
    g.turn = seat;
    g.drawnId = null;
    g.claim = null;
    g.canDiscard = true;
    g.selfActs = { hu: false, gangs: mj.selfGangOptions(g.hands[seat], g.melds[seat]) };
    g.turnDeadline = now() + TURN_MS;
    this.broadcast();
    this.driveSeat(seat);
  }

  doDiscard(seat, tileId) {
    const g = this.game;
    if (this.phase !== 'play' || g.claim) return;
    if (g.turn !== seat || !g.canDiscard) return;
    const idx = g.hands[seat].findIndex((t) => t.id === tileId);
    if (idx < 0) return;
    this.bump();
    const [tile] = g.hands[seat].splice(idx, 1);
    mj.sortHand(g.hands[seat]);
    g.rivers[seat].push(tile);
    g.canDiscard = false;
    g.selfActs = null;
    g.drawnId = null;
    g.lastEvent = this.event('discard', { seat, tile });
    // 计算其他玩家可执行的claim
    const eligible = {};
    for (let s = 0; s < 4; s++) {
      if (s === seat) continue;
      const opts = this.claimOptionsFor(s, tile, seat);
      if (opts) eligible[s] = opts;
    }
    const seats = Object.keys(eligible);
    if (seats.length === 0) {
      this.advanceAfter(seat);
      return;
    }
    this.broadcast();
    this.openClaim(tile, seat, eligible, false, null);
  }

  claimOptionsFor(s, tile, from) {
    const hand = this.game.hands[s];
    const hu = mj.canHuWith(hand, tile.code);
    const pong = !!mj.pongIds(hand, tile.code);
    const kong = !!mj.kongIds(hand, tile.code);
    const chi = (s === (from + 1) % 4) ? mj.chiOptions(hand, tile.code) : [];
    if (!hu && !pong && !kong && chi.length === 0) return null;
    return { hu, pong, kong, chi: chi.length ? chi : undefined };
  }

  advanceAfter(from) {
    this.bump();
    const g = this.game;
    g.claim = null;
    if (g.wall.length === 0) { this.endDraw(); return; }
    this.beginTurn((from + 1) % 4, false);
  }

  /* ---------- 响应窗口（吃碰杠胡 / 抢杠） ---------- */
  openClaim(tile, from, eligible, rob, pending) {
    this.bump();
    const g = this.game;
    g.claim = {
      tile, from, rob: !!rob, pending: pending || null,
      eligible, answers: {},
      deadline: now() + CLAIM_MS,
    };
    g.lastEvent = this.event(rob ? 'robAsk' : 'claimAsk', { seat: from, tile });
    this.broadcast();
    for (const s of Object.keys(eligible).map(Number)) {
      const p = this.seats[s];
      if (p.bot || p.takeover || !p.connected) {
        this.after(delay(600, 1300), () => this.botClaim(s));
      }
    }
    this.after(CLAIM_MS + 30, () => this.resolveClaims());
  }

  submitClaim(seat, choice, chiIds) {
    const g = this.game;
    if (this.phase !== 'play' || !g.claim) return;
    const c = g.claim;
    const opts = c.eligible[seat];
    if (!opts || c.answers[seat]) return;
    if (choice === 'chi') {
      if (!opts.chi) return;
      const opt = opts.chi.find((o) => o.ids.slice().sort().join() === (chiIds || []).slice().sort().join());
      if (!opt) return;
      c.answers[seat] = { choice, chiIds: opt.ids };
    } else if (choice === 'hu' || choice === 'pong' || choice === 'kong' || choice === 'pass') {
      if (choice !== 'pass' && !opts[choice]) return;
      c.answers[seat] = { choice };
    } else return;
    const pending = Object.keys(c.eligible).filter((s) => !c.answers[s]);
    if (pending.length === 0) this.resolveClaims();
  }

  resolveClaims() {
    const g = this.game;
    if (!g.claim) return;
    const c = g.claim;
    this.bump();
    const dist = (s) => (s - c.from + 4) % 4;
    const answered = Object.entries(c.answers).map(([s, a]) => ({ s: +s, a }));
    // 胡 > 碰/杠 > 吃；同级取离出牌者最近的下家
    const hus = answered.filter((x) => x.a.choice === 'hu').sort((x, y) => dist(x.s) - dist(y.s));
    if (hus.length) {
      const winner = hus[0].s;
      g.claim = null;
      if (c.rob) { this.applyWin(winner, c.tile, 'rob', c.from); return; }
      const ri = g.rivers[c.from].findLastIndex((t) => t.id === c.tile.id);
      if (ri >= 0) g.rivers[c.from].splice(ri, 1);
      this.applyWin(winner, c.tile, 'discard', c.from);
      return;
    }
    const pk = answered.filter((x) => x.a.choice === 'pong' || x.a.choice === 'kong').sort((x, y) => dist(x.s) - dist(y.s));
    if (pk.length) {
      const s = pk[0].s;
      g.claim = null;
      if (pk[0].a.choice === 'kong') this.applyMingKong(s, c.tile, c.from);
      else this.applyPong(s, c.tile, c.from);
      return;
    }
    const ch = answered.filter((x) => x.a.choice === 'chi');
    if (ch.length) {
      const s = ch[0].s;
      const ids = ch[0].a.chiIds;
      g.claim = null;
      this.applyChi(s, c.tile, ids);
      return;
    }
    // 全部过
    g.claim = null;
    if (c.rob) { this.applyKongPending(c.pending); return; }
    this.advanceAfter(c.from);
  }

  removeFromHand(seat, ids) {
    const g = this.game;
    for (const id of ids) {
      const i = g.hands[seat].findIndex((t) => t.id === id);
      if (i >= 0) g.hands[seat].splice(i, 1);
    }
    mj.sortHand(g.hands[seat]);
  }

  applyPong(seat, tile, from) {
    this.bump();
    const g = this.game;
    const ids = mj.pongIds(g.hands[seat], tile.code);
    this.removeFromHand(seat, ids);
    g.melds[seat].push({
      type: 'pong', code: tile.code, from,
      tiles: [...ids.map((id) => ({ id, code: tile.code })), tile],
    });
    g.lastEvent = this.event('claim', { seat, action: 'pong', tile });
    this.beginDiscardOnly(seat);
  }

  applyChi(seat, tile, ids) {
    this.bump();
    const g = this.game;
    const t1 = g.hands[seat].find((t) => t.id === ids[0]);
    const t2 = g.hands[seat].find((t) => t.id === ids[1]);
    const meldTiles = [t1, t2, tile];
    meldTiles.sort((a, b) => mj.orderKey(a.code) - mj.orderKey(b.code));
    this.removeFromHand(seat, ids);
    g.melds[seat].push({ type: 'chi', code: tile.code, from: g.turn, tiles: meldTiles });
    g.lastEvent = this.event('claim', { seat, action: 'chi', tile });
    this.beginDiscardOnly(seat);
  }

  applyMingKong(seat, tile, from) {
    this.bump();
    const g = this.game;
    const ids = mj.kongIds(g.hands[seat], tile.code);
    this.removeFromHand(seat, ids);
    g.melds[seat].push({
      type: 'gang', concealed: false, code: tile.code, from,
      tiles: [...ids.map((id) => ({ id, code: tile.code })), tile],
    });
    this.kongPay(seat);
    g.lastEvent = this.event('claim', { seat, action: 'gang', tile });
    this.beginTurn(seat, true); // 杠后补牌
  }

  applyKongPending(pending) {
    if (!pending) return;
    if (pending.kind === 'an') this.applyAnGang(pending.seat, pending.code);
    else this.applyBuGang(pending.seat, pending.code);
  }

  /** 暗杠（无抢杠） */
  applyAnGang(seat, code) {
    this.bump();
    const g = this.game;
    const ids = g.hands[seat].filter((t) => t.code === code).map((t) => t.id).slice(0, 4);
    this.removeFromHand(seat, ids);
    g.melds[seat].push({
      type: 'gang', concealed: true, code, from: seat,
      tiles: ids.map((id) => ({ id, code })),
    });
    this.kongPay(seat);
    g.lastEvent = this.event('selfGang', { seat, action: 'gangAn', tile: { id: -1, code } });
    this.beginTurn(seat, true);
  }

  /** 补杠（先检测抢杠，再落地） */
  tryBuGang(seat, code) {
    const g = this.game;
    const handTile = g.hands[seat].find((t) => t.code === code);
    if (!handTile) return;
    const robEligible = {};
    for (let s = 0; s < 4; s++) {
      if (s === seat) continue;
      if (mj.canHuWith(g.hands[s], code)) robEligible[s] = { hu: true };
    }
    if (Object.keys(robEligible).length === 0) {
      this.applyBuGang(seat, code);
    } else {
      this.openClaim({ id: -2, code }, seat, robEligible, true, { kind: 'bu', seat, code });
    }
  }

  applyBuGang(seat, code) {
    this.bump();
    const g = this.game;
    const handTile = g.hands[seat].find((t) => t.code === code);
    this.removeFromHand(seat, [handTile.id]);
    const meld = g.melds[seat].find((m) => m.type === 'pong' && m.code === code);
    if (meld) {
      meld.type = 'gang';
      meld.concealed = false;
      meld.tiles = [...meld.tiles, handTile];
    }
    this.kongPay(seat);
    g.lastEvent = this.event('selfGang', { seat, action: 'gangBu', tile: handTile });
    this.beginTurn(seat, true);
  }

  kongPay(seat) {
    for (let i = 0; i < 4; i++) {
      if (i === seat) this.scores[i] += 3;
      else this.scores[i] -= 1;
    }
  }

  /* ---------- 自摸回合动作 ---------- */
  selfAct(seat, choice, code) {
    const g = this.game;
    if (this.phase !== 'play' || g.claim) return;
    if (g.turn !== seat || !g.canDiscard || !g.selfActs) return;
    if (choice === 'hu' && g.selfActs.hu) { this.applyWin(seat, null, 'self'); return; }
    if (choice === 'gang') {
      const opt = g.selfActs.gangs.find((o) => o.code === code);
      if (!opt) return;
      if (opt.kind === 'an') this.applyAnGang(seat, code);
      else this.tryBuGang(seat, code);
    }
  }

  /* ---------- 结算 ---------- */
  applyWin(winner, tile, source, payer) {
    this.bump();
    const g = this.game;
    g.canDiscard = false;
    g.selfActs = null;
    g.claim = null;
    let winTile = tile;
    let handCodes;
    if (source === 'self') {
      winTile = g.hands[winner].find((t) => t.id === g.drawnId) || g.hands[winner][g.hands[winner].length - 1];
      handCodes = g.hands[winner].map((t) => t.code);
    } else {
      handCodes = [...g.hands[winner].map((t) => t.code), tile.code];
    }
    const melds = g.melds[winner];
    const meldCodes = melds.flatMap((m) => m.tiles.map((t) => t.code));
    const afterKong = source === 'self' && g.afterKong;
    const { fan, items } = mj.calcFan(handCodes, melds, meldCodes, source === 'self', afterKong);
    const deltas = [0, 0, 0, 0];
    if (source === 'self') {
      for (let i = 0; i < 4; i++) {
        if (i === winner) deltas[i] = fan * 3;
        else deltas[i] = -fan;
      }
    } else {
      deltas[payer != null ? payer : g.turn] = -fan;
      deltas[winner] = fan;
    }
    for (let i = 0; i < 4; i++) this.scores[i] += deltas[i];
    g.summary = { winner, fan, items, deltas, source, winTile, draw: false };
    g.lastEvent = this.event('win', { seat: winner, tile: winTile });
    this.phase = 'end';
    this.broadcast();
    this.scheduleNextRound();
  }

  endDraw() {
    this.bump();
    const g = this.game;
    g.claim = null;
    g.canDiscard = false;
    g.summary = { draw: true, deltas: [0, 0, 0, 0] };
    g.lastEvent = this.event('drawGame');
    this.phase = 'end';
    this.broadcast();
    this.scheduleNextRound();
  }

  scheduleNextRound() {
    // 纯机器人自动准备；断线托管的真人仍需重连后手动准备
    for (let i = 0; i < 4; i++) {
      const p = this.seats[i];
      if (p && p.bot) p.ready = true;
    }
    this.after(END_MS, () => this.tryNextRound(true));
    this.checkReadyNow();
  }

  checkReadyNow() {
    const all = this.seats.every((p) => p && p.ready);
    if (all && this.phase === 'end') {
      this.after(800, () => this.tryNextRound(false));
    } else {
      this.broadcast();
    }
  }

  tryNextRound(force) {
    if (this.phase !== 'end') return;
    const g = this.game;
    if (force) {
      for (const p of this.seats) if (p) p.ready = true;
    } else if (!this.seats.every((p) => p && p.ready)) return;
    // 庄家流转：庄家没胡则下移（流局连庄）
    if (g.summary && !g.summary.draw && g.summary.winner !== this.dealer) {
      this.dealer = (this.dealer + 1) % 4;
    }
    if (this.humans().length === 0) { rooms.delete(this.code); return; }
    this.startRound();
  }

  /* ---------- 机器人 ---------- */
  botMove(seat) {
    const g = this.game;
    if (this.phase !== 'play' || g.turn !== seat || !g.canDiscard || g.claim) return;
    const acts = g.selfActs;
    if (acts) {
      if (acts.hu) { this.selfAct(seat, 'hu'); return; }
      if (acts.gangs.length && Math.random() < 0.85) {
        this.selfAct(seat, 'gang', acts.gangs[0].code);
        return;
      }
    }
    const t = mj.aiDiscard(g.hands[seat]);
    this.doDiscard(seat, t.id);
  }

  botClaim(seat) {
    const g = this.game;
    if (this.phase !== 'play' || !g.claim) return;
    const c = g.claim;
    const o = c.eligible[seat];
    if (!o || c.answers[seat]) return;
    if (o.hu) { this.submitClaim(seat, 'hu'); return; }
    if (o.kong) { this.submitClaim(seat, 'kong'); return; }
    if (o.pong && Math.random() < 0.85) { this.submitClaim(seat, 'pong'); return; }
    if (o.chi && o.chi.length) {
      const t = c.tile;
      const r = mj.rankOf(t.code);
      if ((r >= 3 && r <= 7) || Math.random() < 0.3) {
        const opt = o.chi[Math.floor(Math.random() * o.chi.length)];
        this.submitClaim(seat, 'chi', opt.ids);
        return;
      }
    }
    this.submitClaim(seat, 'pass');
  }

  driveBots() {
    const g = this.game;
    if (!g || this.phase !== 'play') return;
    if (g.claim) {
      for (const s of Object.keys(g.claim.eligible)) {
        const p = this.seats[+s];
        if ((p.bot || p.takeover) && !g.claim.answers[s]) {
          this.after(delay(400, 900), () => this.botClaim(+s));
        }
      }
    } else if (g.canDiscard) {
      const p = this.seats[g.turn];
      if (p.bot || p.takeover) this.after(delay(500, 1000), () => this.botMove(g.turn));
    }
  }
}

/* ---------- WebSocket 接入 ---------- */
function cleanName(raw) {
  return String(raw || '').trim().slice(0, 12);
}

wsmini.attach(server, (ws) => {
  clients.add(ws);

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const ctx = socks.get(ws);

    try {
      switch (m.t) {
        case 'create': {
          const name = cleanName(m.name) || '玩家' + Math.floor(100 + Math.random() * 900);
          const room = new Room();
          const seat = room.addPlayer(ws, name);
          room.host = seat;
          socks.set(ws, { room: room.code, seat });
          room.broadcast();
          break;
        }
        case 'join': {
          const name = cleanName(m.name) || '玩家' + Math.floor(100 + Math.random() * 900);
          const room = rooms.get(String(m.code || '').trim());
          if (!room) { ws.send(JSON.stringify({ t: 'err', msg: '房间不存在，请检查房号' })); return; }
          // 先尝试找回同名断线座位（页面刷新 / 断线重连）
          let seat = room.rejoin(ws, name);
          if (seat < 0) seat = room.addPlayer(ws, name);
          if (seat < 0) { ws.send(JSON.stringify({ t: 'err', msg: '房间已满' })); return; }
          room.fixHost();
          socks.set(ws, { room: room.code, seat });
          room.broadcast();
          break;
        }
        case 'addBot': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          if (!room || room.phase !== 'lobby' || ctx.seat !== room.host) return;
          room.addBot();
          room.broadcast();
          break;
        }
        case 'removeSeat': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          if (!room || room.phase !== 'lobby') return;
          const seat = +m.seat;
          if (seat === ctx.seat) return; // 通过"离开房间"退出
          if (ctx.seat !== room.host) return;
          if (room.seats[seat] && room.seats[seat].bot) room.removeSeat(seat);
          room.broadcast();
          break;
        }
        case 'leave': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          socks.delete(ws);
          if (room) room.onDisconnect(ctx.seat);
          ws.send(JSON.stringify({ t: 'left' }));
          break;
        }
        case 'start': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          if (!room || room.phase !== 'lobby' || ctx.seat !== room.host) return;
          if (room.seats.some((s) => !s)) {
            ws.send(JSON.stringify({ t: 'err', msg: '还有空位，可添加机器人或等待玩家' }));
            return;
          }
          room.startGame();
          break;
        }
        case 'discard': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          if (!room || room.phase !== 'play') return;
          room.doDiscard(ctx.seat, +m.id);
          break;
        }
        case 'claim': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          if (!room || room.phase !== 'play') return;
          room.submitClaim(ctx.seat, m.choice, m.ids);
          break;
        }
        case 'self': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          if (!room || room.phase !== 'play') return;
          room.selfAct(ctx.seat, m.choice, m.code);
          break;
        }
        case 'ready': {
          if (!ctx) return;
          const room = rooms.get(ctx.room);
          if (!room || room.phase !== 'end') return;
          const p = room.seats[ctx.seat];
          if (p) p.ready = true;
          room.checkReadyNow();
          break;
        }
      }
    } catch (e) {
      console.error('message error', m.t, e);
      try { ws.send(JSON.stringify({ t: 'err', msg: '服务器处理出错' })); } catch { /* ignore */ }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    const ctx = socks.get(ws);
    if (ctx) {
      socks.delete(ws);
      const room = rooms.get(ctx.room);
      if (room) room.onDisconnect(ctx.seat);
    }
  });
});

// 心跳清理死连接
setInterval(() => {
  for (const ws of clients) {
    if (ws.closed) { clients.delete(ws); continue; }
    ws.ping();
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('┌──────────────────────────────────────────┐');
  console.log('  🀄 大头麻将已启动（局域网四人联机）');
  console.log(`  本机游玩:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  局域网访问: http://${ip}:${PORT}`);
  console.log('  停止服务: Ctrl+C');
  console.log('└──────────────────────────────────────────┘');
});
