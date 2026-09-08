'use strict';

const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const axios = require('axios');
const path = require('path');
const { Buffer } = require('buffer');
const { exec, spawn } = require('child_process');

/* =========================================================
 * 环境变量
 * ======================================================= */

const UUID =
    process.env.UUID ||
    '24b4b1e1-ffff-ffff-ffff-242cf53b5bdb';

const NEZHA_SERVER =
    process.env.NEZHA_SERVER || '';

const NEZHA_PORT =
    process.env.NEZHA_PORT || '';

const NEZHA_KEY =
    process.env.NEZHA_KEY || '';

const AUTO_ACCESS =
    String(process.env.AUTO_ACCESS || 'false').toLowerCase() === 'true';

const XPATH =
    process.env.XPATH || UUID.slice(0, 8);

const SUB_PATH =
    process.env.SUB_PATH || UUID;

const DOMAIN =
    process.env.DOMAIN || '';

const NAME =
    process.env.NAME || '';

/*
 * Koyeb 会提供 PORT。
 * 本地运行时默认 3000。
 */
const PORT =
    Number(process.env.PORT || 3000);


/* =========================================================
 * 核心配置
 * ======================================================= */

const SETTINGS = {
    UUID,

    LOG_LEVEL:
        process.env.LOG_LEVEL || 'none',

    BUFFER_SIZE:
        Number(process.env.BUFFER_SIZE || 65536),

    CHUNK_SIZE:
        Number(process.env.CHUNK_SIZE || 65536),

    SESSION_TIMEOUT:
        Number(process.env.SESSION_TIMEOUT || 45000),

    CONNECT_TIMEOUT:
        Number(process.env.CONNECT_TIMEOUT || 8000),

    TCP_NODELAY:
        true,

    TCP_KEEPALIVE:
        true,

    TCP_KEEPALIVE_DELAY:
        10000,

    MAX_SESSIONS:
        Number(process.env.MAX_SESSIONS || 50),

    MAX_HEADER_SIZE:
        Number(process.env.MAX_HEADER_SIZE || 65536),

    MAX_POST_SIZE:
        Number(process.env.MAX_POST_SIZE || 0),
};


/* =========================================================
 * 日志
 * ======================================================= */

function log(type, ...args) {
    if (SETTINGS.LOG_LEVEL === 'none') {
        return;
    }

    const levels = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3
    };

    const colors = {
        debug: '\x1b[36m',
        info: '\x1b[32m',
        warn: '\x1b[33m',
        error: '\x1b[31m',
        reset: '\x1b[0m'
    };

    const configLevel =
        levels[SETTINGS.LOG_LEVEL] ?? 1;

    const messageLevel =
        levels[type] ?? 0;

    if (messageLevel < configLevel) {
        return;
    }

    const time =
        new Date().toISOString();

    const color =
        colors[type] || colors.reset;

    console.log(
        `${color}[${time}] [${type}]`,
        ...args,
        colors.reset
    );
}


/* =========================================================
 * UUID
 * ======================================================= */

function parseUUID(uuid) {
    const clean =
        String(uuid)
            .replace(/-/g, '')
            .toLowerCase();

    if (!/^[0-9a-f]{32}$/.test(clean)) {
        throw new Error('invalid UUID format');
    }

    const result = new Uint8Array(16);

    for (let i = 0; i < 16; i++) {
        result[i] =
            parseInt(
                clean.slice(i * 2, i * 2 + 2),
                16
            );
    }

    return result;
}


function validateUUID(left, right) {
    if (!left || !right || left.length !== 16 || right.length !== 16) {
        return false;
    }

    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) {
            return false;
        }
    }

    return true;
}


const CONFIG_UUID_BYTES = parseUUID(UUID);


/* =========================================================
 * Padding
 * ======================================================= */

function generatePadding(min, max) {
    const length =
        min +
        Math.floor(
            Math.random() * (max - min + 1)
        );

    return Buffer
        .alloc(length, 0x58)
        .toString('base64');
}


/* =========================================================
 * HTTP Headers
 *
 * 注意：
 * 不手工设置 Content-Length。
 *
 * HTTP/1.1 下 Node 会自动使用 chunked。
 * 如果未来直接改成 HTTP/2，Transfer-Encoding
 * 不能使用，所以这里干脆不显式设置。
 * ======================================================= */

function createStreamHeaders() {
    return {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'X-Accel-Buffering': 'no',
        'X-Padding': generatePadding(32, 128)
    };
}


function createSubscriptionHeaders() {
    return {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Headers': '*'
    };
}


/* =========================================================
 * VLESS Header Parser
 *
 * stream-one 的关键：
 *
 * POST body 不再按 seq 分包。
 *
 * Node req 本身就是一个连续的 Readable。
 *
 * 我们只需要：
 *
 *   1. 从 req 中逐渐读取 VLESS header
 *   2. header 完整后连接 remote
 *   3. header 后面的数据立即写入 remote
 *   4. 后续 chunk 全部直接 pipe 到 remote
 *
 * 不需要：
 *
 *   seq
 *   nextSeq
 *   pendingBuffers
 *   reorder
 *   sequence timeout
 * ======================================================= */

class VLESSParser {
    constructor(uuidBytes) {
        this.uuidBytes = uuidBytes;
        this.buffer = Buffer.alloc(0);
        this.headerParsed = false;
        this.header = null;
    }

    append(chunk) {
        if (!chunk || chunk.length === 0) {
            return;
        }

        this.buffer =
            this.buffer.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([
                    this.buffer,
                    chunk
                ]);

        if (this.buffer.length > SETTINGS.MAX_HEADER_SIZE) {
            throw new Error('VLESS header too large');
        }
    }

    parse() {
        if (this.headerParsed) {
            return this.header;
        }

        const buf = this.buffer;

        /*
         * 最小：
         *
         * version      1
         * UUID        16
         * addons len   1
         * command      1
         * port         2
         * address type 1
         *
         * = 22 bytes
         */

        if (buf.length < 22) {
            return null;
        }

        const version =
            buf[0];

        const uuid =
            buf.subarray(1, 17);

        if (!validateUUID(uuid, this.uuidBytes)) {
            throw new Error('invalid UUID');
        }

        const addonLength =
            buf[17];

        const commandOffset =
            18 + addonLength;

        if (buf.length < commandOffset + 1) {
            return null;
        }

        const command =
            buf[commandOffset];

        /*
         * VLESS TCP
         */
        if (command !== 1) {
            throw new Error(
                `unsupported VLESS command: ${command}`
            );
        }

        const portOffset =
            commandOffset + 1;

        if (buf.length < portOffset + 3) {
            return null;
        }

        const port =
            buf.readUInt16BE(portOffset);

        const addressType =
            buf[portOffset + 2];

        const addressOffset =
            portOffset + 3;

        let hostname = '';
        let headerLength = 0;

        /*
         * IPv4
         */
        if (addressType === 1) {
            if (buf.length < addressOffset + 4) {
                return null;
            }

            hostname = Array
                .from(
                    buf.subarray(
                        addressOffset,
                        addressOffset + 4
                    )
                )
                .join('.');

            headerLength =
                addressOffset + 4;
        }

        /*
         * Domain
         */
        else if (addressType === 2) {
            if (buf.length < addressOffset + 1) {
                return null;
            }

            const domainLength =
                buf[addressOffset];

            if (domainLength <= 0) {
                throw new Error(
                    'invalid domain length'
                );
            }

            if (
                buf.length <
                addressOffset +
                1 +
                domainLength
            ) {
                return null;
            }

            hostname =
                buf
                    .subarray(
                        addressOffset + 1,
                        addressOffset + 1 + domainLength
                    )
                    .toString('utf8');

            headerLength =
                addressOffset +
                1 +
                domainLength;
        }

        /*
         * IPv6
         */
        else if (addressType === 3) {
            if (buf.length < addressOffset + 16) {
                return null;
            }

            const parts = [];

            for (let i = 0; i < 16; i += 2) {
                parts.push(
                    buf
                        .readUInt16BE(
                            addressOffset + i
                        )
                        .toString(16)
                );
            }

            hostname =
                parts.join(':');

            headerLength =
                addressOffset + 16;
        }

        else {
            throw new Error(
                `unsupported address type: ${addressType}`
            );
        }

        if (!hostname) {
            throw new Error(
                'empty VLESS hostname'
            );
        }

        const remaining =
            buf.subarray(headerLength);

        this.header = {
            version,
            hostname,
            port,
            data: Buffer.from(remaining),
            resp: Buffer.from([
                version,
                0
            ])
        };

        /*
         * 清掉 header。
         *
         * 后续数据不再经过 parser。
         */
        this.buffer = Buffer.alloc(0);
        this.headerParsed = true;

        return this.header;
    }
}


/* =========================================================
 * TCP Connect
 * ======================================================= */

function timedConnect(hostname, port, timeout) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const socket =
            net.createConnection({
                host: hostname,
                port
            });

        const timer =
            setTimeout(() => {
                if (settled) {
                    return;
                }

                settled = true;

                try {
                    socket.destroy();
                } catch (_) {}

                reject(
                    new Error(
                        `connect timeout: ${hostname}:${port}`
                    )
                );
            }, timeout);

        socket.once('connect', () => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);

            try {
                socket.setNoDelay(
                    SETTINGS.TCP_NODELAY
                );

                socket.setKeepAlive(
                    SETTINGS.TCP_KEEPALIVE,
                    SETTINGS.TCP_KEEPALIVE_DELAY
                );

                if (socket._readableState) {
                    socket._readableState.highWaterMark =
                        SETTINGS.BUFFER_SIZE;
                }

                if (socket._writableState) {
                    socket._writableState.highWaterMark =
                        SETTINGS.BUFFER_SIZE;
                }
            } catch (err) {
                log(
                    'warn',
                    `TCP socket tuning failed: ${err.message}`
                );
            }

            resolve(socket);
        });

        socket.once('error', err => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);

            reject(err);
        });
    });
}


/* =========================================================
 * Session Manager
 * ======================================================= */

const sessions =
    new Map();


function getOrCreateSession(uuid) {
    let session =
        sessions.get(uuid);

    if (session && !session.cleaned) {
        return session;
    }

    if (sessions.size >= SETTINGS.MAX_SESSIONS) {
        /*
         * 优先清理：
         *
         * 1. 没有 GET
         * 2. 没有 remote
         * 3. 最久没有活动
         */

        let victim = null;
        let victimScore = -Infinity;

        for (const [id, current] of sessions) {
            if (
                current.cleaned ||
                current.cleaning
            ) {
                continue;
            }

            let score = 0;

            if (!current.downstreamStarted) {
                score += 1000;
            }

            if (!current.initialized) {
                score += 500;
            }

            if (!current.remote) {
                score += 500;
            }

            const idle =
                Date.now() -
                current.lastActivity;

            score +=
                Math.min(idle / 1000, 300);

            if (score > victimScore) {
                victimScore = score;
                victim = id;
            }
        }

        if (victim) {
            const old =
                sessions.get(victim);

            if (old) {
                log(
                    'warn',
                    `Evicting session ${victim}`
                );

                old.cleanup(
                    'max_sessions'
                );
            }
        }

        if (sessions.size >= SETTINGS.MAX_SESSIONS) {
            throw new Error(
                'too many sessions'
            );
        }
    }

    session =
        new Session(uuid);

    sessions.set(
        uuid,
        session
    );

    log(
        'info',
        `Created session ${uuid}`
    );

    return session;
}


/* =========================================================
 * Session
 * ======================================================= */

class Session {
    constructor(uuid) {
        this.uuid = uuid;

        this.remote = null;

        this.initialized = false;
        this.initializing = false;

        this.vlessHeader = null;
        this.vlessParser =
            new VLESSParser(
                CONFIG_UUID_BYTES
            );

        this.downstreamRes = null;
        this.downstreamStarted = false;
        this.downstreamFinished = false;

        this.upstreamReq = null;
        this.upstreamStarted = false;
        this.upstreamEnded = false;

        this.responseHeaderSent = false;

        this.lastActivity =
            Date.now();

        this.cleaned = false;
        this.cleaning = false;

        this.noDownstreamTimer = null;

        this.remoteEnded = false;
        this.remoteErrored = false;

        this.remoteDataHandler = null;
        this.remoteEndHandler = null;
        this.remoteErrorHandler = null;

        this.parserFinished = false;
    }


    touch() {
        this.lastActivity =
            Date.now();
    }


    clearNoDownstreamTimer() {
        if (this.noDownstreamTimer) {
            clearTimeout(
                this.noDownstreamTimer
            );

            this.noDownstreamTimer = null;
        }
    }


    armNoDownstreamTimer() {
        if (
            this.downstreamStarted ||
            this.noDownstreamTimer
        ) {
            return;
        }

        this.noDownstreamTimer =
            setTimeout(() => {
                if (
                    !this.cleaned &&
                    !this.downstreamStarted
                ) {
                    log(
                        'warn',
                        `Session ${this.uuid} has no downstream`
                    );

                    this.cleanup(
                        'downstream_timeout'
                    );
                }
            }, SETTINGS.SESSION_TIMEOUT);
    }


    attachDownstream(res) {
        if (this.cleaned) {
            return false;
        }

        /*
         * 防止一个 session 被两个 GET
         * 同时占用。
         */
        if (
            this.downstreamRes &&
            this.downstreamRes !== res &&
            !this.downstreamFinished
        ) {
            log(
                'warn',
                `Duplicate downstream for ${this.uuid}`
            );

            return false;
        }

        this.clearNoDownstreamTimer();

        this.downstreamRes =
            res;

        this.downstreamStarted =
            true;

        this.touch();

        /*
         * 不设置 Content-Length。
         *
         * HTTP/1.1 下 Node 会自动处理 chunked。
         */
        if (!res.headersSent) {
            res.writeHead(
                200,
                createStreamHeaders()
            );
        }

        /*
         * 立即 flush header。
         *
         * 这可以让代理尽早确认 response 已经开始。
         */
        if (
            typeof res.flushHeaders === 'function'
        ) {
            try {
                res.flushHeaders();
            } catch (_) {}
        }

        res.on('close', () => {
            /*
             * close + writableFinished=false
             * 才认为是异常关闭。
             */
            if (
                !res.writableFinished &&
                !this.downstreamFinished
            ) {
                log(
                    'info',
                    `Downstream closed: ${this.uuid}`
                );

                this.cleanup(
                    'downstream_aborted'
                );
            }
        });

        res.on('error', err => {
            log(
                'warn',
                `Downstream error: ${err.message}`
            );

            this.cleanup(
                'downstream_error'
            );
        });

        res.on('finish', () => {
            this.downstreamFinished =
                true;

            this.touch();

            /*
             * response 正常完成。
             *
             * 如果 remote 也结束了，
             * session 可以清理。
             */
            if (
                this.remoteEnded ||
                this.upstreamEnded
            ) {
                this.cleanup(
                    'downstream_finished'
                );
            }
        });

        if (
            this.initialized &&
            this.remote
        ) {
            this.startRemoteToDownstream();
        }

        return true;
    }


    async initializeFromParser() {
        if (this.initialized) {
            return true;
        }

        if (this.initializing) {
            return false;
        }

        this.initializing =
            true;

        try {
            const header =
                this.vlessParser.parse();

            if (!header) {
                this.initializing = false;
                return false;
            }

            this.vlessHeader =
                header;

            log(
                'info',
                `VLESS target ${header.hostname}:${header.port}`
            );

            this.remote =
                await timedConnect(
                    header.hostname,
                    header.port,
                    SETTINGS.CONNECT_TIMEOUT
                );

            log(
                'info',
                `Remote connected ${header.hostname}:${header.port}`
            );

            this.initialized =
                true;

            this.touch();

            this.attachRemoteEvents();

            /*
             * VLESS response header。
             */
            if (
                this.downstreamRes &&
                !this.responseHeaderSent &&
                !this.downstreamRes.destroyed
            ) {
                try {
                    this.downstreamRes.write(
                        header.resp
                    );

                    this.responseHeaderSent =
                        true;
                } catch (err) {
                    log(
                        'warn',
                        `Failed to write VLESS response header: ${err.message}`
                    );

                    this.cleanup(
                        'response_header_error'
                    );

                    return false;
                }
            }

            /*
             * Header 后面的第一段数据。
             */
            if (
                header.data &&
                header.data.length > 0
            ) {
                await this.writeRemote(
                    header.data
                );
            }

            if (this.downstreamRes) {
                this.startRemoteToDownstream();
            }

            return true;
        } catch (err) {
            log(
                'error',
                `VLESS initialization failed: ${err.message}`
            );

            this.cleanup(
                'vless_init_failed'
            );

            return false;
        } finally {
            this.initializing =
                false;
        }
    }


    async feedUpstream(chunk) {
        if (this.cleaned) {
            return;
        }

        if (
            !chunk ||
            chunk.length === 0
        ) {
            return;
        }

        this.touch();

        /*
         * Header 尚未解析。
         */
        if (!this.initialized) {
            this.vlessParser.append(
                chunk
            );

            const header =
                this.vlessParser.parse();

            if (!header) {
                return;
            }

            /*
             * parser 已经把 header 后
             * 的剩余数据放进 header.data。
             *
             * initialize 会连接 remote
             * 并发送第一段数据。
             */
            await this.initializeFromParser();

            return;
        }

        /*
         * Header 已完成。
         *
         * 后面的 chunk 直接写 remote。
         */
        await this.writeRemote(
            chunk
        );
    }


    async writeRemote(data) {
        if (
            this.cleaned ||
            !this.remote ||
            this.remote.destroyed
        ) {
            throw new Error(
                'remote connection unavailable'
            );
        }

        if (
            !data ||
            data.length === 0
        ) {
            return;
        }

        await new Promise(
            (resolve, reject) => {
                const socket =
                    this.remote;

                socket.write(
                    data,
                    err => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        this.touch();
                        resolve();
                    }
                );
            }
        );
    }


    endUpstream() {
        if (
            this.upstreamEnded ||
            this.cleaned
        ) {
            return;
        }

        this.upstreamEnded =
            true;

        this.touch();

        /*
         * POST 正常结束 ≠ session 结束。
         *
         * VLESS/TCP 的下游仍然可能有数据。
         *
         * 所以这里只 half-close remote，
         * 不 destroy。
         */
        if (
            this.remote &&
            !this.remote.destroyed
        ) {
            try {
                this.remote.end();
            } catch (err) {
                log(
                    'warn',
                    `Remote half-close failed: ${err.message}`
                );
            }
        }

        /*
         * 如果 remote 本身已经结束，
         * 这时 session 才可以释放。
         */
        if (this.remoteEnded) {
            this.cleanup(
                'upstream_and_remote_finished'
            );
        }
    }


    attachRemoteEvents() {
        if (
            !this.remote ||
            this.cleaned
        ) {
            return;
        }

        const remote =
            this.remote;

        this.remoteDataHandler =
            () => {
                this.touch();
            };

        this.remoteEndHandler =
            () => {
                if (this.cleaned) {
                    return;
                }

                this.remoteEnded =
                    true;

                this.touch();

                log(
                    'info',
                    `Remote ended: ${this.uuid}`
                );

                if (
                    this.downstreamRes &&
                    !this.downstreamRes.writableEnded &&
                    !this.downstreamRes.destroyed
                ) {
                    try {
                        this.downstreamRes.end();
                    } catch (_) {}
                }

                /*
                 * remote 已结束，
                 * 不再需要 session。
                 */
                this.cleanup(
                    'remote_end'
                );
            };

        this.remoteErrorHandler =
            err => {
                if (this.cleaned) {
                    return;
                }

                this.remoteErrored =
                    true;

                log(
                    'warn',
                    `Remote error: ${err.message}`
                );

                /*
                 * remote error 后继续保持
                 * 一个死 session 没有意义。
                 */
                this.cleanup(
                    'remote_error'
                );
            };

        remote.on(
            'data',
            this.remoteDataHandler
        );

        remote.once(
            'end',
            this.remoteEndHandler
        );

        remote.once(
            'error',
            this.remoteErrorHandler
        );

        remote.once(
            'close',
            hadError => {
                if (
                    this.cleaned
                ) {
                    return;
                }

                if (hadError) {
                    this.cleanup(
                        'remote_close_error'
                    );
                }
            }
        );
    }


    startRemoteToDownstream() {
        if (
            this.cleaned ||
            !this.remote ||
            !this.downstreamRes
        ) {
            return;
        }

        const res =
            this.downstreamRes;

        const remote =
            this.remote;

        if (
            res.destroyed ||
            res.writableEnded ||
            remote.destroyed
        ) {
            return;
        }

        /*
         * response header。
         *
         * 如果 initialize 已经写过，
         * 这里不会重复写。
         */
        if (
            !this.responseHeaderSent &&
            this.vlessHeader
        ) {
            try {
                res.write(
                    this.vlessHeader.resp
                );

                this.responseHeaderSent =
                    true;
            } catch (err) {
                this.cleanup(
                    'response_header_write_failed'
                );

                return;
            }
        }

        /*
         * 不再使用 remote.pipe(res)。
         *
         * 原因：
         *
         * session cleanup 时需要非常明确
         * 地控制双方生命周期。
         *
         * 手工 data -> res 更容易处理
         * Koyeb / Node 的半关闭。
         */
        const onData =
            chunk => {
                if (
                    this.cleaned ||
                    res.destroyed ||
                    res.writableEnded
                ) {
                    return;
                }

                this.touch();

                try {
                    const ok =
                        res.write(chunk);

                    /*
                     * backpressure：
                     * remote 暂停读取。
                     */
                    if (!ok) {
                        remote.pause();

                        res.once(
                            'drain',
                            () => {
                                if (
                                    !this.cleaned &&
                                    !remote.destroyed
                                ) {
                                    remote.resume();
                                }
                            }
                        );
                    }
                } catch (err) {
                    log(
                        'warn',
                        `Downstream write failed: ${err.message}`
                    );

                    this.cleanup(
                        'downstream_write_failed'
                    );
                }
            };

        /*
         * attachRemoteEvents 已经有一个 data
         * listener 用于 touch。
         *
         * 这里增加真正的数据输出 listener。
         */
        remote.on(
            'data',
            onData
        );

        /*
         * cleanup 时需要删除。
         */
        this.remoteStreamDataHandler =
            onData;
    }


    cleanup(reason = 'unknown') {
        if (
            this.cleaned ||
            this.cleaning
        ) {
            return;
        }

        this.cleaning =
            true;

        log(
            'debug',
            `Cleaning session ${this.uuid}: ${reason}`
        );

        this.clearNoDownstreamTimer();

        /*
         * 从全局 sessions 删除。
         */
        if (
            sessions.get(this.uuid) === this
        ) {
            sessions.delete(
                this.uuid
            );
        }

        /*
         * 先停止 remote data -> response。
         */
        if (
            this.remote &&
            this.remoteStreamDataHandler
        ) {
            try {
                this.remote.removeListener(
                    'data',
                    this.remoteStreamDataHandler
                );
            } catch (_) {}
        }

        /*
         * 删除本 Session 添加的 remote listeners。
         */
        if (this.remote) {
            try {
                if (this.remoteDataHandler) {
                    this.remote.removeListener(
                        'data',
                        this.remoteDataHandler
                    );
                }

                if (this.remoteEndHandler) {
                    this.remote.removeListener(
                        'end',
                        this.remoteEndHandler
                    );
                }

                if (this.remoteErrorHandler) {
                    this.remote.removeListener(
                        'error',
                        this.remoteErrorHandler
                    );
                }
            } catch (_) {}
        }

        /*
         * response。
         *
         * 正常 cleanup 时 end。
         *
         * 不 destroy response，
         * 避免 Node/Koyeb 把正常结束
         * 变成异常 reset。
         */
        if (this.downstreamRes) {
            try {
                if (
                    !this.downstreamRes.writableEnded &&
                    !this.downstreamRes.destroyed
                ) {
                    this.downstreamRes.end();
                }
            } catch (_) {}

            this.downstreamRes =
                null;
        }

        /*
         * remote。
         */
        if (this.remote) {
            try {
                if (
                    !this.remote.destroyed
                ) {
                    this.remote.destroy();
                }
            } catch (_) {}

            this.remote =
                null;
        }

        /*
         * upstream request。
         *
         * 注意：
         *
         * 正常 end 的 req 不应该 destroy。
         *
         * cleanup 通常只在异常路径触发。
         */
        if (
            this.upstreamReq &&
            !this.upstreamEnded
        ) {
            try {
                if (
                    !this.upstreamReq.destroyed
                ) {
                    this.upstreamReq.destroy();
                }
            } catch (_) {}
        }

        this.cleaned =
            true;

        this.cleaning =
            false;
    }
}


/* =========================================================
 * Session 定时清理
 * ======================================================= */

const sessionTimer =
    setInterval(() => {
        const now =
            Date.now();

        for (
            const [uuid, session]
            of sessions
        ) {
            if (
                session.cleaned
            ) {
                sessions.delete(
                    uuid
                );

                continue;
            }

            const idle =
                now -
                session.lastActivity;

            if (
                idle >
                SETTINGS.SESSION_TIMEOUT
            ) {
                log(
                    'warn',
                    `Session idle timeout: ${uuid}`
                );

                session.cleanup(
                    'idle_timeout'
                );
            }
        }
    }, 15000);


/*
 * Node 进程退出时清掉 interval。
 */
sessionTimer.unref?.();


/* =========================================================
 * Nezha
 * ======================================================= */

function getNezhaDownloadUrl() {
    const arch =
        os.arch();

    const arm =
        arch === 'arm' ||
        arch === 'arm64' ||
        arch === 'aarch64';

    if (arm) {
        return NEZHA_PORT
            ? 'https://arm64.ssss.nyc.mn/agent'
            : 'https://arm64.ssss.nyc.mn/v1';
    }

    return NEZHA_PORT
        ? 'https://amd64.ssss.nyc.mn/agent'
        : 'https://amd64.ssss.nyc.mn/v1';
}


async function downloadNezha() {
    if (!NEZHA_KEY) {
        return;
    }

    const url =
        getNezhaDownloadUrl();

    const file =
        path.join(
            __dirname,
            'nezha-agent'
        );

    log(
        'info',
        `Downloading Nezha: ${url}`
    );

    const response =
        await axios({
            method: 'GET',
            url,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5
        });

    await new Promise(
        (resolve, reject) => {
            const writer =
                fs.createWriteStream(
                    file
                );

            response.data.pipe(
                writer
            );

            writer.once(
                'finish',
                resolve
            );

            writer.once(
                'error',
                reject
            );

            response.data.once(
                'error',
                reject
            );
        }
    );

    await new Promise(
        (resolve, reject) => {
            fs.chmod(
                file,
                0o755,
                err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                }
            );
        }
    );

    log(
        'info',
        'Nezha agent downloaded'
    );
}


function detectNezhaPort(server) {
    if (!server) {
        return '';
    }

    /*
     * [IPv6]:port
     */
    if (
        server.startsWith('[')
    ) {
        const match =
            server.match(
                /\]:(\d+)$/
            );

        return match
            ? match[1]
            : '';
    }

    /*
     * 普通 host:port。
     */
    const match =
        server.match(
            /:(\d+)$/
        );

    if (match) {
        return match[1];
    }

    return '';
}


function writeNezhaConfig() {
    const port =
        detectNezhaPort(
            NEZHA_SERVER
        );

    const tlsPorts =
        new Set([
            '443',
            '8443',
            '2096',
            '2087',
            '2083',
            '2053'
        ]);

    const tls =
        tlsPorts.has(port)
            ? 'true'
            : 'false';

    const config = `
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
tls: ${tls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}
`.trim() + '\n';

    const configPath =
        path.join(
            __dirname,
            'config.yaml'
        );

    fs.writeFileSync(
        configPath,
        config,
        'utf8'
    );

    return configPath;
}


async function runNezha() {
    if (
        !NEZHA_SERVER ||
        !NEZHA_KEY
    ) {
        log(
            'debug',
            'Nezha disabled'
        );

        return;
    }

    try {
        await downloadNezha();

        const binary =
            path.join(
                __dirname,
                'nezha-agent'
            );

        /*
         * v1：
         * NEZHA_PORT 存在时直接使用 -s host:port -p key
         */
        if (
            NEZHA_PORT
        ) {
            const address =
                `${NEZHA_SERVER}:${NEZHA_PORT}`;

            const tlsPorts =
                new Set([
                    '443',
                    '8443',
                    '2096',
                    '2087',
                    '2083',
                    '2053'
                ]);

            const args = [
                '-s',
                address,
                '-p',
                NEZHA_KEY
            ];

            if (
                tlsPorts.has(
                    String(NEZHA_PORT)
                )
            ) {
                args.push(
                    '--tls'
                );
            }

            const child =
                spawn(
                    binary,
                    args,
                    {
                        detached: true,
                        stdio: 'ignore'
                    }
                );

            child.unref();

            log(
                'info',
                'Nezha agent started'
            );

            return;
        }

        /*
         * v0 / config.yaml
         */
        const configPath =
            writeNezhaConfig();

        const child =
            spawn(
                binary,
                ['-c', configPath],
                {
                    detached: true,
                    stdio: 'ignore'
                }
            );

        child.unref();

        log(
            'info',
            'Nezha agent started with config.yaml'
        );
    } catch (err) {
        log(
            'error',
            `Nezha failed: ${err.message}`
        );
    }
}


/* =========================================================
 * AUTO_ACCESS
 * ======================================================= */

async function addAccessTask() {
    if (
        !AUTO_ACCESS ||
        !DOMAIN
    ) {
        return;
    }

    try {
        const target =
            `https://${DOMAIN}`;

        /*
         * 不使用 shell 拼接 curl。
         *
         * 防止 DOMAIN 中的字符
         * 被 shell 解释。
         */
        const response =
            await axios.post(
                'https://oooo.serv00.net/add-url',
                {
                    url: target
                },
                {
                    timeout: 15000,
                    headers: {
                        'Content-Type':
                            'application/json'
                    }
                }
            );

        log(
            'info',
            'Automatic Access Task added',
            response.data
        );
    } catch (err) {
        log(
            'warn',
            `Automatic Access Task failed: ${err.message}`
        );
    }
}


/* =========================================================
 * IP / ISP
 * ======================================================= */

async function getIP() {
    try {
        const response = await axios.get(
            'https://api4.ipify.org',
            {
                timeout: 3000,
                responseType: 'text'
            }
        );

        const ip = response.data.trim();

        if (ip) {
            return ip;
        }
    } catch (err) {
        log(
            'warn',
            `IPv4 detection failed: ${err.message}`
        );
    }

    try {
        const response = await axios.get(
            'https://api6.ipify.org',
            {
                timeout: 3000,
                responseType: 'text'
            }
        );

        const ip = response.data.trim();

        if (ip) {
            return `[${ip}]`;
        }
    } catch (err) {
        log(
            'warn',
            `IPv6 detection failed: ${err.message}`
        );
    }

    return 'localhost';
}


async function getISP() {
    try {
        const response =
            await axios.get(
                'https://speed.cloudflare.com/meta',
                {
                    timeout: 5000,
                    responseType: 'json'
                }
            );

        const data =
            response.data || {};

        /*
         * Cloudflare meta 常见字段：
         *
         * asOrganization
         * colo
         *
         * 优先组织名称。
         */
        const isp =
            data.asOrganization ||
            data.asn ||
            data.colo ||
            'Unknown';

        return String(isp)
            .replace(/\s+/g, '_')
            .trim();
    } catch (err) {
        log(
            'warn',
            `ISP detection failed: ${err.message}`
        );

        return 'Unknown';
    }
}


/* =========================================================
 * Subscription
 * ======================================================= */

function buildVLESSURL(IP, ISP) {
    const sniHost =
        DOMAIN ||
        String(IP)
            .replace(/^\[|\]$/g, '');

    /*
     * XHTTP stream-one。
     *
     * 注意：
     * 这里不再使用 packet-up。
     */
    const url =
        `vless://${UUID}@${IP}:443` +
        `?encryption=none` +
        `&security=tls` +
        `&sni=${encodeURIComponent(sniHost)}` +
        `&fp=chrome` +
        `&allowInsecure=1` +
        `&type=xhttp` +
        `&host=${encodeURIComponent(sniHost)}` +
        `&path=${encodeURIComponent('/' + XPATH)}` +
        `&mode=stream-one` +
        `#${encodeURIComponent(NAME || 'XHTTP')}-${encodeURIComponent(ISP)}`;

    return url;
}


/* =========================================================
 * HTTP Server
 * ======================================================= */

let PUBLIC_IP =
    DOMAIN || 'localhost';

let ISP =
    'Unknown';


function send404(res) {
    if (res.headersSent) {
        try {
            res.end();
        } catch (_) {}

        return;
    }

    res.writeHead(
        404,
        {
            'Content-Type':
                'text/plain; charset=utf-8',
            'Cache-Control':
                'no-store'
        }
    );

    res.end('Not Found');
}


function send500(res) {
    if (res.headersSent) {
        try {
            res.end();
        } catch (_) {}

        return;
    }

    res.writeHead(
        500,
        {
            'Content-Type':
                'text/plain; charset=utf-8',
            'Cache-Control':
                'no-store'
        }
    );

    res.end(
        'Internal Server Error'
    );
}


const server =
    http.createServer(
        async (req, res) => {
            /*
             * -------------------------------------------------
             * 基础安全/生命周期处理
             * -------------------------------------------------
             */

            res.setHeader(
                'Access-Control-Allow-Origin',
                '*'
            );

            if (
                req.method === 'OPTIONS'
            ) {
                res.writeHead(
                    204,
                    {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                        'Access-Control-Allow-Headers': '*',
                        'Cache-Control': 'no-store'
                    }
                );

                res.end();
                return;
            }


            /*
             * -------------------------------------------------
             * Root
             * -------------------------------------------------
             */

            if (
                req.method === 'GET' &&
                req.url === '/'
            ) {
                const filePath =
                    path.join(
                        __dirname,
                        'index.html'
                    );

                fs.readFile(
                    filePath,
                    'utf8',
                    (err, content) => {
                        if (err) {
                            if (!res.headersSent) {
                                res.writeHead(
                                    500,
                                    {
                                        'Content-Type':
                                            'text/plain; charset=utf-8'
                                    }
                                );
                            }

                            res.end(
                                'Internal Server Error'
                            );

                            return;
                        }

                        res.writeHead(
                            200,
                            {
                                'Content-Type':
                                    'text/html; charset=utf-8',
                                'Cache-Control':
                                    'no-store'
                            }
                        );

                        res.end(
                            content
                        );
                    }
                );

                return;
            }


            /*
             * -------------------------------------------------
             * Subscription
             * -------------------------------------------------
             */

            if (
                req.method === 'GET' &&
                req.url === `/${SUB_PATH}`
            ) {
                const vlessURL =
                    buildVLESSURL(
                        PUBLIC_IP,
                        ISP
                    );

                const base64 =
                    Buffer
                        .from(vlessURL)
                        .toString('base64');

                res.writeHead(
                    200,
                    createSubscriptionHeaders()
                );

                res.end(
                    base64 + '\n'
                );

                return;
            }


            /*
             * -------------------------------------------------
             * XHTTP path
             *
             * packet-up:
             *
             *   /xhttp/uuid/0
             *   /xhttp/uuid/1
             *
             * stream-one:
             *
             *   /xhttp/uuid
             * -------------------------------------------------
             */

            const expectedPrefix =
                `/${XPATH}/`;

            if (
                !req.url.startsWith(
                    expectedPrefix
                )
            ) {
                send404(res);
                return;
            }

            /*
             * query string 不参与 UUID。
             */
            const urlWithoutQuery =
                req.url.split('?')[0];

            const relative =
                urlWithoutQuery.slice(
                    expectedPrefix.length
                );

            /*
             * stream-one 不接受 seq。
             *
             * UUID 必须是完整的一段。
             */
            if (
                !relative ||
                relative.includes('/')
            ) {
                send404(res);
                return;
            }

            const uuid =
                decodeURIComponent(
                    relative
                );


            /*
             * UUID 不直接相信 URL。
             *
             * XHTTP 路径 UUID 应该和配置 UUID 一致。
             */
            if (
                uuid !== UUID
            ) {
                send404(res);
                return;
            }


            /*
             * -------------------------------------------------
             * DOWNSTREAM GET
             * -------------------------------------------------
             */

            if (
                req.method === 'GET'
            ) {
                let session;

                try {
                    session =
                        getOrCreateSession(
                            uuid
                        );
                } catch (err) {
                    log(
                        'error',
                        err.message
                    );

                    if (!res.headersSent) {
                        res.writeHead(
                            503,
                            {
                                'Content-Type':
                                    'text/plain'
                            }
                        );
                    }

                    res.end(
                        'Service Unavailable'
                    );

                    return;
                }

                /*
                 * req close。
                 *
                 * GET 本身如果客户端取消，
                 * res 通常也会 close。
                 */
                req.on(
                    'aborted',
                    () => {
                        if (
                            !res.writableFinished
                        ) {
                            session.cleanup(
                                'downstream_request_aborted'
                            );
                        }
                    }
                );

                req.on(
                    'error',
                    err => {
                        log(
                            'debug',
                            `GET request error: ${err.message}`
                        );

                        session.cleanup(
                            'downstream_request_error'
                        );
                    }
                );

                const attached =
                    session.attachDownstream(
                        res
                    );

                if (!attached) {
                    if (!res.headersSent) {
                        res.writeHead(
                            409,
                            {
                                'Content-Type':
                                    'text/plain'
                            }
                        );
                    }

                    res.end(
                        'Session already has downstream'
                    );

                    return;
                }

                return;
            }


            /*
             * -------------------------------------------------
             * UPSTREAM POST
             *
             * 真正的 stream-one：
             *
             * 一个 POST 请求持续承载：
             *
             * VLESS Header
             * +
             * TCP data
             * +
             * TCP data
             * +
             * TCP data
             *
             * 不再收集整个 body。
             * -------------------------------------------------
             */

            if (
                req.method === 'POST'
            ) {
                let session;

                try {
                    session =
                        getOravailable'
                    );

                    return;
                }

                /*
                 * 一个 Session 对应一个 upstream。
                 *
                 * stream-one 不应该再产生第二个 POST。
                 */
                if (
                    session.upstreamStarted &&
                    session.upstreamReq &&
                    !session.upstreamEnded
                ) {
                    if (!res.headersSent) {
                        res.writeHead(
                            409,
                            {
                                'Content-Type':
                                    'text/plain',
                                'Cache-Control':
                                    'no-store'
                            }
                        );
                    }

                    res.end(
                        'Session already has upstream'
                    );

                    return;
                }

                session.upstreamStarted =
                    true;

                session.upstreamReq =
                    req;

                session.armNoDownstreamTimer();

                let responseEnded =
                    false;

                let requestAborted =
                    false;

                /*
                 * -------------------------------------------------
                 * req data
                 * -------------------------------------------------
                 */

                req.on(
                    'data',
                    async chunk => {
                        if (
                            requestAborted ||
                            session.cleaned
                        ) {
                            return;
                        }

                        try {
                            /*
                             * 暂停 request，
                             * 等 remote.write 完成。
                             *
                             * 避免 Koyeb -> Node
                             * 的高速 body 把内存打爆。
                             */
                            req.pause();

                            await session.feedUpstream(
                                chunk
                            );

                            if (
                                !requestAborted &&
                                !session.cleaned
                            ) {
                                req.resume();
                            }
                        } catch (err) {
                            log(
                                'error',
                                `Upstream processing failed: ${err.message}`
                            );

                            requestAborted =
                                true;

                            session.cleanup(
                                'upstream_processing_error'
                            );

                            if (
                                !responseEnded &&
                                !res.headersSent
                            ) {
                                res.writeHead(
                                    500,
                                    {
                                        'Content-Type':
                                            'text/plain',
                                        'Cache-Control':
                                            'no-store'
                                    }
                                );

                                responseEnded =
                                    true;

                                res.end(
                                    'Upstream Error'
                                );
                            }
                        }
                    }
                );


                /*
                 * -------------------------------------------------
                 * POST end
                 * -------------------------------------------------
                 */

                req.on(
                    'end',
                    () => {
                        if (
                            requestAborted ||
                            session.cleaned
                        ) {
                            return;
                        }

                        session.endUpstream();

                        /*
                         * POST 的 HTTP response
                         * 只是确认 request 已经接收。
                         *
                         * 真正的 VLESS 下行走 GET。
                         */
                        if (
                            !responseEnded
                        ) {
                            responseEnded =
                                true;

                            if (
                                !res.headersSent
                            ) {
                                res.writeHead(
                                    200,
                                    {
                                        'Content-Type':
                                            'application/octet-stream',
                                        'Cache-Control':
                                            'no-store',
                                        'X-Padding':
                                            generatePadding(
                                                16,
                                                64
                                            )
                                    }
                                );
                            }

                            res.end();
                        }
                    }
                );


                /*
                 * -------------------------------------------------
                 * req aborted
                 * -------------------------------------------------
                 */

                req.on(
                    'aborted',
                    () => {
                        if (
                            requestAborted
                        ) {
                            return;
                        }

                        requestAborted =
                            true;

                        log(
                            'info',
                            `POST aborted: ${uuid}`
                        );

                        session.cleanup(
                            'upstream_aborted'
                        );
                    }
                );


                /*
                 * -------------------------------------------------
                 * req error
                 * -------------------------------------------------
                 */

                req.on(
                    'error',
                    err => {
                        if (
                            requestAborted
                        ) {
                            return;
                        }

                        requestAborted =
                            true;

                        log(
                            'debug',
                            `POST request error: ${err.message}`
                        );

                        session.cleanup(
                            'upstream_request_error'
                        );
                    }
                );


                /*
                 * -------------------------------------------------
                 * req close
                 *
                 * close 本身不能直接等同于异常。
                 *
                 * req.complete=true 表示 HTTP request
                 * 已完整接收。
                 * -------------------------------------------------
                 */

                req.on(
                    'close',
                    () => {
                        if (
                            requestAborted
                        ) {
                            return;
                        }

                        if (
                            !req.complete &&
                            !session.cleaned
                        ) {
                            log(
                                'info',
                                `POST closed before complete: ${uuid}`
                            );

                            session.cleanup(
                                'upstream_incomplete_close'
                            );
                        }
                    }
                );

                return;
            }


            /*
             * -------------------------------------------------
             * 其它 Method
             * -------------------------------------------------
             */

            send404(res);
        }
    );


/* =========================================================
 * Node / Koyeb HTTP lifecycle
 * ======================================================= */

/*
 * Koyeb Edge 本身的连接/idle 限制
 * 不能由 Node 突破。
 *
 * 这里主要避免 Node 自己过早关闭。
 */

server.keepAliveTimeout =
    65000;

server.headersTimeout =
    70000;

/*
 * 0 = 不限制 request body 时间。
 *
 * Koyeb Edge 仍然有自己的限制。
 */
server.requestTimeout =
    0;

/*
 * socket inactivity timeout。
 *
 * 由 Session 层处理。
 */
server.timeout =
    0;

server.maxConnections =
    100;


/*
 * HTTP server error
 */
server.on(
    'error',
    err => {
        log(
            'error',
            `HTTP server error: ${err.message}`
        );
    }
);


/*
 * connection 生命周期。
 */
server.on(
    'connection',
    socket => {
        try {
            socket.setNoDelay(
                SETTINGS.TCP_NODELAY
            );

            socket.setKeepAlive(
                SETTINGS.TCP_KEEPALIVE,
                SETTINGS.TCP_KEEPALIVE_DELAY
            );
        } catch (_) {}
    }
);


/* =========================================================
 * Cleanup files
 * ======================================================= */

function deleteNezhaFiles() {
    const files = [
        'nezha-agent',
        'config.yaml'
    ];

    for (
        const filename of files
    ) {
        const file =
            path.join(
                __dirname,
                filename
            );

        fs.unlink(
            file,
            () => {}
        );
    }
}


/* =========================================================
 * Graceful shutdown
 * ======================================================= */

let shuttingDown =
    false;


function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown =
        true;

    log(
        'info',
        `Received ${signal}, shutting down`
    );

    clearInterval(
        sessionTimer
    );

    for (
        const [, session]
        of sessions
    ) {
        try {
            session.cleanup(
                `shutdown_${signal}`
            );
        } catch (_) {}
    }

    sessions.clear();

    server.close(
        () => {
            process.exit(0);
        }
    );

    /*
     * 防止某个 socket 永远不退出。
     */
    setTimeout(
        () => process.exit(1),
        5000
    ).unref();
}


process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);


/* =========================================================
 * 启动
 * ======================================================= */

async function bootstrap() {
    try {
        /*
         * 先获取订阅需要的信息。
         */
        PUBLIC_IP =
            await getPublicIP();

        ISP =
            await getISP();

        log(
            'info',
            `Public IP: ${PUBLIC_IP}`
        );

        log(
            'info',
            `ISP: ${ISP}`
        );

        /*
         * 启动 HTTP。
         */
        server.listen(
            PORT,
            '0.0.0.0',
            () => {
                console.log(
                    `Server is running on port ${PORT}`
                );

                console.log(
                    `XHTTP path: /${XPATH}/${UUID}`
                );

                console.log(
                    `XHTTP mode: stream-one`
                );

                console.log(
                    `Subscription: /${SUB_PATH}`
                );

                console.log(
                    `Koyeb origin protocol: HTTP/1.1`
                );

                /*
                 * 后台启动 Nezha。
                 */
                runNezha()
                    .catch(err => {
                        log(
                            'error',
                            `Nezha startup error: ${err.message}`
                        );
                    });

                /*
                 * 自动 Access。
                 */
                addAccessTask()
                    .catch(err => {
                        log(
                            'error',
                            `Access task error: ${err.message}`
                        );
                    });

                /*
                 * 原代码 5 分钟后删除文件。
                 *
                 * 保留这个行为。
                 */
                setTimeout(
                    deleteNezhaFiles,
                    300000
                ).unref?.();
            }
        );
    } catch (err) {
        console.error(
            `Bootstrap failed: ${err.stack || err.message}`
        );

        process.exit(1);
    }
}


bootstrap();
