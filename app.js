const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const axios = require('axios');
const path = require('path');
const { Buffer } = require('buffer');
const { execSync } = require('child_process');

// ===== 环境变量 =====
const UUID = process.env.UUID || '24b4b1e1-ffff-ffff-ffff-242cf53b5bdb';
const XPATH = process.env.XPATH || UUID.slice(0, 8);
const SUB_PATH = process.env.SUB_PATH || `${UUID}`;
const DOMAIN = process.env.DOMAIN || '';
const NAME = process.env.NAME || '';
const PORT = process.env.PORT || 3000;

// ===== 核心参数 =====
const SETTINGS = {
    UUID: UUID,
    XPATH: `%2F${XPATH}`,

    MAX_BUFFERED_POSTS: 8,
    MAX_POST_SIZE: 512 * 1024,

    SESSION_TIMEOUT: 5000,
    CHUNK_SIZE: 64 * 1024,
};

// ===== 工具函数 =====
function parse_uuid(uuid) {
    uuid = uuid.replaceAll('-', '');
    const r = [];
    for (let i = 0; i < 16; i++) {
        r.push(parseInt(uuid.substr(i * 2, 2), 16));
    }
    return r;
}

function validate_uuid(left, right) {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

// ===== VLESS解析（极简）=====
function parse_header(uuid_str, buffer) {
    const uuid = buffer.slice(1, 17);
    if (!validate_uuid(uuid, parse_uuid(uuid_str))) {
        throw new Error('invalid UUID');
    }

    const optLen = buffer[17];
    const cmd = buffer[18 + optLen];

    if (cmd !== 1) throw new Error('only tcp');

    const addrType = buffer[19 + optLen];
    let offset = 20 + optLen;

    let host = '';
    if (addrType === 1) {
        host = buffer.slice(offset, offset + 4).join('.');
        offset += 4;
    } else if (addrType === 2) {
        const len = buffer[offset];
        host = buffer.slice(offset + 1, offset + 1 + len).toString();
        offset += 1 + len;
    }

    const port = buffer.readUInt16BE(offset);
    offset += 2;

    return { host, port, data: buffer.slice(offset) };
}

// ===== Session（终极稳核心）=====
class Session {
    constructor() {
        this.nextSeq = 0;
        this.pendingBuffers = new Map();
        this.remote = null;
        this.initialized = false;
    }

    async init(firstPacket) {
        const v = parse_header(SETTINGS.UUID, firstPacket);
        this.remote = net.createConnection({ host: v.host, port: v.port });
        this.remote.setNoDelay(true);
        this.remote.setKeepAlive(true);
        this.remote.write(v.data);
        this.initialized = true;
    }

    async process(seq, data) {

        // ⭐ 超窗口直接丢（防炸）
        if (seq > this.nextSeq + 3) return;

        // ⭐ 轻量乱序缓存（最多3个）
        if (seq !== this.nextSeq) {
            if (this.pendingBuffers.size >= 3) return;
            this.pendingBuffers.set(seq, data);
            return;
        }

        // ===== 正常顺序 =====
        if (!this.initialized && seq === 0) {
            await this.init(data);
        } else {
            if (!this.remote) return;
            this.remote.write(data);
        }

        this.nextSeq++;

        // ⭐ 尝试补发缓存（最多3个）
        for (let i = 0; i < 3; i++) {
            if (!this.pendingBuffers.has(this.nextSeq)) break;

            const d = this.pendingBuffers.get(this.nextSeq);
            this.pendingBuffers.delete(this.nextSeq);

            this.remote.write(d);
            this.nextSeq++;
        }
    }
}

const sessions = new Map();

// ===== 获取IP =====
let IP = DOMAIN;
if (!DOMAIN) {
    try {
        IP = execSync('curl -s ipv4.ip.sb').toString().trim();
    } catch {
        IP = '127.0.0.1';
    }
}

// ===== HTTP服务 =====
const server = http.createServer((req, res) => {

    // ===== 首页（内嵌HTML伪装）=====
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
<!DOCTYPE html>
<html>
<head>
<title>Welcome</title>
<style>
body { font-family: Arial; text-align:center; padding:50px; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the server is running.</p>
</body>
</html>
        `);
        return;
    }

    // ===== 订阅 =====
    if (req.url === `/${SUB_PATH}`) {
        const vlessURL =
            `vless://${UUID}@${IP}:443?encryption=none&security=tls&type=xhttp&path=${SETTINGS.XPATH}#${NAME}`;
        res.end(Buffer.from(vlessURL).toString('base64'));
        return;
    }

    // ===== xhttp入口 =====
    const match = req.url.match(new RegExp(`${XPATH}/([^/]+)/(\\d+)`));
    if (!match) {
        res.writeHead(404);
        return res.end();
    }

    const id = match[1];
    const seq = parseInt(match[2]);

    let session = sessions.get(id);
    if (!session) {
        session = new Session();
        sessions.set(id, session);
    }

    let chunks = [];
    req.on('data', c => chunks.push(c));

    req.on('end', async () => {
        const buf = Buffer.concat(chunks);

        try {
            await session.process(seq, buf);
            res.writeHead(200);
        } catch {
            res.writeHead(500);
        }

        res.end();
    });
});

// ===== 服务器优化参数 =====
server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;
server.requestTimeout = 60000;
server.timeout = 60000;
server.maxConnections = 30;

server.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});
