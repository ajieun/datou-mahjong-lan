'use strict';
/**
 * 麻将核心逻辑（服务端使用）
 * 牌编码：
 *   万 m1-m9 / 条 b1-b9 / 筒 c1-c9
 *   风 E(东) S(南) W(西) N(北)  /  中 Z 发 F 白 B
 */

const NUM_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const SUIT_NAME = { m: '万', b: '条', c: '筒' };
const HONOR_NAME = { E: '东', S: '南', W: '西', N: '北', Z: '红中', F: '发财', B: '白板' };
const HONOR_ORDER = ['E', 'S', 'W', 'N', 'Z', 'F', 'B'];

function buildTiles() {
  const tiles = [];
  let id = 0;
  for (const s of Object.keys(SUIT_NAME)) {
    for (let r = 1; r <= 9; r++) {
      for (let k = 0; k < 4; k++) tiles.push({ id: id++, code: s + r });
    }
  }
  for (const c of HONOR_ORDER) {
    for (let k = 0; k < 4; k++) tiles.push({ id: id++, code: c });
  }
  return tiles; // 136 张
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const isHonor = (code) => code.length === 1;
const rankOf = (code) => (isHonor(code) ? 0 : +code[1]);
const suitOf = (code) => (isHonor(code) ? null : code[0]);
const codeName = (code) => (isHonor(code) ? HONOR_NAME[code] : NUM_CN[rankOf(code)] + SUIT_NAME[suitOf(code)]);

function orderKey(code) {
  if (isHonor(code)) return 100 + HONOR_ORDER.indexOf(code);
  const base = { m: 0, b: 10, c: 20 }[code[0]];
  return base + rankOf(code);
}

function sortHand(hand) {
  hand.sort((a, b) => (a.code === b.code ? a.id - b.id : orderKey(a.code) - orderKey(b.code)));
  return hand;
}

function countsOf(codes) {
  const m = {};
  for (const c of codes) m[c] = (m[c] || 0) + 1;
  return m;
}

/** 能否把 counts 拆成顺子/刻子（不含将） */
function canDecompose(counts) {
  let first = null;
  for (const code of Object.keys(counts)) {
    if (counts[code] > 0) { first = code; break; }
  }
  if (!first) return true;
  if (counts[first] >= 3) {
    counts[first] -= 3;
    if (canDecompose(counts)) return true;
    counts[first] += 3;
  }
  const r = rankOf(first), s = suitOf(first);
  if (s && r >= 1 && r <= 7) {
    const c1 = s + (r + 1), c2 = s + (r + 2);
    if ((counts[c1] || 0) > 0 && (counts[c2] || 0) > 0) {
      counts[first]--; counts[c1]--; counts[c2]--;
      if (canDecompose(counts)) return true;
      counts[first]++; counts[c1]++; counts[c2]++;
    }
  }
  return false;
}

/** 14 张（牌面 code 数组）是否成和；返回结构化信息或 null */
function winInfo(codes) {
  if (codes.length % 3 !== 2) return null;
  const counts = countsOf(codes);
  const distinct = Object.keys(counts).length;
  // 七对
  if (codes.length === 14 && distinct === 7 && Object.values(counts).every((v) => v === 2)) {
    return { sevenPairs: true };
  }
  for (const p of Object.keys(counts)) {
    if (counts[p] >= 2) {
      counts[p] -= 2;
      let ok = false, allTri = false;
      if (Object.entries(counts).every(([, v]) => v === 0 || v === 3)) {
        ok = true; allTri = true; // 全刻子
      } else if (canDecompose(counts)) {
        ok = true;
      }
      counts[p] += 2;
      if (ok) return { pair: p, allTriplets: allTri };
    }
  }
  return null;
}

/** 手牌加上一张 code 是否能胡 */
function canHuWith(hand, code) {
  return !!winInfo([...hand.map((t) => t.code), code]);
}

/** 完整手牌（已含摸牌/和牌，14 有效张）是否自摸胡 */
function handIsWin(hand) {
  return !!winInfo(hand.map((t) => t.code));
}

/** 吃：返回所有可用组合 [{ids:[手牌a,手牌b], codes:[a,b]}] */
function chiOptions(hand, code) {
  const r = rankOf(code), s = suitOf(code);
  if (!s) return [];
  const res = [];
  const seen = new Set();
  for (let lo = r - 2; lo <= r; lo++) {
    if (lo < 1 || lo + 2 > 9) continue;
    const codes = [s + lo, s + (lo + 1), s + (lo + 2)];
    if (!codes.includes(code)) continue;
    const need = codes.filter((c) => c !== code);
    const a = hand.find((t) => t.code === need[0]);
    const b = hand.find((t) => t.code === need[1] && t.id !== (a && a.id));
    if (a && b) {
      const key = need.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        res.push({ ids: [a.id, b.id], codes: need });
      }
    }
  }
  return res;
}

function pongIds(hand, code) {
  const ids = hand.filter((t) => t.code === code).map((t) => t.id);
  return ids.length >= 2 ? ids.slice(0, 2) : null;
}

function kongIds(hand, code) {
  const ids = hand.filter((t) => t.code === code).map((t) => t.id);
  return ids.length >= 3 ? ids.slice(0, 3) : null;
}

/** 暗杠 / 补杠 选项 */
function selfGangOptions(hand, melds) {
  const res = [];
  const counts = countsOf(hand.map((t) => t.code));
  for (const [c, n] of Object.entries(counts)) {
    if (n === 4) res.push({ code: c, kind: 'an' });
  }
  for (const m of melds) {
    if (m.type === 'pong' && counts[m.code] === 1) res.push({ code: m.code, kind: 'bu' });
  }
  return res;
}

/**
 * 番数计算（休闲规则，通俗易懂）
 * @param handCodes14 和牌时全部暗牌 code（14 有效张）
 * @param melds 明牌组
 * @param meldCodes 明牌 code 汇总
 */
function calcFan(handCodes14, melds, meldCodes, selfDraw, afterKong) {
  const info = winInfo(handCodes14) || {};
  let fan = 1;
  const items = [['平胡', 1]];
  const allCodes = [...handCodes14, ...meldCodes];
  if (info.sevenPairs) { fan += 2; items.push(['七对', 2]); }
  if (info.allTriplets && melds.every((m) => m.type !== 'chi')) { fan += 2; items.push(['对对胡', 2]); }
  const suits = new Set();
  let honors = false;
  for (const c of allCodes) {
    if (isHonor(c)) honors = true;
    else suits.add(suitOf(c));
  }
  if (suits.size === 1 && !honors) { fan += 4; items.push(['清一色', 4]); }
  else if (suits.size === 1 && honors) { fan += 2; items.push(['混一色', 2]); }
  const exposed = melds.some((m) => m.type === 'chi' || m.type === 'pong' || (m.type === 'gang' && !m.concealed));
  if (!exposed) { fan += 1; items.push(['门清', 1]); }
  if (selfDraw) { fan += 1; items.push(['自摸', 1]); }
  if (afterKong) { fan += 1; items.push(['杠上开花', 1]); }
  return { fan, items };
}

/** 机器人出牌：留对/刻/搭子，打孤立牌 */
function aiDiscard(hand) {
  const counts = countsOf(hand.map((t) => t.code));
  let best = hand[0];
  let bestScore = Infinity;
  for (const t of hand) {
    const c = t.code;
    const n = counts[c];
    let keep;
    if (n >= 3) keep = 100 + Math.random() * 8;
    else if (n === 2) keep = 40 + Math.random() * 8;
    else {
      const r = rankOf(c), s = suitOf(c);
      if (!s) keep = 6 + Math.random() * 4; // 单张字牌先走
      else {
        let nb = 0;
        for (const d of [-2, -1, 1, 2]) {
          const rr = r + d;
          if (rr >= 1 && rr <= 9 && (counts[s + rr] || 0) > 0) nb += Math.abs(d) === 1 ? 3 : 1;
        }
        keep = 10 + nb + (r >= 4 && r <= 6 ? 3 : 0) + Math.random() * 4;
      }
    }
    if (keep < bestScore) { bestScore = keep; best = t; }
  }
  return best;
}

module.exports = {
  buildTiles, shuffle, sortHand, countsOf,
  isHonor, rankOf, suitOf, codeName, orderKey,
  winInfo, canHuWith, handIsWin,
  chiOptions, pongIds, kongIds, selfGangOptions,
  calcFan, aiDiscard,
};
