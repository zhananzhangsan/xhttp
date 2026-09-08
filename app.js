const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const axios = require('axios');
const path = require('path');
const { Buffer } = require('buffer');
const { exec, execSync } = require('child_process');

// 环境变量
const UUID = process.env.UUID || '24b4b1e1-ffff-ffff-ffff-242cf53b5bdb'; // 使用哪吒v1，在不同的平台部署需修改UUID，否则会覆盖
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';       // 哪吒v1填写形式：nz.abc.com:8008   哪吒v0填写形式：nz.abc.com
const NEZHA_PORT = process.env.NEZHA_PORT || '';           // 哪吒v1没有此变量，v0的agent端口为{443,8443,2096,2087,2083,2053}其中之一时开启tls
const NEZHA_KEY = process.env.NEZHA_KEY || '';             // v1的NZ_CLIENT_SECRET或v0的agent端口  
// 修复：环境变量是字符串，需要正确解析布尔值
const AUTO_ACCESS = String(process.env.AUTO_ACCESS || 'false').toLowerCase() === 'true';
const XPATH = process.env.XPATH || UUID.slice(0, 8);       // xhttp路径,自动获取uuid前8位
const SUB_PATH = process.env.SUB_PATH || `${UUID}`;        // 节点订阅路径,默认位uuid
const DOMAIN = process.env.DOMAIN || '';                   // 域名或ip,留空将自动获取服务器ip
const NAME = process.env.NAME || '';                    // 节点名称
const PORT = process.env.PORT || 3000;                     // http服务                   

// 核心配置
const SETTINGS = {
    UUID: UUID,
    LOG_LEVEL: 'none',
    BUFFER_SIZE: '65536',
    XPATH: `%2F${XPATH}`,
    MAX_BUFFERED_POSTS: 30,
    MAX_POST_SIZE: 1000000,
    SESSION_TIMEOUT: 30000,
    // 乱序包最大等待时间（毫秒），超时则清理 Session
    SEQUENCE_WAIT_TIMEOUT: 8000,
    CHUNK_SIZE: 64 * 1024,
    TCP_NODELAY: true,
    TCP_KEEPALIVE: true,
    // 全局活跃会话上限（生产建议先从 50 起测）
    MAX_SESSIONS: 50,
}


function validate_uuid(left, right) {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false
    }
    return true
}

function concat_typed_arrays(first, ...args) {
    if (!args || args.length < 1) return first
    let len = first.length
    for (let a of args) len += a.length
    const r = new first.constructor(len)
    r.set(first, 0)
    len = first.length
    for (let a of args) {
        r.set(a, len)
        len += a.length
    }
    return r
}

// 扩展日志函数
function log(type, ...args) {
    if (SETTINGS.LOG_LEVEL === 'none') return;

    const levels = {
        'debug': 0,
        'info': 1,
        'warn': 2,
        'error': 3
    };
    
    const colors = {
        'debug': '\x1b[36m', // 青色
        'info': '\x1b[32m',  // 绿色
        'warn': '\x1b[33m',  // 黄色
        'error': '\x1b[31m', // 红色
        'reset': '\x1b[0m'   // 重置
    };

    const configLevel = levels[SETTINGS.LOG_LEVEL] || 1;
    const messageLevel = levels[type] || 0;

    if (messageLevel >= configLevel) {
        const time = new Date().toISOString();
        const color = colors[type] || colors.reset;
        console.log(`${color}[${time}] [${type}]`, ...args, colors.reset);
    }
}

const getDownloadUrl = () => {
    const arch = os.arch(); 
    if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
      if (!NEZHA_PORT) {
        return 'https://arm64.ssss.nyc.mn/v1';
      } else {
          return 'https://arm64.ssss.nyc.mn/agent';
      }
    } else {
      if (!NEZHA_PORT) {
        return 'https://amd64.ssss.nyc.mn/v1';
      } else {
          return 'https://amd64.ssss.nyc.mn/agent';
      }
    }
};
  
const downloadFile = async () => {
    if (!NEZHA_KEY) return;
    try {
      const url = getDownloadUrl();
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream'
      });
  
      // 使用更明确的文件名，避免与真正的 npm 混淆
      const writer = fs.createWriteStream('nezha-agent');
      response.data.pipe(writer);
  
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log('nezha-agent download successfully');
          exec('chmod +x nezha-agent', (err) => {
            if (err) reject(err);
            resolve();
          });
        });
        writer.on('error', reject);
      });
    } catch (err) {
      throw err;
    }
};
  
const runnz = async () => {
    await downloadFile();
    let NEZHA_TLS = '';
    let command = '';
  
    if (NEZHA_SERVER && NEZHA_PORT && NEZHA_KEY) {
      const tlsPorts = ['443', '8443', '2096', '2087', '2083', '2053'];
      NEZHA_TLS = tlsPorts.includes(NEZHA_PORT) ? '--tls' : '';
      command = `nohup ./nezha-agent -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} >/dev/null 2>&1 &`;
    } else if (NEZHA_SERVER && NEZHA_KEY) {
      if (!NEZHA_PORT) {
        // 简单解析 host:port（IPv6 场景建议直接用域名或带 [] 的形式）
        let port = '';
        if (NEZHA_SERVER.startsWith('[')) {
          // [ipv6]:port
          const m = NEZHA_SERVER.match(/\]:(\d+)$/);
          if (m) port = m[1];
        } else if (NEZHA_SERVER.includes(':') && !NEZHA_SERVER.match(/^\d+\.\d+\.\d+\.\d+$/)) {
          // 可能是 host:port 或 IPv6，取最后一个 : 后的数字
          const parts = NEZHA_SERVER.split(':');
          const last = parts[parts.length - 1];
          if (/^\d+$/.test(last)) port = last;
        }
        const tlsPorts = new Set(['443', '8443', '2096', '2087', '2083', '2053']);
        const nezhatls = tlsPorts.has(port) ? 'true' : 'false';
        const configYaml = `
client_secret: ${NEZHA_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: false
ip_report_period: 1800
report_delay: 4
server: ${NEZHA_SERVER}
skip_connection_count: false
skip_procs_count: false
temperature: false
tls: ${nezhatls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;
        
        fs.writeFileSync('config.yaml', configYaml);
      }
      command = `nohup ./nezha-agent -c config.yaml >/dev/null 2>&1 &`;
    } else {
      return;
    }
  
    try {
      exec(command, { shell: '/bin/bash' }, (error) => {
        if (error) {
          console.error(`nezha-agent running error: ${error.message}`);
          return;
        }
        console.log('nezha-agent is running');
      });
    } catch (error) {
      console.error(`nezha-agent running error: ${error}`);
    } 
};
  
// 添加自动任务
async function addAccessTask() {
    if (!AUTO_ACCESS) return;
    try {
        if (!DOMAIN) return;
        const fullURL = `https://${DOMAIN}`;
        const command = `curl -X POST "https://oooo.serv00.net/add-url" -H "Content-Type: application/json" -d '{"url": "${fullURL}"}'`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error sending request:', error.message);
                return;
            }
            console.log('Automatic Access Task added successfully:', stdout);
        });
    } catch (error) {
        console.error('Error added Task:', error.message);
    }
}

// VLESS 协议解析
function parse_uuid(uuid) {
    uuid = uuid.replaceAll('-', '')
    const r = []
    for (let index = 0; index < 16; index++) {
        r.push(parseInt(uuid.substr(index * 2, 2), 16))
    }
    return r
}

async function read_vless_header(reader, cfg_uuid_str) {
    let readed_len = 0
    let header = new Uint8Array()
    let read_result = { value: header, done: false }
    async function inner_read_until(offset) {
        if (read_result.done) {
            throw new Error('header length too short')
        }
        const len = offset - readed_len
        if (len < 1) {
            return
        }
        read_result = await read_atleast(reader, len)
        readed_len += read_result.value.length
        header = concat_typed_arrays(header, read_result.value)
    }

    await inner_read_until(1 + 16 + 1)

    const version = header[0]
    const uuid = header.slice(1, 1 + 16)
    const cfg_uuid = parse_uuid(cfg_uuid_str)
    if (!validate_uuid(uuid, cfg_uuid)) {
        throw new Error(`invalid UUID`)
    }
    const pb_len = header[1 + 16]
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1
    await inner_read_until(addr_plus1 + 1)

    const cmd = header[1 + 16 + 1 + pb_len]
    const COMMAND_TYPE_TCP = 1
    if (cmd !== COMMAND_TYPE_TCP) {
        throw new Error(`unsupported command: ${cmd}`)
    }

    const port = (header[addr_plus1 - 1 - 2] << 8) + header[addr_plus1 - 1 - 1]
    const atype = header[addr_plus1 - 1]

    const ADDRESS_TYPE_IPV4 = 1
    const ADDRESS_TYPE_STRING = 2
    const ADDRESS_TYPE_IPV6 = 3
    let header_len = -1
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16
    } else if (atype === ADDRESS_TYPE_STRING) {
        header_len = addr_plus1 + 1 + header[addr_plus1]
    }
    if (header_len < 0) {
        throw new Error('read address type failed')
    }
    await inner_read_until(header_len)

    const idx = addr_plus1
    let hostname = ''
    if (atype === ADDRESS_TYPE_IPV4) {
        hostname = header.slice(idx, idx + 4).join('.')
    } else if (atype === ADDRESS_TYPE_STRING) {
        hostname = new TextDecoder().decode(
            header.slice(idx + 1, idx + 1 + header[idx]),
        )
    } else if (atype === ADDRESS_TYPE_IPV6) {
        hostname = header
            .slice(idx, idx + 16)
            .reduce(
                (s, b2, i2, a) =>
                    i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
                [],
            )
            .join(':')
    }
    
    if (!hostname) {
        log('error', 'Failed to parse hostname');
        throw new Error('parse hostname failed')
    }
    
    log('info', `VLESS connection to ${hostname}:${port}`);
    return {
        hostname,
        port,
        data: header.slice(header_len),
        resp: new Uint8Array([version, 0]),
    }
}

// read_atleast 函数
async function read_atleast(reader, n) {
    const buffs = []
    let done = false
    while (n > 0 && !done) {
        const r = await reader.read()
        if (r.value) {
            const b = new Uint8Array(r.value)
            buffs.push(b)
            n -= b.length
        }
        done = r.done
    }
    if (n > 0) {
        throw new Error(`not enough data to read`)
    }
    return {
        value: concat_typed_arrays(...buffs),
        done,
    }
}

// parse_header 函数
async function parse_header(uuid_str, client) {
    log('debug', 'Starting to parse VLESS header');
    const reader = client.readable.getReader()
    try {
        const vless = await read_vless_header(reader, uuid_str)
        log('debug', 'VLESS header parsed successfully');
        return vless
    } catch (err) {
        log('error', `VLESS header parse error: ${err.message}`);
        throw new Error(`read vless header error: ${err.message}`)
    } finally {
        reader.releaseLock()
    }
}

// connect_remote 函数
async function connect_remote(hostname, port) {
    const timeout = 8000;
    try {
        const conn = await timed_connect(hostname, port, timeout);
        
        // 优化 TCP 连接
        conn.setNoDelay(true);  // 启用 TCP_NODELAY
        conn.setKeepAlive(true, 10000);  // 启用 TCP keepalive
        // 增大读写缓冲区，减少系统调用与切换开销
        const bufSize = parseInt(SETTINGS.BUFFER_SIZE) || 65536;
        if (conn._readableState) conn._readableState.highWaterMark = bufSize;
        if (conn._writableState) conn._writableState.highWaterMark = bufSize;
        
        log('info', `Connected to ${hostname}:${port}`);
        return conn;
    } catch (err) {
        log('error', `Connection failed: ${err.message}`);
        throw err;
    }
}

// timed_connect 函数
function timed_connect(hostname, port, ms) {
    return new Promise((resolve, reject) => {
        const conn = net.createConnection({ host: hostname, port: port })
        const handle = setTimeout(() => {
            reject(new Error(`connect timeout`))
        }, ms)
        conn.on('connect', () => {
            clearTimeout(handle)
            resolve(conn)
        })
        conn.on('error', (err) => {
            clearTimeout(handle)
            reject(err)
        })
    })
}

// 网络传输（保留，供兼容路径使用）
function pipe_relay() {
    async function pump(src, dest, first_packet) {
        const chunkSize = parseInt(SETTINGS.CHUNK_SIZE);
        
        if (first_packet.length > 0) {
            if (dest.write) {
                dest.cork();
                dest.write(first_packet);
                process.nextTick(() => dest.uncork());
            } else {
                const writer = dest.writable.getWriter();
                try {
                    await writer.write(first_packet);
                } finally {
                    writer.releaseLock();
                }
            }
        }
        
        try {
            if (src.pipe) {
                src.pause();
                src.pipe(dest, {
                    end: true,
                    highWaterMark: chunkSize
                });
                src.resume();
            } else {
                await src.readable.pipeTo(dest.writable, {
                    preventClose: false,
                    preventAbort: false,
                    preventCancel: false,
                    signal: AbortSignal.timeout(SETTINGS.SESSION_TIMEOUT)
                });
            }
        } catch (err) {
            if (!err.message.includes('aborted')) {
                log('error', 'Relay error:', err.message);
            }
            throw err;
        }
    }
    return pump;
}

// socketToWebStream 函数（保留兼容）
function socketToWebStream(socket) {
    let readController;
    let writeController;
    
    socket.on('error', (err) => {
        log('error', 'Socket error:', err.message);
        readController?.error(err);
        writeController?.error(err);
    });

    return {
        readable: new ReadableStream({
            start(controller) {
                readController = controller;
                socket.on('data', (chunk) => {
                    try {
                        controller.enqueue(chunk);
                    } catch (err) {
                        log('error', 'Read controller error:', err.message);
                    }
                });
                socket.on('end', () => {
                    try {
                        controller.close();
                    } catch (err) {
                        log('error', 'Read controller close error:', err.message);
                    }
                });
            },
            cancel() {
                socket.destroy();
            }
        }),
        writable: new WritableStream({
            start(controller) {
                writeController = controller;
            },
            write(chunk) {
                return new Promise((resolve, reject) => {
                    if (socket.destroyed) {
                        reject(new Error('Socket is destroyed'));
                        return;
                    }
                    socket.write(chunk, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            },
            close() {
                if (!socket.destroyed) {
                    socket.end();
                }
            },
            abort(err) {
                socket.destroy(err);
            }
        })
    };
}

// relay 函数（保留兼容）
function relay(cfg, client, remote, vless) {
    const pump = pipe_relay();
    let isClosing = false;
    
    const remoteStream = socketToWebStream(remote);
    
    function cleanup() {
        if (!isClosing) {
            isClosing = true;
            try {
                remote.destroy();
            } catch (err) {
                if (!err.message.includes('aborted') && 
                    !err.message.includes('socket hang up')) {
                    log('error', `Cleanup error: ${err.message}`);
                }
            }
        }
    }

    const uploader = pump(client, remoteStream, vless.data)
        .catch(err => {
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Upload error: ${err.message}`);
            }
        })
        .finally(() => {
            client.reading_done && client.reading_done();
        });

    const downloader = pump(remoteStream, client, vless.resp)
        .catch(err => {
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Download error: ${err.message}`);
            }
        });

    downloader
        .finally(() => uploader)
        .finally(cleanup);
}

// 会话管理
const sessions = new Map();

// 优先清理“空闲/未初始化”的会话，而不是正在传输的最老会话
function getOrCreateSession(uuid) {
    let session = sessions.get(uuid);
    if (!session) {
        if (sessions.size >= SETTINGS.MAX_SESSIONS) {
            // 清理优先级：无 downstream > 无 remote/未初始化 > 最久 idle
            let victim = null;
            let bestScore = -1; // 越高越优先被踢

            for (const [id, s] of sessions) {
                if (s.cleaned || s.cleaning) continue;
                let score = 0;
                if (!s.downstreamStarted) score += 100;
                if (!s.initialized || !s.remote) score += 50;
                // idle 越久分越高
                const idleSec = (Date.now() - s.lastActivity) / 1000;
                score += Math.min(idleSec, 100);
                if (score > bestScore) {
                    bestScore = score;
                    victim = id;
                }
            }

            if (victim) {
                const oldS = sessions.get(victim);
                if (oldS) {
                    log('warn', `Evicting session ${victim} due to MAX_SESSIONS`);
                    oldS.cleanup();
                }
            }

            if (sessions.size >= SETTINGS.MAX_SESSIONS) {
                throw new Error('too many sessions');
            }
        }
        session = new Session(uuid);
        sessions.set(uuid, session);
        log('info', `Created new session: ${uuid}`);
    }
    return session;
}

// 定期清理空闲会话
setInterval(() => {
    const now = Date.now();
    const timeout = SETTINGS.SESSION_TIMEOUT * 2;
    for (const [uuid, session] of sessions) {
        if (now - session.lastActivity > timeout) {
            log('warn', `Idle session timeout: ${uuid}`);
            session.cleanup();
        } else if (session.pendingBuffers && session.pendingBuffers.size > SETTINGS.MAX_BUFFERED_POSTS * 2) {
            log('warn', `Session ${uuid} pendingBuffers overflow, force cleanup`);
            session.cleanup();
        }
    }
}, 15000);

class Session {
    constructor(uuid) {
        this.uuid = uuid;
        this.nextSeq = 0;
        this.downstreamStarted = false;
        this.lastActivity = Date.now();
        this.vlessHeader = null;
        this.remote = null;
        this.initialized = false;
        this.responseHeader = null;
        this.headerSent = false;
        this.downstreamPiped = false;
        this.bufferedData = new Map();
        this.cleaned = false;
        this.cleaning = false;
        this.responseFinished = false;  // 区分正常结束 vs 异常 close
        this.pendingPackets = [];
        this.currentStreamRes = null;
        this.pendingBuffers = new Map();
        this.noDownstreamTimer = null;
        this.sequenceWaitTimer = null;  // 乱序等待超时
        log('debug', `Created new session with UUID: ${uuid}`);
    }

    // 节流刷新活跃时间，避免高速 data 时频繁 Date.now()
    _touch() {
        const now = Date.now();
        if (now - this.lastActivity > 1000) {
            this.lastActivity = now;
        }
    }

    _clearNoDownstreamTimer() {
        if (this.noDownstreamTimer) {
            clearTimeout(this.noDownstreamTimer);
            this.noDownstreamTimer = null;
        }
    }

    _clearSequenceWaitTimer() {
        if (this.sequenceWaitTimer) {
            clearTimeout(this.sequenceWaitTimer);
            this.sequenceWaitTimer = null;
        }
    }

    // 收到乱序包时启动/重置等待定时器
    _armSequenceWaitTimer() {
        this._clearSequenceWaitTimer();
        this.sequenceWaitTimer = setTimeout(() => {
            if (!this.cleaned && this.pendingBuffers.size > 0) {
                log('warn', `Session ${this.uuid} sequence wait timeout (missing seq=${this.nextSeq}), cleanup`);
                this.cleanup();
            }
        }, SETTINGS.SEQUENCE_WAIT_TIMEOUT);
    }

    async initializeVLESS(firstPacket) {
        if (this.initialized) return true;
        
        try {
            log('debug', 'Initializing VLESS connection from first packet');
            const readable = new ReadableStream({
                start(controller) {
                    controller.enqueue(firstPacket);
                    controller.close();
                }
            });
            
            const client = {
                readable: readable,
                writable: new WritableStream()
            };
            
            this.vlessHeader = await parse_header(SETTINGS.UUID, client);
            log('info', `VLESS header parsed: ${this.vlessHeader.hostname}:${this.vlessHeader.port}`);
            
            this.remote = await connect_remote(this.vlessHeader.hostname, this.vlessHeader.port);
            log('info', 'Remote connection established');
            
            this.initialized = true;
            this._touch();
            return true;
        } catch (err) {
            log('error', `Failed to initialize VLESS: ${err.message}`);
            return false;
        }
    }

    async processPacket(seq, data) {
        try {
            this._touch();
            this.pendingBuffers.set(seq, data);
            log('debug', `Buffered packet seq=${seq}, size=${data.length}`);

            // 如果不是期望的 nextSeq，启动乱序等待超时
            if (seq !== this.nextSeq && !this.pendingBuffers.has(this.nextSeq)) {
                this._armSequenceWaitTimer();
            }
            
            // 按序处理数据包
            while (this.pendingBuffers.has(this.nextSeq)) {
                const nextData = this.pendingBuffers.get(this.nextSeq);
                this.pendingBuffers.delete(this.nextSeq);
                
                if (!this.initialized && this.nextSeq === 0) {
                    if (!await this.initializeVLESS(nextData)) {
                        throw new Error('Failed to initialize VLESS connection');
                    }
                    this.responseHeader = Buffer.from(this.vlessHeader.resp);
                    if (this.vlessHeader.data && this.vlessHeader.data.length > 0) {
                        await this._writeToRemote(this.vlessHeader.data);
                    }
                    
                    if (this.currentStreamRes) {
                        this._startDownstreamResponse();
                    }
                } else {
                    if (!this.initialized) {
                        log('warn', `Received out of order packet seq=${seq} before initialization`);
                        continue;
                    }
                    if (nextData && nextData.length > 0) {
                        await this._writeToRemote(nextData);
                    }
                }
                
                this.nextSeq++;
                log('debug', `Processed packet seq=${this.nextSeq-1}`);
            }

            // 已按序推进，清除等待定时器
            if (this.pendingBuffers.size === 0) {
                this._clearSequenceWaitTimer();
            }

            if (this.pendingBuffers.size > SETTINGS.MAX_BUFFERED_POSTS) {
                throw new Error('Too many buffered packets');
            }

            return true;
        } catch (err) {
            log('error', `Process packet error: ${err.message}`);
            throw err;
        }
    }

    startDownstream(res, headers) {
        this._clearNoDownstreamTimer();

        if (!res.headersSent) {
            res.writeHead(200, headers);
        }

        this.currentStreamRes = res;
        this._touch();
        this.downstreamStarted = true;
        
        if (this.initialized && this.responseHeader) {
            this._startDownstreamResponse();
        }
        
        // 关键：只在异常 close（非正常完成）时才 cleanup
        const onClose = () => {
            res.removeListener('close', onClose);
            if (!this.responseFinished) {
                log('info', 'Client connection closed abnormally');
                this.cleanup();
            }
        };
        res.on('close', onClose);
        res.on('error', () => {
            if (!this.responseFinished) {
                this.cleanup();
            }
        });

        return true;
    }

    async _writeToRemote(data) {
        if (!this.remote || this.remote.destroyed) {
            throw new Error('Remote connection not available');
        }
        if (!data || data.length === 0) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.remote.write(data, (err) => {
                if (err) {
                    log('error', `Failed to write to remote: ${err.message}`);
                    reject(err);
                } else {
                    this._touch();
                    resolve();
                }
            });
        });
    }

    _startDownstreamResponse() {
        if (!this.currentStreamRes || !this.responseHeader || !this.remote) return;
        if (this.downstreamPiped) return;
        if (this.currentStreamRes.writableEnded || this.currentStreamRes.destroyed) return;

        try {
            if (!this.headerSent) {
                this.currentStreamRes.write(this.responseHeader);
                this.headerSent = true;
            }

            this.downstreamPiped = true;
            const highWaterMark = parseInt(SETTINGS.CHUNK_SIZE) || 65536;
            if (this.remote._readableState) {
                this.remote._readableState.highWaterMark = highWaterMark;
            }

            // 节流刷新
            this.remote.on('data', () => this._touch());

            this.remote.pipe(this.currentStreamRes, { end: true });

            this.remote.once('end', () => {
                this.responseFinished = true;
                if (this.currentStreamRes && !this.currentStreamRes.writableEnded) {
                    try { this.currentStreamRes.end(); } catch (e) {}
                }
                this.cleanup();
            });

            this.remote.once('error', (err) => {
                log('error', `Remote error: ${err.message}`);
                this.cleanup();
            });
        } catch (err) {
            log('error', `Error starting downstream: ${err.message}`);
            this.cleanup();
        }
    }


    cleanup() {
        if (this.cleaned || this.cleaning) return;
        this.cleaning = true;
        log('debug', `Cleaning up session ${this.uuid}`);

        this._clearNoDownstreamTimer();
        this._clearSequenceWaitTimer();

        // 1. 先停止继续往 response 写
        if (this.remote) {
            try {
                this.remote.unpipe?.();
                this.remote.removeAllListeners('data');
                this.remote.removeAllListeners('end');
                this.remote.removeAllListeners('error');
            } catch (e) {}
        }

        // 2. 结束下游响应
        if (this.currentStreamRes) {
            try {
                if (!this.currentStreamRes.writableEnded && !this.currentStreamRes.destroyed) {
                    this.currentStreamRes.end();
                }
            } catch (e) {}
            this.currentStreamRes = null;
        }

        // 3. 再销毁远程连接
        if (this.remote) {
            try {
                this.remote.removeAllListeners();
                if (!this.remote.destroyed) {
                    this.remote.destroy();
                }
            } catch (e) {}
            this.remote = null;
        }

        // 清空缓冲
        this.pendingBuffers.clear();
        this.bufferedData.clear();
        this.pendingPackets.length = 0;
        this.vlessHeader = null;
        this.responseHeader = null;

        this.initialized = false;
        this.headerSent = false;
        this.downstreamPiped = false;
        this.downstreamStarted = false;
        this.responseFinished = false;

        sessions.delete(this.uuid);

        this.cleaned = true;
        this.cleaning = false;
    }
} 

// 获取ISP信息
const metaInfo = execSync(
    'curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
    { encoding: 'utf-8' }
);
const ISP = metaInfo.trim();
let IP = DOMAIN;
if (!DOMAIN) {
    try {
        IP = execSync('curl -s --max-time 2 ipv4.ip.sb', { encoding: 'utf-8' }).trim();
    } catch (err) {
        try {
            IP = `[${execSync('curl -s --max-time 1 ipv6.ip.sb', { encoding: 'utf-8' }).trim()}]`;
        } catch (ipv6Err) {
            log('error', 'Failed to get IP address:', ipv6Err.message);
            IP = 'localhost'; 
        }
    }
}

// 创建http服务
const server = http.createServer((req, res) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Padding': generatePadding(32, 128),
    };

    // 根路径和订阅路径
    if (req.url === '/') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, 'utf8', (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
                return;
            }
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
        return;
    }
    
    if (req.url === `/${SUB_PATH}`) {
        // IPv6 时 IP 已带 []，SNI/host 对纯 IP 意义有限，生产建议用 DOMAIN
        const sniHost = DOMAIN || IP.replace(/^\[|\]$/g, '');
        const vlessURL = `vless://${UUID}@${IP}:443?encryption=none&security=tls&sni=${sniHost}&fp=chrome&allowInsecure=1&type=xhttp&host=${sniHost}&path=${SETTINGS.XPATH}&mode=packet-up#${NAME}-${ISP}`; 
        const base64Content = Buffer.from(vlessURL).toString('base64');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(base64Content + '\n');
        return;
    }

    const pathMatch = req.url.match(new RegExp(`${XPATH}/([^/]+)(?:/([0-9]+))?$`));
    if (!pathMatch) {
        res.writeHead(404);
        res.end();
        return;
    }
    
    const uuid = pathMatch[1];
    const seq = pathMatch[2] ? parseInt(pathMatch[2]) : null;

    if (req.method === 'GET' && !seq) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Transfer-Encoding'] = 'chunked';

        let session;
        try {
            session = getOrCreateSession(uuid);
        } catch (e) {
            log('error', e.message);
            res.writeHead(503);
            res.end();
            return;
        }

        session.downstreamStarted = true;
        
        if (!session.startDownstream(res, headers)) {
            log('error', `Failed to start downstream for session: ${uuid}`);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            }
            session.cleanup();
        }
        return;
    }
    
    // 处理上行流
    if (req.method === 'POST' && seq !== null) {
        let session;
        try {
            session = getOrCreateSession(uuid);
        } catch (e) {
            log('error', e.message);
            res.writeHead(503);
            res.end();
            return;
        }

        if (!session.downstreamStarted && !session.noDownstreamTimer) {
            session.noDownstreamTimer = setTimeout(() => {
                const currentSession = sessions.get(uuid);
                if (currentSession && !currentSession.downstreamStarted && !currentSession.cleaned) {
                    log('warn', `Session ${uuid} timed out without downstream`);
                    currentSession.cleanup();
                }
            }, SETTINGS.SESSION_TIMEOUT);
        }

        let data = [];
        let size = 0;
        let headersSent = false;
        let aborted = false;
        
        req.on('data', chunk => {
            if (aborted) return;
            size += chunk.length;
            if (size > SETTINGS.MAX_POST_SIZE) {
                aborted = true;
                if (!headersSent) {
                    res.writeHead(413);
                    res.end();
                    headersSent = true;
                }
                // 主动销毁请求，避免继续接收超大体
                try { req.destroy(); } catch (e) {}
                session.cleanup();
                return;
            }
            data.push(chunk);
        });

        req.on('end', async () => {
            if (headersSent || aborted) return;
            
            try {
                const buffer = Buffer.concat(data);
                log('info', `Processing packet: seq=${seq}, size=${buffer.length}`);
                
                await session.processPacket(seq, buffer);
                
                if (!headersSent) {
                    res.writeHead(200, headers);
                    headersSent = true;
                }
                res.end();
                
            } catch (err) {
                log('error', `Failed to process POST request: ${err.message}`);
                session.cleanup();
                
                if (!headersSent) {
                    res.writeHead(500);
                    headersSent = true;
                }
                res.end();
            }
        });

        req.on('error', () => {
            if (!aborted) {
                aborted = true;
                session.cleanup();
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

server.on('secureConnection', (socket) => {
    log('debug', `New secure connection using: ${socket.alpnProtocol || 'http/1.1'}`);
});

function generatePadding(min, max) {
    const length = min + Math.floor(Math.random() * (max - min));
    return Buffer.alloc(length, 0x58).toString('base64');
}

// 放宽 requestTimeout，避免正常慢 POST 被误杀；靠 body 大小限制 + Session 超时防护
server.keepAliveTimeout = 30000;
server.headersTimeout = 60000;
server.requestTimeout = 0;          // 0 = 不限制，由应用层控制
server.timeout = 120000;
server.maxConnections = 100;
  

server.on('error', (err) => {
    log('error', `Server error: ${err.message}`);
});

const delFiles = () => {
    ['nezha-agent', 'config.yaml'].forEach(file => fs.unlink(file, () => {}));
};

server.listen(PORT, () => {
    runnz();
    setTimeout(() => {
      delFiles();
    }, 300000);
    addAccessTask();
    console.log(`Server is running on port ${PORT}`);
});
