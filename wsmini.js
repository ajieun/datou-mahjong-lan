'use strict';
/**
 * 极简 WebSocket 服务端实现（RFC 6455）
 * 仅需：文本帧收发、ping/pong、close、分片重组。零依赖。
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 1MB

class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.teardown());
    socket.on('close', () => this.teardown());
    socket.on('end', () => this.teardown());
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.emit('close');
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      this.handleFrame(frame);
      if (this.closed) break;
    }
  }

  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const op = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (len > MAX_PAYLOAD) { this.teardown(); return null; }
    let mask = null;
    if (masked) {
      if (buf.length < off + 4) return null;
      mask = buf.slice(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return null;
    let payload = buf.slice(off, off + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this.buffer = buf.slice(off + len);
    return { fin, op, payload };
  }

  handleFrame(f) {
    switch (f.op) {
      case 0x0: // 续帧
      case 0x1: // 文本
      case 0x2: { // 二进制
        this.fragments.push(f.payload);
        if (f.fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', full);
        }
        break;
      }
      case 0x8: // close
        this.sendFrame(0x8, Buffer.from([0x03, 0xe8]));
        this.teardown();
        break;
      case 0x9: // ping
        this.sendFrame(0xA, f.payload);
        break;
      case 0xA: // pong
        this.alive = true;
        break;
      default:
        this.teardown();
    }
  }

  sendFrame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.teardown();
    }
  }

  send(str) { this.sendFrame(0x1, Buffer.from(str)); }
  ping() { this.alive = false; this.sendFrame(0x9, Buffer.alloc(0)); }
  close() {
    this.sendFrame(0x8, Buffer.alloc(0));
    try { this.socket.end(); } catch { /* ignore */ }
    this.teardown();
  }
}

/** 挂载到 http.Server 上，接受任意路径的 ws 升级请求 */
function attach(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    onConnection(new WSConn(socket));
  });
}

module.exports = { attach, WSConn };
