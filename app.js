#!/usr/bin/env node

const net = require('net');
const http = require('http');
const { Buffer } = require('buffer');

// ===== 环境变量 =====
const UUID = process.env.UUID || '24b4b1e1-ffff-ffff-ffff-242cf53b5bdb';
const XPATH = process.env.XPATH || UUID.slice(0, 8);
const SUB_PATH = process.env.SUB_PATH || 'sub';
const DOMAIN = process.env.DOMAIN || '';
const NAME = process.env.NAME || 'node';
const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'none';

// ===== 小容器参数 =====
const SETTINGS = {
  MAX_BUFFERED_POSTS: 12,
  MAX_POST_SIZE: 512 * 1024,      // 256KB
  SESSION_TIMEOUT: 15000,         // 10秒
  MAX_SESSION_AGE: 120000,         // 90秒
  CLEANUP_INTERVAL: 30000,        // 30秒
  CONNECT_TIMEOUT: 8000,          // 8秒
  SOCKET_IDLE_TIMEOUT: 45000,     // 30秒
  MAX_CONNECTIONS: 100,
};

function log(type, ...args) {
  if (LOG_LEVEL === 'none') return;
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[type] ?? 0) < (levels[LOG_LEVEL] ?? 2)) return;
  console.log(`[${new Date().toISOString()}] [${type}]`, ...args);
}

function validate_uuid(left, right) {
  for (let i = 0; i < 16; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function parse_uuid(uuid) {
  uuid = uuid.replaceAll('-', '');
  const r = [];
  for (let i = 0; i < 16; i++) {
    r.push(parseInt(uuid.substr(i * 2, 2), 16));
  }
  return r;
}

function concat_typed_arrays(first, ...args) {
  if (!first) first = new Uint8Array();
  let len = first.length;
  for (const a of args) len += a.length;
  const r = new first.constructor(len);
  r.set(first, 0);
  let offset = first.length;
  for (const a of args) {
    r.set(a, offset);
    offset += a.length;
  }
  return r;
}

async function read_atleast(reader, n) {
  const buffs = [];
  let done = false;

  while (n > 0 && !done) {
    const r = await reader.read();
    if (r.value) {
      const b = new Uint8Array(r.value);
      buffs.push(b);
      n -= b.length;
    }
    done = r.done;
  }

  if (n > 0) throw new Error('not enough data to read');

  return {
    value: concat_typed_arrays(new Uint8Array(), ...buffs),
    done,
  };
}

async function read_vless_header(reader, cfg_uuid_str) {
  let readed_len = 0;
  let header = new Uint8Array();
  let read_result = { value: header, done: false };

  async function inner_read_until(offset) {
    if (read_result.done) throw new Error('header length too short');
    const len = offset - readed_len;
    if (len < 1) return;
    read_result = await read_atleast(reader, len);
    readed_len += read_result.value.length;
    header = concat_typed_arrays(header, read_result.value);
  }

  await inner_read_until(18);

  const version = header[0];
  const uuid = header.slice(1, 17);
  const cfg_uuid = parse_uuid(cfg_uuid_str);

  if (!validate_uuid(uuid, cfg_uuid)) {
    throw new Error('invalid UUID');
  }

  const pb_len = header[17];
  const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1;
  await inner_read_until(addr_plus1 + 1);

  const cmd = header[1 + 16 + 1 + pb_len];
  if (cmd !== 1) throw new Error(`unsupported command: ${cmd}`);

  const port = (header[addr_plus1 - 3] << 8) + header[addr_plus1 - 2];
  const atype = header[addr_plus1 - 1];

  let header_len = -1;
  if (atype === 1) header_len = addr_plus1 + 4;
  else if (atype === 2) header_len = addr_plus1 + 1 + header[addr_plus1];
  else if (atype === 3) header_len = addr_plus1 + 16;

  if (header_len < 0) throw new Error('read address type failed');

  await inner_read_until(header_len);

  const idx = addr_plus1;
  let hostname = '';

  if (atype === 1) {
    hostname = header.slice(idx, idx + 4).join('.');
  } else if (atype === 2) {
    hostname = new TextDecoder().decode(
      header.slice(idx + 1, idx + 1 + header[idx])
    );
  } else if (atype === 3) {
    hostname = header
      .slice(idx, idx + 16)
      .reduce(
        (s, b2, i2, a) =>
          i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
        []
      )
      .join(':');
  }

  if (!hostname) throw new Error('parse hostname failed');

  return {
    hostname,
    port,
    data: header.slice(header_len),
    resp: Buffer.from([version, 0]),
  };
}

async function parse_header(firstPacket) {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(firstPacket);
      controller.close();
    }
  });

  const reader = readable.getReader();
  try {
    return await read_vless_header(reader, UUID);
  } finally {
    reader.releaseLock();
  }
}

function connect_remote(hostname, port) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ host: hostname, port });

    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('connect timeout'));
    }, SETTINGS.CONNECT_TIMEOUT);

    conn.once('connect', () => {
      clearTimeout(timer);
      conn.setNoDelay(true);
      conn.setKeepAlive(true, 30000);
      conn.setTimeout(SETTINGS.SOCKET_IDLE_TIMEOUT, () => conn.destroy());
      resolve(conn);
    });

    conn.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ===== 会话 =====
const sessions = new Map();

class Session {
  constructor(id) {
    this.id = id;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.initialized = false;
    this.downstreamStarted = false;
    this.remote = null;
    this.responseHeader = null;
    this.headerSent = false;
    this.pendingBuffers = new Map();
    this.cleaned = false;
    this.cleanupTimer = setTimeout(() => this.cleanup(), SETTINGS.MAX_SESSION_AGE);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  async initialize(firstPacket) {
    if (this.initialized) return;

    const vless = await parse_header(firstPacket);
    this.vless = vless;
    this.remote = await connect_remote(vless.hostname, vless.port);

    if (vless.data && vless.data.length) {
      await this.writeToRemote(vless.data);
    }

    this.responseHeader = vless.resp;
    this.initialized = true;
  }

  async processPacket(seq, data) {
    if (this.cleaned) throw new Error('session cleaned');
    this.touch();

    if (!this.initialized && this.pendingBuffers.size >= SETTINGS.MAX_BUFFERED_POSTS) {
      throw new Error('too many buffered packets');
    }

    if (seq === 0 && !this.initialized) {
      await this.initialize(data);
      await this.flushPending();
      return;
    }

    if (!this.initialized) {
      this.pendingBuffers.set(seq, data);
      return;
    }

    await this.writeToRemote(data);
  }

  async flushPending() {
    const seqs = Array.from(this.pendingBuffers.keys()).sort((a, b) => a - b);
    for (const seq of seqs) {
      const data = this.pendingBuffers.get(seq);
      this.pendingBuffers.delete(seq);
      if (data && data.length) {
        await this.writeToRemote(data);
      }
    }
  }

  writeToRemote(data) {
    return new Promise((resolve, reject) => {
      if (!this.remote || this.remote.destroyed) {
        reject(new Error('remote not available'));
        return;
      }
      this.remote.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  attachDownstream(socket) {
    if (!this.initialized || !this.remote) throw new Error('not initialized');
    this.downstreamStarted = true;
    this.touch();

    if (!this.headerSent) {
      socket.write(this.responseHeader);
      this.headerSent = true;
    }

    const onRemoteData = (chunk) => {
      if (!socket.destroyed) socket.write(chunk);
    };

    const onRemoteClose = () => {
      if (!socket.destroyed) socket.end();
      this.cleanup();
    };

    const onRemoteError = () => {
      if (!socket.destroyed) socket.end();
      this.cleanup();
    };

    const onClientData = (chunk) => {
      if (this.remote && !this.remote.destroyed) {
        this.remote.write(chunk);
      }
    };

    const onClientClose = () => this.cleanup();
    const onClientError = () => this.cleanup();

    this.remote.on('data', onRemoteData);
    this.remote.once('close', onRemoteClose);
    this.remote.once('error', onRemoteError);

    socket.on('data', onClientData);
    socket.once('close', onClientClose);
    socket.once('error', onClientError);

    this.detach = () => {
      if (this.remote) {
        this.remote.removeListener('data', onRemoteData);
        this.remote.removeListener('close', onRemoteClose);
        this.remote.removeListener('error', onRemoteError);
      }
      socket.removeListener('data', onClientData);
      socket.removeListener('close', onClientClose);
      socket.removeListener('error', onClientError);
    };
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;

    clearTimeout(this.cleanupTimer);

    try {
      if (this.detach) this.detach();
    } catch {}

    this.pendingBuffers.clear();

    if (this.remote) {
      try {
        this.remote.removeAllListeners();
        this.remote.destroy();
      } catch {}
      this.remote = null;
    }

    sessions.delete(this.id);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SETTINGS.MAX_SESSION_AGE) {
      session.cleanup();
    }
  }
}, SETTINGS.CLEANUP_INTERVAL);

// ===== 工具 =====
function getHostForSubscribe() {
  return DOMAIN || '127.0.0.1';
}

// ===== HTTP 服务 =====
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  if (req.url === `/${SUB_PATH}`) {
    const host = getHostForSubscribe();
    const security = DOMAIN ? 'tls' : 'none';
    const port = DOMAIN ? 443 : PORT;
    const nodeName = encodeURIComponent(NAME);

    const vlessURL =
      `vless://${UUID}@${host}:${port}` +
      `?encryption=none&security=${security}` +
      `&type=xhttp&path=%2F${XPATH}&mode=packet-up` +
      `&host=${host}&sni=${host}` +
      `#${nodeName}`;

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(Buffer.from(vlessURL).toString('base64') + '\n');
    return;
  }

  const match = req.url && req.url.match(new RegExp(`^/${XPATH}/([^/]+)(?:/([0-9]+))?$`));
  if (!match) {
    res.writeHead(404);
    res.end();
    return;
  }

  const sessionId = match[1];
  const seq = match[2] ? parseInt(match[2], 10) : null;

  // GET: 下行
  if (req.method === 'GET' && seq === null) {
    const socket = res.socket;
    if (!socket) {
      res.writeHead(500);
      res.end();
      return;
    }

    let session = sessions.get(sessionId);
    if (!session) {
      session = new Session(sessionId);
      sessions.set(sessionId, session);
    }

    try {
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: application/octet-stream\r\n' +
        'Cache-Control: no-store\r\n' +
        'Connection: close\r\n' +
        '\r\n'
      );
    } catch {
      session.cleanup();
      return;
    }

    let waited = 0;
    const step = 50;

    const waitForInit = () => {
      if (session.cleaned) {
        try { socket.end(); } catch {}
        return;
      }

      if (session.initialized && session.remote) {
        try {
          session.attachDownstream(socket);
        } catch {
          session.cleanup();
          try { socket.end(); } catch {}
        }
        return;
      }

      waited += step;
      if (waited >= SETTINGS.SESSION_TIMEOUT) {
        session.cleanup();
        try { socket.end(); } catch {}
        return;
      }

      setTimeout(waitForInit, step);
    };

    waitForInit();
    return;
  }

  // POST: 上行
  if (req.method === 'POST' && seq !== null) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = new Session(sessionId);
      sessions.set(sessionId, session);

      setTimeout(() => {
        const s = sessions.get(sessionId);
        if (s && !s.downstreamStarted) s.cleanup();
      }, SETTINGS.SESSION_TIMEOUT);
    }

    let total = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;

      total += chunk.length;
      if (total > SETTINGS.MAX_POST_SIZE) {
        aborted = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (aborted) return;

      try {
        const buffer = Buffer.concat(chunks);
        await session.processPacket(seq, buffer);
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Cache-Control': 'no-store',
        });
        res.end();
      } catch (err) {
        log('warn', 'POST failed:', err.message);
        session.cleanup();
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });

    req.on('error', () => {
      session.cleanup();
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });

    return;
  }

  res.writeHead(404);
  res.end();
});

server.keepAliveTimeout = 20000;
server.headersTimeout = 25000;
server.requestTimeout = 45000;
server.timeout = 45000;
server.maxConnections = SETTINGS.MAX_CONNECTIONS;

server.on('connection', (socket) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(SETTINGS.SOCKET_IDLE_TIMEOUT, () => socket.destroy());
});

server.on('error', (err) => {
  log('error', 'server error:', err.message);
});

server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
