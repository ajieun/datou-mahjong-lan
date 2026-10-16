'use strict';
/* ══════════ 大头麻将 客户端 ══════════ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ---------- 牌面绘制 ---------- */
const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const BAM = { 2: [2], 3: [3], 4: [2, 2], 5: [2, 1, 2], 6: [3, 3], 7: [3, 1, 3], 8: [3, 2, 3], 9: [3, 3, 3] };
const PIN = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8], 7: [0, 1, 2, 4, 6, 7, 8], 8: [0, 1, 2, 3, 5, 6, 7, 8],
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};
const HONOR_TXT = { E: '東', S: '南', W: '西', N: '北', Z: '中', F: '發', B: '' };
const SUIT_TXT = { m: '万', b: '条', c: '筒' };
const HONOR_TXT_CN = { E: '东', S: '南', W: '西', N: '北', Z: '红中', F: '发财', B: '白板' };
const AVATARS = ['🧑', '🐯', '🐰', '🐲'];
const ACT_TXT = { pong: '碰', chi: '吃', kong: '杠' };

function codeName(code) {
  if (code.length === 1) return HONOR_TXT_CN[code];
  return CN[+code[1]] + SUIT_TXT[code[0]];
}
function orderKey(code) {
  if (code.length === 1) return 100 + 'ESWNZFB'.indexOf(code);
  return { m: 0, b: 10, c: 20 }[code[0]] + +code[1];
}
function tileFace(code) {
  if (code.length === 1) return `<span class="honor ${code}">${HONOR_TXT[code]}</span>`;
  const s = code[0], r = +code[1];
  if (s === 'm') return `<span class="face-m"><span class="n">${CN[r]}</span><span class="z">萬</span></span>`;
  if (s === 'b') {
    if (r === 1) return '<span class="bird">🐦</span>';
    const rows = BAM[r].map((n) => {
      let st = '';
      for (let i = 0; i < n; i++) st += `<i class="stick${n % 2 === 1 && i === (n - 1) / 2 ? ' red' : ''}"></i>`;
      return `<span class="bam-row">${st}</span>`;
    }).join('');
    return `<span class="bamboo">${rows}</span>`;
  }
  let dots = '';
  for (let i = 0; i < 9; i++) dots += `<i class="${PIN[r].includes(i) ? 'pin' : ''}"></i>`;
  return `<span class="pins">${dots}</span>`;
}
function tileHTML(tile, cls) {
  return `<div class="tile ${cls || ''}" data-id="${tile.id}">${tileFace(tile.code)}</div>`;
}
function backHTML(cls) { return `<div class="tile back ${cls || ''}"></div>`; }

/** 副露组：别人的暗杠显示牌背 */
function meldHTML(meld, mine, size) {
  const sz = size || 'xs';
  let inner = '';
  if (meld.type === 'gang' && meld.concealed && !mine) {
    inner = backHTML(sz) + backHTML(sz) + backHTML(sz) + backHTML(sz);
  } else {
    const rotateIdx = meld.type === 'chi'
      ? meld.tiles.findIndex((t) => t.code === meld.code)
      : meld.tiles.length - 1;
    inner = meld.tiles.map((t, i) => tileHTML(t, sz + (i === rotateIdx ? ' claimed' : ''))).join('');
  }
  return `<div class="meld">${inner}</div>`;
}

/* ---------- 音效（WebAudio 合成，无素材） ---------- */
const snd = (() => {
  let ctx = null;
  let enabled = localStorage.getItem('mj_snd') !== 'off';
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type, gain, at) {
    if (!enabled) return;
    try {
      const c = ac();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      const t0 = c.currentTime + (at || 0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(gain || 0.12, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.05);
    } catch { /* ignore */ }
  }
  return {
    get on() { return enabled; },
    toggle() { enabled = !enabled; localStorage.setItem('mj_snd', enabled ? 'on' : 'off'); return enabled; },
    discard: () => tone(240, 0.09, 'square', 0.08),
    draw: () => tone(420, 0.05, 'sine', 0.05),
    claim: () => { tone(520, 0.1, 'triangle', 0.14); tone(780, 0.14, 'triangle', 0.12, 0.09); },
    alert: () => { tone(880, 0.1, 'sine', 0.13); tone(660, 0.14, 'sine', 0.12, 0.11); },
    hu: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.14, i * 0.1)); },
    lose: () => { tone(330, 0.2, 'sine', 0.1); tone(247, 0.3, 'sine', 0.1, 0.16); },
    tick: () => tone(700, 0.04, 'sine', 0.04),
  };
})();
document.addEventListener('pointerdown', () => { try { snd.draw(); snd.toggle(); snd.toggle(); } catch { /* warm up ctx */ } }, { once: true });

/* ---------- 全局状态 ---------- */
let ws = null;
let S = null;              // 最新服务器状态
let myName = localStorage.getItem('mj_name') || '';
let myCode = '';
let selTileId = null;
let lastEvtId = 0;
let deadlineAt = 0;        // 我的行动到期时刻（performance.now() 基准）
let turnDeadlineAt = 0;    // 当前行动者（含响应窗口）到期时刻，全员可见
let lastTickSec = -1;      // 紧迫滴答音去重
let reconnectTry = 0;

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

/* ---------- 视图切换 ---------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
}

/* ---------- toast ---------- */
function toast(text, big) {
  const el = document.createElement('div');
  el.className = 'toast' + (big ? ' big' : '');
  el.textContent = text;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.classList.add('out'), big ? 2600 : 1800);
  setTimeout(() => el.remove(), big ? 3100 : 2300);
}

/* ---------- WebSocket ---------- */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    $('#conn-banner').classList.add('hidden');
    if (reconnectTry > 0 && myCode) {
      // 断线重连
      ws.send(JSON.stringify({ t: 'join', name: myName, code: myCode }));
    } else {
      // 页面刷新后自动回到原房间
      const saved = sessionStorage.getItem('mj_room');
      if (saved && myName) {
        myCode = saved;
        ws.send(JSON.stringify({ t: 'join', name: myName, code: saved }));
      }
    }
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'state') {
      const first = !S || S.phase !== m.phase;
      S = m;
      if (m.code) {
        myCode = m.code;
        try { sessionStorage.setItem('mj_room', m.code); } catch { /* ignore */ }
      }
      deadlineAt = m.deadlineIn > 0 ? performance.now() + m.deadlineIn : 0;
      turnDeadlineAt = m.turnDeadlineIn > 0 ? performance.now() + m.turnDeadlineIn : 0;
      handleEvents(first);
      render();
    } else if (m.t === 'err') {
      toast('⚠ ' + m.msg);
    } else if (m.t === 'left') {
      S = null; selTileId = null; myCode = '';
      try { sessionStorage.removeItem('mj_room'); } catch { /* ignore */ }
      location.hash = '';
      showView('home');
    }
  };
  ws.onclose = () => {
    if (S && S.phase !== 'lobby') {
      $('#conn-banner').classList.remove('hidden');
      reconnectTry++;
    } else {
      S = null;
      showView('home');
    }
  };
}

/* ---------- 事件提示（音效 + toast） ---------- */
function handleEvents(first) {
  if (!S.lastEvent) return;
  if (S.lastEvent.evtId <= lastEvtId) return;
  lastEvtId = S.lastEvent.evtId;
  const e = S.lastEvent;
  const seatName = (i) => (S.seats && S.seats[i] ? S.seats[i].name : '');
  switch (e.kind) {
    case 'discard':
      if (e.seat !== S.you) toast(`${seatName(e.seat)} 打出 ${codeName(e.tile.code)}`);
      snd.discard();
      break;
    case 'claim':
      toast(`${seatName(e.seat)} ${ACT_TXT[e.action] || e.action}了 ${e.action === 'chi' ? '' : codeName(e.tile.code)}`.trim());
      snd.claim();
      break;
    case 'selfGang':
      toast(`${seatName(e.seat)} ${e.action === 'gangAn' ? '暗杠' : '补杠'}`);
      snd.claim();
      break;
    case 'win':
      snd.hu();
      toast(`🎉 ${seatName(e.seat)} 胡牌！`, true);
      break;
    case 'drawGame':
      toast('流局 · 无人胡牌');
      snd.lose();
      break;
    case 'roundStart':
      toast(`—— 第 ${S.roundNo} 局 · 庄家 ${seatName(S.dealer)} ——`);
      break;
    case 'draw':
      if (e.seat === S.you) snd.draw();
      break;
    case 'claimAsk':
    case 'robAsk':
      if (S.claim && S.claim.opts) snd.alert();
      break;
  }
}

/* ---------- 渲染：大厅 ---------- */
function renderLobby() {
  $('#lobby-code').textContent = S.code;
  const box = $('#lobby-seats');
  box.innerHTML = S.seats.map((st) => {
    if (!st.name) {
      return `<div class="seat-card"><div class="seat-wind">${st.wind}</div>
        <div class="seat-info"><div class="seat-name" style="opacity:.4">虚位以待</div>
        <div class="seat-tags"><span class="tag tag-wait">等待玩家加入</span></div></div></div>`;
    }
    const tags = [
      st.host ? '<span class="tag tag-host">房主</span>' : '',
      st.bot ? '<span class="tag tag-bot">机器人</span>' : '',
      st.seat === S.you ? '<span class="tag tag-wait">你</span>' : '',
    ].join('');
    const rm = (st.bot && S.you === S.host) ? `<button class="btn btn-ghost btn-sm btn-remove" data-remove="${st.seat}">移除</button>` : '';
    return `<div class="seat-card${st.seat === S.you ? ' mine' : ''}">
      <div class="seat-wind">${st.wind}</div>
      <div class="seat-info"><div class="seat-name">${st.name}</div>
      <div class="seat-tags">${tags}</div></div>${rm}</div>`;
  }).join('');
  box.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = () => send({ t: 'removeSeat', seat: +b.dataset.remove });
  });
  const full = S.seats.every((st) => st.name);
  const iAmHost = S.you === S.host;
  $('#btn-addbot').classList.toggle('hidden', !iAmHost || full);
  const startBtn = $('#btn-start');
  startBtn.disabled = !(iAmHost && full);
  startBtn.textContent = !iAmHost ? '等待房主开局…' : (full ? '开 始 对 局' : '还差 ' + S.seats.filter((s) => !s.name).length + ' 人（可加机器人）');
  let hint = $('.host-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'host-hint';
    $('.lobby-foot').after(hint);
  }
  hint.textContent = '把房间号或邀请链接发给同一局域网的朋友，直接用浏览器打开即可加入';
}

/* ---------- 渲染：对局 ---------- */
function renderGame() {
  // 顶栏
  $('#tb-code').textContent = '房号 ' + S.code;
  $('#tb-mid').textContent = `第 ${S.roundNo} 局 · 庄家 ${S.seats[S.dealer].name} · 我方积分 ${S.seats[S.you].score}`;

  // 三家对手
  for (let d = 1; d <= 3; d++) {
    const s = (S.you + d) % 4;
    const st = S.seats[s];
    const el = $('#opp-' + d);
    const active = S.phase === 'play' && S.turn === s && !S.claim;
    el.className = 'opp opp-' + (d === 1 ? 'right' : d === 2 ? 'top' : 'left') + (active ? ' active' : '') + (st.connected || st.bot ? '' : ' off');
    const meta = [
      s === S.dealer ? '<span class="badge-dealer">庄</span>' : '',
      `<span class="badge-wind">${st.wind}</span>`,
      st.takeover ? '<span class="opp-take">断线托管</span>' : (!st.connected && !st.bot ? '<span class="opp-take">离线</span>' : ''),
    ].join('');
    el.innerHTML = `
      ${active ? '<span class="opp-timer" data-turntimer></span>' : ''}
      <div class="opp-head">
        <div class="opp-avatar">${st.bot ? '🤖' : AVATARS[s]}</div>
        <div style="min-width:0">
          <div class="opp-name">${st.name}</div>
          <div class="opp-meta">${meta}</div>
        </div>
        <div class="opp-score">${st.score}</div>
      </div>
      <div class="opp-hands">${backHTML('xx').repeat(Math.min(st.handCount, 18))}</div>
      <div class="opp-melds">${st.melds.map((m) => meldHTML(m, false, 'xx')).join('')}</div>`;
  }

  // 牌河（随视角旋转：下=自己，右=下家，上=对家，左=上家）
  for (let d = 0; d < 4; d++) {
    const s = (S.you + d) % 4;
    const el = $('#river-' + d);
    const isLast = S.lastEvent && S.lastEvent.kind === 'discard' && S.lastEvent.seat === s;
    el.innerHTML = S.seats[s].river.map((t) =>
      tileHTML(t, 'xs' + (isLast && isLast.tile && t.id === S.lastEvent.tile.id ? ' last' : ''))
    ).join('');
  }

  // 中央
  const wallEl = $('#hud-wall');
  wallEl.textContent = `牌墙 ${S.wallCount} 张`;
  const turnEl = $('#hud-turn');
  turnEl.classList.remove('me');
  if (S.phase === 'end') {
    turnEl.textContent = '本局结束';
  } else if (S.claim) {
    if (S.claim.opts) {
      const acts = [];
      if (S.claim.opts.hu) acts.push('胡');
      if (S.claim.opts.pong) acts.push('碰');
      if (S.claim.opts.kong) acts.push('杠');
      if (S.claim.opts.chi) acts.push('吃');
      turnEl.textContent = `你可以 ${acts.join(' / ')}`;
    } else {
      turnEl.innerHTML = '等待玩家响应 <span class="hud-timer" id="hud-timer"></span>';
    }
  } else if (S.turn === S.you && S.canDiscard) {
    turnEl.innerHTML = '轮到你了 · 点牌打出 <span class="hud-timer" id="hud-timer"></span>';
  } else {
    turnEl.innerHTML = `等待 ${S.seats[S.turn].name} 出牌 <span class="hud-timer" id="hud-timer"></span>`;
  }

  // 我的副露 + 手牌
  $('#my-melds').innerHTML = S.seats[S.you].melds.map((m) => meldHTML(m, true)).join('');
  const handEl = $('#my-hand');
  const myTurn = S.phase === 'play' && S.turn === S.you && S.canDiscard && !S.claim;
  if (!myTurn && selTileId != null) selTileId = null; // 非我回合不残留选中态
  handEl.innerHTML = S.hand.map((t) => {
    let cls = t.id === S.drawnId ? 'drawn' : '';
    if (t.id === selTileId) cls += ' sel';
    if (!myTurn) cls += ' disabled';
    return tileHTML(t, cls);
  }).join('');

  renderActionBar(myTurn);
  if (S.phase === 'end') renderEndModal(); else closeModal();
}

function renderActionBar(myTurn) {
  const bar = $('#action-bar');
  const cnt = (deadlineAt > 0)
    ? `<span class="act-count" data-countdown>×</span>` : '';
  if (S.claim && S.claim.opts) {
    const o = S.claim.opts;
    let html = `<span class="act-hint">${S.claim.rob ? '有人补杠，可抢杠胡！' : '是否要这张牌？'}</span>`;
    if (o.hu) html += `<button class="act-btn act-hu" data-act="hu">胡</button>`;
    if (o.kong) html += `<button class="act-btn act-gang" data-act="kong">杠</button>`;
    if (o.pong) html += `<button class="act-btn act-pong" data-act="pong">碰</button>`;
    if (o.chi) {
      html += o.chi.map((opt) => {
        const combo = [...opt.codes, S.claim.tile.code].sort((a, b) => orderKey(a) - orderKey(b));
        const mini = combo.map((c) => `<div class="tile xx">${tileFace(c)}</div>`).join('');
        return `<span class="chi-opt" data-chi="${opt.ids.join(',')}">${mini}<b style="font-size:13px;margin-left:6px">吃</b></span>`;
      }).join('');
    }
    html += `<button class="act-btn act-pass" data-act="pass">过</button>${cnt}`;
    bar.innerHTML = html;
    bar.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.act;
        send({ t: 'claim', choice: a });
      };
    });
    bar.querySelectorAll('[data-chi]').forEach((b) => {
      b.onclick = () => send({ t: 'claim', choice: 'chi', ids: b.dataset.chi.split(',').map(Number) });
    });
    return;
  }
  if (myTurn) {
    let html = '';
    const selTile = selTileId != null ? S.hand.find((t) => t.id === selTileId) : null;
    if (selTile) {
      html += `<button class="btn-discard" data-discard>打出 · ${codeName(selTile.code)}<i>点击按钮或再点这张牌确认</i></button>`;
    } else {
      html += `<span class="act-hint">点击一张牌选中${S.drawnId ? '（最右侧为刚摸的牌）' : ''}，再点按钮打出</span>`;
    }
    if (S.selfActs && S.selfActs.hu) {
      html += `<button class="act-btn act-hu" data-self="hu">🎉 自摸！胡</button>`;
    }
    if (S.selfActs && S.selfActs.gangs && S.selfActs.gangs.length) {
      html += S.selfActs.gangs.map((g, i) =>
        `<button class="act-btn act-gang" data-self="gang" data-code="${g.code}">${g.kind === 'an' ? '暗杠' : '补杠'} ${codeName(g.code)}</button>`
      ).join('');
    }
    html += cnt;
    bar.innerHTML = html;
    const dbtn = bar.querySelector('[data-discard]');
    if (dbtn) {
      dbtn.onclick = () => {
        if (selTileId != null) {
          send({ t: 'discard', id: selTileId });
          selTileId = null;
        }
      };
    }
    bar.querySelectorAll('[data-self]').forEach((b) => {
      b.onclick = () => send({ t: 'self', choice: b.dataset.self, code: b.dataset.code });
    });
    return;
  }
  bar.innerHTML = S.phase === 'end' ? '' : '<span class="act-hint">等待其他玩家行动…</span>';
}

/* ---------- 结算弹层 ---------- */
function renderEndModal() {
  const root = $('#modal-root');
  const sum = S.summary || {};
  const me = S.seats[S.you];
  const iWon = sum.winner === S.you;
  let head = '';
  if (sum.draw) {
    head = `<div class="win-banner"><div class="emoji">🤝</div><div class="who">流局 · 无人胡牌</div></div>`;
  } else {
    head = `<div class="win-banner">
      <div class="emoji">${iWon ? '🏆' : '🎉'}</div>
      <div class="who">${iWon ? '恭喜你胡了！' : sum.winnerName + ' 胡牌'}</div>
      <div class="fan">${sum.source === 'self' ? '自摸' : sum.source === 'rob' ? '抢杠胡' : '点炮'} · 共 ${sum.fan} 番</div>
      <div class="fan-chips">${(sum.items || []).map(([n, f]) => `<span class="fan-chip">${n} +${f}</span>`).join('')}</div>
    </div>`;
  }
  const rows = S.seats.map((st, i) => {
    const d = (sum.deltas || [])[i] || 0;
    const dt = d > 0 ? `<span class="delta-up">+${d}</span>` : d < 0 ? `<span class="delta-down">${d}</span>` : '—';
    return `<tr class="${i === S.you ? 'me' : ''}">
      <td>${st.name}${i === S.you ? '（你）' : ''}</td><td>${dt}</td><td>${st.score}</td>
      <td>${st.ready ? '✅ 已准备' : '⏳ …'}</td></tr>`;
  }).join('');
  const reveals = sum.hands
    ? S.seats.map((st, i) => `<div class="reveal-row${i === sum.winner ? ' winner' : ''}">
        <div class="reveal-name">${st.name}</div>
        ${((sum.hands || [])[i] || []).map((t) => tileHTML(t, 'xs')).join('')}
        ${i === sum.winner && sum.winTile ? tileHTML(sum.winTile, 'xs') : ''}
      </div>`).join('')
    : '';
  const readyBtn = me.ready
    ? `<button class="btn btn-gold" disabled>已准备 · 等待其他玩家</button>`
    : `<button class="btn btn-gold btn-lg" id="btn-ready">准备下一局</button>`;
  root.innerHTML = `<div class="modal">
    ${head}
    <table class="score-table">
      <tr><th>玩家</th><th>本局</th><th>总分</th><th>状态</th></tr>${rows}
    </table>
    <div class="reveal-hands">${reveals}</div>
    <div class="modal-actions">${readyBtn}</div>
    <div class="ready-dots">全员准备后自动开始下一局（超时 15 秒自动继续）</div>
  </div>`;
  root.classList.remove('hidden');
  const rb = $('#btn-ready');
  if (rb) rb.onclick = () => send({ t: 'ready' });
  if (!me.ready) snd.alert();
}
function closeModal() { $('#modal-root').classList.add('hidden'); $('#modal-root').innerHTML = ''; }

/* ---------- 帮助 ---------- */
function showHelp() {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal">
    <h2>玩法说明</h2>
    <div class="help-flow">
      <div class="hf"><i>1</i><p>输入昵称，<b>创建房间</b>或输入 4 位房号<b>加入房间</b>；把房间号/链接分享给同一局域网的朋友。</p></div>
      <div class="hf"><i>2</i><p>不满 4 人时房主可以添加<b>机器人</b>补位，凑满 4 人后由房主<b>开始对局</b>。</p></div>
      <div class="hf"><i>3</i><p>轮到自己时先<b>摸牌</b>，<b>点击一张牌选中</b>，再点金色<b>「打出」按钮</b>确认（或再点一次该牌）；倒计时最后 5 秒会变红并滴答提醒。</p></div>
      <div class="hf"><i>4</i><p>别人打出的牌可以<b>吃 / 碰 / 杠 / 胡</b>，按钮会自动弹出，不想要就点「过」。胡牌优先于碰杠，碰杠优先于吃。</p></div>
      <div class="hf"><i>5</i><p>自己回合可<b>自摸胡牌</b>或<b>暗杠 / 补杠</b>；牌墙摸完无人胡牌则<b>流局</b>。</p></div>
      <div class="hf"><i>6</i><p>结算后点击<b>准备下一局</b>，全员准备自动开新局，积分累计。</p></div>
    </div>
    <div class="help-sec">
      <h3>计分规则（休闲简化版）</h3>
      <ul>
        <li>平胡 1 番；七对 +2、对对胡 +2、混一色 +2、清一色 +4、门清 +1、自摸 +1、杠上开花 +1</li>
        <li>自摸：其余三家每家付番数，赢家 +3 倍；点炮 / 被抢杠：只由放炮方付番数</li>
        <li>每次杠牌（明杠/暗杠/补杠）：其余三家各付 1 分给杠牌者</li>
      </ul>
      <h3>其他说明</h3>
      <ul>
        <li>出牌限时 20 秒，超时自动代打；吃碰杠胡响应限时 10 秒</li>
        <li>对局中断线可重新加入同一房间，断线期间由机器人托管</li>
      </ul>
    </div>
    <div class="modal-actions"><button class="btn btn-gold" id="btn-help-close">知道了</button></div>
  </div>`;
  root.classList.remove('hidden');
  $('#btn-help-close').onclick = closeModal;
}

/* ---------- 总渲染 ---------- */
function render() {
  if (!S) return;
  if (S.phase === 'lobby') { closeModal(); renderLobby(); showView('lobby'); }
  else { renderGame(); showView('game'); }
}

/* ---------- 倒计时刷新（我的行动 + 全员行动窗口，最后 5 秒红色脉冲 + 滴答） ---------- */
setInterval(() => {
  const nowP = performance.now();
  const myLeft = deadlineAt ? Math.max(0, Math.ceil((deadlineAt - nowP) / 1000)) : null;
  $$('[data-countdown]').forEach((el) => {
    el.textContent = myLeft == null ? '' : myLeft + 's';
    el.classList.toggle('urgent', myLeft != null && myLeft <= 5);
  });
  if (myLeft != null && myLeft <= 5 && myLeft !== lastTickSec) {
    lastTickSec = myLeft;
    snd.tick();
  }
  if (myLeft == null || myLeft > 5) lastTickSec = -1;

  const gLeft = turnDeadlineAt ? Math.max(0, Math.ceil((turnDeadlineAt - nowP) / 1000)) : null;
  const ht = document.getElementById('hud-timer');
  if (ht) {
    ht.textContent = gLeft == null ? '' : gLeft + 's';
    ht.classList.toggle('urgent', gLeft != null && gLeft <= 5);
  }
  $$('[data-turntimer]').forEach((el) => {
    el.textContent = gLeft == null ? '' : gLeft + 's';
    el.classList.toggle('urgent', gLeft != null && gLeft <= 5);
  });
}, 200);

/* ---------- 交互绑定 ---------- */
function bind() {
  // 首页
  $('#inp-name').value = myName;
  const hash = location.hash.replace('#', '').trim();
  if (hash) $('#inp-code').value = hash;

  const getName = () => {
    const n = $('#inp-name').value.trim();
    if (!n) { toast('请先输入昵称'); $('#inp-name').focus(); return null; }
    myName = n;
    localStorage.setItem('mj_name', n);
    return n;
  };
  $('#btn-create').onclick = () => {
    const n = getName(); if (!n) return;
    send({ t: 'create', name: n });
  };
  $('#btn-join').onclick = () => {
    const n = getName(); if (!n) return;
    const c = $('#inp-code').value.trim();
    if (!/^\d{4}$/.test(c)) { toast('请输入 4 位数字房号'); return; }
    send({ t: 'join', name: n, code: c });
  };
  $('#inp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#btn-help-home').onclick = showHelp;

  // 大厅
  $('#btn-leave-lobby').onclick = () => {
    if (confirm('确定离开房间？')) {
      try { sessionStorage.removeItem('mj_room'); } catch { /* ignore */ }
      send({ t: 'leave' });
    }
  };
  $('#btn-addbot').onclick = () => send({ t: 'addBot' });
  $('#btn-start').onclick = () => send({ t: 'start' });
  $('#btn-copy-link').onclick = async () => {
    const link = location.origin + '/#' + S.code;
    try {
      await navigator.clipboard.writeText(link);
      toast('邀请链接已复制：' + link);
    } catch {
      window.prompt('复制下面的邀请链接发给朋友：', link);
    }
  };

  // 对局
  $('#btn-help').onclick = showHelp;
  $('#btn-sound').onclick = () => {
    const on = snd.toggle();
    $('#btn-sound').textContent = on ? '🔊' : '🔇';
  };
  $('#btn-exit').onclick = () => {
    if (confirm('退出后本局将由机器人托管，确定退出？')) {
      try { sessionStorage.removeItem('mj_room'); } catch { /* ignore */ }
      send({ t: 'leave' });
    }
  };

  // 手牌点击（事件委托）
  $('#my-hand').addEventListener('click', (e) => {
    const tEl = e.target.closest('.tile');
    if (!tEl || !S) return;
    if (!(S.phase === 'play' && S.turn === S.you && S.canDiscard && !S.claim)) return;
    const id = +tEl.dataset.id;
    if (selTileId === id) {
      send({ t: 'discard', id });
      selTileId = null;
    } else {
      selTileId = id;
      snd.tick();
      render();
    }
  });

  // 断线重连
  $('#btn-reconnect').onclick = () => { connect(); };
  $('#btn-back-home').onclick = () => { location.reload(); };
}

/* ---------- 启动 ---------- */
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '').trim();
  if (h && !S) $('#inp-code').value = h;
});
bind();
if (snd.on === false) $('#btn-sound').textContent = '🔇';
connect();
if (!localStorage.getItem('mj_help_seen')) {
  setTimeout(showHelp, 400);
  localStorage.setItem('mj_help_seen', '1');
}
