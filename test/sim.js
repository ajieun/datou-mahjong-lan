'use strict';
/* 无头联机模拟：1 个"真人"客户端 + 3 个机器人，完整跑 N 局，验证状态机不崩溃 */
const net = require('net');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8420);
const ROUNDS = +(process.env.ROUNDS || 3);

function encodeFrame(str) {
  const payload = Buffer.from(str);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

class WSClient {
  constructor() { this.buffer = Buffer.alloc(0); this.queue = []; this.waiters = []; }
  connect() {
    return new Promise((res, rej) => {
      this.sock = net.connect(PORT, '127.0.0.1', () => {
        const key = crypto.randomBytes(16).toString('base64');
        this.sock.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.sock.on('error', rej);
      let handshaken = false;
      this.sock.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!handshaken) {
          const idx = this.buffer.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buffer.slice(0, idx).toString();
          if (!/101/.test(head)) { rej(new Error('handshake fail: ' + head)); return; }
          this.buffer = this.buffer.slice(idx + 4);
          handshaken = true; res();
        }
        this.parse();
      });
    });
  }
  parse() {
    for (;;) {
      const f = this.readFrame();
      if (!f) break;
      if (f.op === 0x1) {
        const msg = JSON.parse(f.payload.toString());
        const w = this.waiters.shift();
        if (w) w(msg); else this.queue.push(msg);
      } else if (f.op === 0x9) {
        this.sock.write(Buffer.from([0x8A, 0x80 | f.payload.length, 0, 0, 0, 0])); // pong（示例掩码即可）
      }
    }
  }
  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return null;
    const payload = buf.slice(off, off + len);
    this.buffer = buf.slice(off + len);
    return { op, payload };
  }
  send(obj) { this.sock.write(encodeFrame(JSON.stringify(obj))); }
  /** 等待下一个满足谓词的状态消息 */
  wait(pred, timeout = 15000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('wait timeout')), timeout);
      const w = (m) => {
        if (pred(m)) { clearTimeout(to); res(m); }
        else { this.waiters.push(w); } // 不匹配则继续等下一条
      };
      this.waiters.push(w);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new WSClient();
  await c.connect();
  console.log('[ok] websocket 握手成功（自实现协议）');
  c.send({ t: 'create', name: '测试员' });
  let st = await c.wait((m) => m.t === 'state' && m.phase === 'lobby');
  const code = st.code;
  console.log('[ok] 创建房间', code, '我的座位', st.you);
  c.send({ t: 'addBot' });
  await c.wait((m) => m.phase === 'lobby' && m.seats.filter((s) => s.name).length === 2);
  c.send({ t: 'addBot' });
  await c.wait((m) => m.phase === 'lobby' && m.seats.filter((s) => s.name).length === 3);
  c.send({ t: 'addBot' });
  st = await c.wait((m) => m.phase === 'lobby' && m.seats.every((s) => s.name));
  console.log('[ok] 3 个机器人已入座');
  c.send({ t: 'start' });
  st = await c.wait((m) => m.phase === 'play');
  console.log('[ok] 对局开始，庄家座位', st.dealer, '牌墙', st.wallCount);

  let roundDone = 0;
  let guard = Date.now() + 120000;
  while (roundDone < ROUNDS && Date.now() < guard) {
    if (st.phase === 'end') {
      roundDone++;
      const sum = st.summary;
      if (sum.draw) console.log(`[局${st.roundNo}] 流局`);
      else console.log(`[局${st.roundNo}] ${sum.winnerName} 胡（${sum.source}，${sum.fan}番，${sum.items.map((x) => x.join('+')).join(' ')}）`, '分差', sum.deltas.join(','));
      await sleep(300);
      if (!st.seats[st.you].ready) c.send({ t: 'ready' });
      st = await c.wait((m) => m.t === 'state' && (m.phase === 'play' || m.phase === 'end'), 25000);
      continue;
    }
    let acted = false;
    if (st.phase === 'play' && st.turn === st.you && st.canDiscard && !st.claim) {
      const tile = st.hand[st.hand.length - 1];
      c.send({ t: 'discard', id: tile.id });
      acted = true;
    } else if (st.phase === 'play' && st.claim && st.claim.opts) {
      const o = st.claim.opts;
      if (o.hu && Math.random() < 0.9) { console.log('[我] 胡！'); c.send({ t: 'claim', choice: 'hu' }); }
      else if (o.kong && Math.random() < 0.5) c.send({ t: 'claim', choice: 'kong' });
      else if (o.pong && Math.random() < 0.4) c.send({ t: 'claim', choice: 'pong' });
      else if (o.chi && Math.random() < 0.3) c.send({ t: 'claim', choice: 'chi', ids: o.chi[0].ids });
      else c.send({ t: 'claim', choice: 'pass' });
      acted = true;
    }
    if (acted) await sleep(150);
    st = await c.wait((m) => m.t === 'state', 30000);
  }
  console.log(`[done] 完成 ${roundDone}/${ROUNDS} 局，状态机无崩溃`);
  if (roundDone < ROUNDS) { console.error('[fail] 超时未完成局数'); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
