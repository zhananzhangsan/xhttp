'use strict';

const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');


/* =========================================================
* Environment
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
String(
process.env.AUTO_ACCESS || 'false'
).toLowerCase() === 'true';

const XPATH =
process.env.XPATH ||
UUID.slice(0, 8);

const SUB_PATH =
process.env.SUB_PATH ||
UUID;

const DOMAIN =
process.env.DOMAIN || '';

const NAME =
process.env.NAME || '';

const PORT =
Number(process.env.PORT || 3000);


/* =========================================================
* Settings
* ======================================================= */

const SETTINGS = {
UUID,

LOG_LEVEL:
process.env.LOG_LEVEL || 'none',

BUFFER_SIZE:
Number(
process.env.BUFFER_SIZE || 65536
),

CHUNK_SIZE:
Number(
process.env.CHUNK_SIZE || 65536
),

SESSION_TIMEOUT:
Number(
process.env.SESSION_TIMEOUT || 45000
),

CONNECT_TIMEOUT:
Number(
process.env.CONNECT_TIMEOUT || 8000
),

TCP_NODELAY:
true,

TCP_KEEPALIVE:
true,

TCP_KEEPALIVE_DELAY:
10000,

MAX_SESSIONS:
Number(
process.env.MAX_SESSIONS || 50
),

MAX_HEADER_SIZE:
Number(
process.env.MAX_HEADER_SIZE || 65536
),

MAX_POST_SIZE:
Number(
process.env.MAX_POST_SIZE || 0
)
};


/* =========================================================
* Logging
* ======================================================= */

function log(type, ...args) {
if (
SETTINGS.LOG_LEVEL === 'none'
) {
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

if (
messageLevel < configLevel
) {
return;
}

const time =
new Date().toISOString();

const color =
colors[type] ||
colors.reset;

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

if (
!/^[0-9a-f]{32}$/.test(clean)
) {
throw new Error(
'invalid UUID format'
);
}

const result =
Buffer.alloc(16);

for (
let i = 0;
i < 16;
i++
) {
result[i] =
parseInt(
clean.slice(
i * 2,
i * 2 + 2
),
16
);
}

return result;
}


function validateUUID(left, right) {
if (
!left ||
!right ||
left.length !== 16 ||
right.length !== 16
) {
return false;
}

return left.equals(right);
}


const CONFIG_UUID_BYTES =
parseUUID(UUID);


/* =========================================================
* Padding
* ======================================================= */

function generatePadding(min, max) {
min = Math.max(
0,
Number(min) || 0
);

max = Math.max(
min,
Number(max) || min
);

const length =
min +
Math.floor(
Math.random() *
(max - min + 1)
);

return Buffer
.alloc(length, 0x58)
.toString('base64');
}


/* =========================================================
* Headers
* ======================================================= */

function createStreamHeaders() {
return {
'Content-Type':
'application/octet-stream',

'Cache-Control':
'no-store, no-cache, must-revalidate',

'Pragma':
'no-cache',

'Access-Control-Allow-Origin':
'*',

'Access-Control-Allow-Methods':
'GET, POST, OPTIONS',

'Access-Control-Allow-Headers':
'*',

'X-Accel-Buffering':
'no',

'X-Padding':
generatePadding(32, 128)
};
}


function createSubscriptionHeaders() {
return {
'Content-Type':
'text/plain; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*',

'Access-Control-Allow-Headers':
'*'
};
}


/* =========================================================
* VLESS Parser
*
* stream-one:
*
* One POST request carries:
*
* VLESS header
* +
* TCP data
* +
* TCP data
* +
* ...
*
* No packet sequence.
* No reordering.
* No pending packet map.
* ======================================================= */

class VLESSParser {
constructor(uuidBytes) {
this.uuidBytes =
uuidBytes;

this.buffer =
Buffer.alloc(0);

this.headerParsed =
false;

this.header =
null;
}


append(chunk) {
if (
!chunk ||
chunk.length === 0
) {
return;
}

/*
* Once the header has already been
* parsed, parser should no longer
* receive data.
*/
if (
this.headerParsed
) {
return;
}

if (
this.buffer.length === 0
) {
this.buffer =
Buffer.from(chunk);
} else {
this.buffer =
Buffer.concat([
this.buffer,
chunk
]);
}

/*
* This limit protects the parser from
* an endlessly incomplete header.
*/
if (
this.buffer.length >
SETTINGS.MAX_HEADER_SIZE
) {
throw new Error(
'VLESS header too large'
);
}
}


parse() {
if (
this.headerParsed
) {
return this.header;
}

const buf =
this.buffer;

/*
* Fixed section:
*
* version = 1 byte
* UUID = 16 bytes
* addons = 1 byte
*
* total = 18 bytes
*/
if (
buf.length < 18
) {
return null;
}

const version =
buf[0];

const uuid =
buf.subarray(
1,
17
);

if (
!validateUUID(
uuid,
this.uuidBytes
)
) {
throw new Error(
'invalid UUID'
);
}

const addonLength =
buf[17];

/*
* VLESS header:
*
* version
* UUID
* addon length
* addon
* command
*/
const commandOffset =
18 +
addonLength;

if (
buf.length <
commandOffset + 1
) {
return null;
}

const command =
buf[commandOffset];

/*
* TCP command.
*/
if (
command !== 1
) {
throw new Error(
`unsupported VLESS command: ${command}`
);
}

/*
* command
* port
* address type
*/
const portOffset =
commandOffset + 1;

if (
buf.length <
portOffset + 3
) {
return null;
}

const port =
buf.readUInt16BE(
portOffset
);

const addressType =
buf[portOffset + 2];

const addressOffset =
portOffset + 3;

let hostname =
'';

let headerLength =
0;


/*
* IPv4
*/
if (
addressType === 1
) {
if (
buf.length <
addressOffset + 4
) {
return null;
}

hostname =
Array
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
else if (
addressType === 2
) {
if (
buf.length <
addressOffset + 1
) {
return null;
}

const domainLength =
buf[addressOffset];

if (
domainLength <= 0
) {
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
addressOffset +
1 +
domainLength
)
.toString('utf8');

if (
!hostname
) {
throw new Error(
'empty VLESS domain'
);
}

headerLength =
addressOffset +
1 +
domainLength;
}


/*
* IPv6
*/
else if (
addressType === 3
) {
if (
buf.length <
addressOffset + 16
) {
return null;
}

const parts = [];

for (
let i = 0;
i < 16;
i += 2
) {
parts.push(
buf
.readUInt16BE(
addressOffset + i
)
.toString(16)
);
}

hostname =
compressIPv6(
parts.join(':')
);

headerLength =
addressOffset + 16;
}


else {
throw new Error(
`unsupported address type: ${addressType}`
);
}


if (
!hostname
) {
throw new Error(
'empty VLESS hostname'
);
}

/*
* Everything after the VLESS header
* belongs to the upstream TCP stream.
*/
const remaining =
buf.subarray(
headerLength
);

this.header = {
version,

hostname,

port,

data:
Buffer.from(
remaining
),

resp:
Buffer.from([
version,
0
])
};

this.buffer =
Buffer.alloc(0);

this.headerParsed =
true;

return this.header;
}
}


/* =========================================================
* IPv6 helpers
* ======================================================= */

function compressIPv6(address) {
const parts =
String(address)
.split(':')
.map(
part => part || '0'
);

/*
* Find the longest sequence of zero groups.
*/
let bestStart = -1;
let bestLength = 0;

let currentStart = -1;
let currentLength = 0;

for (
let i = 0;
i <= parts.length;
i++
) {
if (
i < parts.length &&
parts[i] === '0'
) {
if (
currentStart === -1
) {
currentStart = i;
currentLength = 1;
} else {
currentLength++;
}
} else {
if (
currentLength > bestLength
) {
bestStart =
currentStart;

bestLength =
currentLength;
}

currentStart =
-1;

currentLength =
0;
}
}

/*
* RFC 5952 style compression should
* generally compress a run of at least
* two zero groups.
*/
if (
bestLength < 2
) {
return parts.join(':');
}

const left =
parts
.slice(
0,
bestStart
)
.join(':');

const right =
parts
.slice(
bestStart + bestLength
)
.join(':');

if (
!left &&
!right
) {
return '::';
}

if (
!left
) {
return `::${right}`;
}

if (
!right
) {
return `${left}::`;
}

return `${left}::${right}`;
}


function stripIPv6Brackets(value) {
const text =
String(value || '');

if (
text.startsWith('[') &&
text.endsWith(']')
) {
return text.slice(
1,
-1
);
}

return text;
}


function formatHostPort(host, port) {
const clean =
stripIPv6Brackets(
host
);

if (
net.isIPv6(clean)
) {
return `[${clean}]:${port}`;
}

return `${clean}:${port}`;
}


/* =========================================================
* TCP Connect
* ======================================================= */

function timedConnect(
hostname,
port,
timeout
) {
return new Promise(
(resolve, reject) => {
let settled =
false;

const socket =
net.createConnection({
host: hostname,
port
});

const timer =
setTimeout(
() => {
if (
settled
) {
return;
}

settled =
true;

try {
socket.destroy();
} catch (_) {}

reject(
new Error(
`connect timeout: ${formatHostPort(hostname, port)}`
)
);
},
timeout
);

socket.once(
'connect',
() => {
if (
settled
) {
return;
}

settled =
true;

clearTimeout(
timer
);

try {
socket.setNoDelay(
SETTINGS.TCP_NODELAY
);

socket.setKeepAlive(
SETTINGS.TCP_KEEPALIVE,
SETTINGS.TCP_KEEPALIVE_DELAY
);

if (
socket._readableState
) {
socket._readableState.highWaterMark =
SETTINGS.BUFFER_SIZE;
}

if (
socket._writableState
) {
socket._writableState.highWaterMark =
SETTINGS.BUFFER_SIZE;
}
} catch (err) {
log(
'warn',
`TCP socket tuning failed: ${err.message}`
);
}

resolve(
socket
);
}
);

socket.once(
'error',
err => {
if (
settled
) {
return;
}

settled =
true;

clearTimeout(
timer
);

reject(
err
);
}
);
}
);
}


/* =========================================================
* Sessions
* ======================================================= */

const sessions =
new Map();


function getOrCreateSession(uuid) {
let session =
sessions.get(uuid);

if (
session &&
!session.cleaned
) {
return session;
}

if (
session &&
session.cleaned
) {
sessions.delete(
uuid
);
}

if (
sessions.size >=
SETTINGS.MAX_SESSIONS
) {
let victim =
null;

let victimScore =
-Infinity;

for (
const [id, current]
of sessions
) {
if (
current.cleaned ||
current.cleaning
) {
continue;
}

let score =
0;

/*
* Sessions without a downstream
* are more disposable.
*/
if (
!current.downstreamStarted
) {
score += 1000;
}

if (
!current.initialized
) {
score += 500;
}

if (
!current.remote
) {
score += 500;
}

const idle =
Date.now() -
current.lastActivity;

score +=
Math.min(
idle / 1000,
300
);

if (
score > victimScore
) {
victimScore =
score;

victim =
id;
}
}

if (
victim
) {
const old =
sessions.get(
victim
);

if (
old
) {
log(
'warn',
`Evicting session ${victim}`
);

old.cleanup(
'max_sessions'
);
}
}

if (
sessions.size >=
SETTINGS.MAX_SESSIONS
) {
throw new Error(
'too many sessions'
);
}
}

session =
new Session(
uuid
);

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
this.uuid =
uuid;

this.remote =
null;

this.initialized =
false;

this.initializing =
false;

this.vlessHeader =
null;

this.vlessParser =
new VLESSParser(
CONFIG_UUID_BYTES
);

this.downstreamRes =
null;

this.downstreamStarted =
false;

this.downstreamFinished =
false;

this.upstreamReq =
null;

this.upstreamStarted =
false;

this.upstreamEnded =
false;

this.responseHeaderSent =
false;

this.lastActivity =
Date.now();

this.cleaned =
false;

this.cleaning =
false;

this.noDownstreamTimer =
null;

this.remoteEnded =
false;

this.remoteErrored =
false;

this.remoteDataHandler =
null;

this.remoteEndHandler =
null;

this.remoteErrorHandler =
null;

this.remoteCloseHandler =
null;

this.remoteStreamDataHandler =
null;
}


touch() {
this.lastActivity =
Date.now();
}


clearNoDownstreamTimer() {
if (
this.noDownstreamTimer
) {
clearTimeout(
this.noDownstreamTimer
);

this.noDownstreamTimer =
null;
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
setTimeout(
() => {
this.noDownstreamTimer =
null;

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
},
SETTINGS.SESSION_TIMEOUT
);

this.noDownstreamTimer.unref?.();
}


attachDownstream(res) {
if (
this.cleaned
) {
return false;
}

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

this.downstreamFinished =
false;

this.touch();

if (
!res.headersSent
) {
res.writeHead(
200,
createStreamHeaders()
);
}

if (
typeof res.flushHeaders ===
'function'
) {
try {
res.flushHeaders();
} catch (_) {}
}

res.on(
'close',
() => {
if (
!res.writableFinished &&
!this.downstreamFinished &&
!this.cleaned
) {
log(
'info',
`Downstream closed: ${this.uuid}`
);

this.cleanup(
'downstream_aborted'
);
}
}
);

res.on(
'error',
err => {
if (
this.cleaned
) {
return;
}

log(
'warn',
`Downstream error: ${err.message}`
);

this.cleanup(
'downstream_error'
);
}
);

res.on(
'finish',
() => {
this.downstreamFinished =
true;

this.touch();

/*
* Do not immediately destroy the
* remote if upstream is still active.
*
* However, if remote has already ended,
* the whole session is finished.
*/
if (
this.remoteEnded ||
(
this.upstreamEnded &&
!this.remote
)
) {
this.cleanup(
'downstream_finished'
);
}
}
);

if (
this.initialized &&
this.remote
) {
this.startRemoteToDownstream();
}

return true;
}


async initializeFromParser() {
if (
this.initialized
) {
return true;
}

if (
this.initializing
) {
return false;
}

this.initializing =
true;

try {
const header =
this.vlessParser.parse();

if (
!header
) {
return false;
}

this.vlessHeader =
header;

log(
'info',
`VLESS target ${formatHostPort(
header.hostname,
header.port
)}`
);

this.remote =
await timedConnect(
header.hostname,
header.port,
SETTINGS.CONNECT_TIMEOUT
);

if (
this.cleaned
) {
try {
this.remote.destroy();
} catch (_) {}

this.remote =
null;

return false;
}

this.initialized =
true;

this.touch();

this.attachRemoteEvents();

/*
* VLESS response header.
*/
if (
this.downstreamRes &&
!this.responseHeaderSent &&
!this.downstreamRes.destroyed &&
!this.downstreamRes.writableEnded
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
* Data that followed the VLESS
* header in the same POST chunk.
*/
if (
header.data &&
header.data.length > 0
) {
await this.writeRemote(
header.data
);
}

if (
this.downstreamRes
) {
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
if (
this.cleaned
) {
return;
}

if (
!chunk ||
chunk.length === 0
) {
return;
}

this.touch();

if (
!this.initialized
) {
this.vlessParser.append(
chunk
);

const header =
this.vlessParser.parse();

if (
!header
) {
return;
}

const initialized =
await this.initializeFromParser();

if (
!initialized &&
!this.cleaned
) {
throw new Error(
'failed to initialize VLESS session'
);
}

return;
}

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

let settled =
false;

const done =
err => {
if (
settled
) {
return;
}

settled =
true;

if (
err
) {
reject(
err
);
} else {
this.touch();

resolve();
}
};

try {
const ok =
socket.write(
data,
err => {
done(
err
);
}
);

/*
* socket.write callback indicates
* that the chunk was handed to Node's
* socket layer, not necessarily that
* it reached the destination.
*
* The callback is sufficient for
* preserving write ordering here.
*/
if (
!ok
) {
/*
* Do not resolve on drain.
* The write callback remains the
* completion signal for this chunk.
*/
}
} catch (err) {
done(
err
);
}
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
* POST end means upstream request body
* has ended.
*
* Half-close the remote TCP connection.
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
* If remote has already ended too,
* the session can be cleaned.
*/
if (
this.remoteEnded
) {
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
if (
this.cleaned
) {
return;
}

this.remoteEnded =
true;

this.touch();

log(
'info',
`Remote ended: ${this.uuid}`
);

/*
* The remote TCP side has ended.
* Finish downstream response.
*/
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
* Do not wait forever for the HTTP
* response after remote EOF.
*/
this.cleanup(
'remote_end'
);
};

this.remoteErrorHandler =
err => {
if (
this.cleaned
) {
return;
}

this.remoteErrored =
true;

log(
'warn',
`Remote error: ${err.message}`
);

this.cleanup(
'remote_error'
);
};

this.remoteCloseHandler =
hadError => {
if (
this.cleaned
) {
return;
}

/*
* A normal close can happen after
* remote end. If there was an error,
* cleanup explicitly.
*/
if (
hadError
) {
this.cleanup(
'remote_close_error'
);
}
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
this.remoteCloseHandler
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

if (
this.remoteStreamDataHandler
) {
return;
}

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
res.write(
chunk
);

if (
!ok
) {
remote.pause();

const resume =
() => {
res.removeListener(
'drain',
resume
);

res.removeListener(
'close',
resume
);

if (
!this.cleaned &&
!remote.destroyed
) {
remote.resume();
}
};

res.once(
'drain',
resume
);

res.once(
'close',
resume
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

remote.on(
'data',
onData
);

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

if (
sessions.get(
this.uuid
) === this
) {
sessions.delete(
this.uuid
);
}


/*
* Remove remote -> response listener.
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

this.remoteStreamDataHandler =
null;
}


/*
* Remove generic remote listeners.
*/
if (
this.remote
) {
try {
if (
this.remoteDataHandler
) {
this.remote.removeListener(
'data',
this.remoteDataHandler
);
}

if (
this.remoteEndHandler
) {
this.remote.removeListener(
'end',
this.remoteEndHandler
);
}

if (
this.remoteErrorHandler
) {
this.remote.removeListener(
'error',
this.remoteErrorHandler
);
}

if (
this.remoteCloseHandler
) {
this.remote.removeListener(
'close',
this.remoteCloseHandler
);
}
} catch (_) {}
}


/*
* End downstream gracefully.
*/
if (
this.downstreamRes
) {
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
* Destroy remote TCP.
*/
if (
this.remote
) {
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
* Destroy incomplete upstream request.
*/
if (
this.upstreamReq &&
!this.upstreamEnded &&
!this.upstreamReq.complete
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
* Session idle cleanup
* ======================================================= */

const sessionTimer =
setInterval(
() => {
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
},
15000
);

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

if (
arm
) {
return NEZHA_PORT
? 'https://arm64.ssss.nyc.mn/agent'
: 'https://arm64.ssss.nyc.mn/v1';
}

return NEZHA_PORT
? 'https://amd64.ssss.nyc.mn/agent'
: 'https://amd64.ssss.nyc.mn/v1';
}


async function downloadNezha() {
if (
!NEZHA_KEY
) {
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

let settled =
false;

const finish =
err => {
if (
settled
) {
return;
}

settled =
true;

if (
err
) {
reject(
err
);
} else {
resolve();
}
};

writer.once(
'finish',
() => finish()
);

writer.once(
'error',
finish
);

response.data.once(
'error',
finish
);

response.data.pipe(
writer
);
}
);

await new Promise(
(resolve, reject) => {
fs.chmod(
file,
0o755,
err => {
if (
err
) {
reject(
err
);
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
if (
!server
) {
return '';
}

const text =
String(server).trim();

/*
* [IPv6]:port
*/
if (
text.startsWith('[')
) {
const match =
text.match(
/\]:(\d+)$/
);

return match
? match[1]
: '';
}

/*
* hostname:port / IPv4:port
*/
const match =
text.match(
/:(\d+)$/
);

return match
? match[1]
: '';
}


function formatNezhaServer(
server,
port
) {
const clean =
String(server || '')
.trim();

if (
!clean
) {
return '';
}

/*
* If NEZHA_SERVER already contains a
* port, do not append another port.
*/
if (
detectNezhaPort(
clean
)
) {
return clean;
}

const host =
stripIPv6Brackets(
clean
);

if (
net.isIPv6(host)
) {
return `[${host}]:${port}`;
}

return `${host}:${port}`;
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
tlsPorts.has(
port
)
? 'true'
: 'false';

const config =
`
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

if (
!fs.existsSync(
binary
)
) {
throw new Error(
'nezha-agent binary not found'
);
}

if (
NEZHA_PORT
) {
const address =
formatNezhaServer(
NEZHA_SERVER,
NEZHA_PORT
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

const args = [
'-s',
address,
'-p',
NEZHA_KEY
];

if (
tlsPorts.has(
String(
NEZHA_PORT
)
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

const configPath =
writeNezhaConfig();

const child =
spawn(
binary,
[
'-c',
configPath
],
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
* Public IP / ISP
* ======================================================= */

async function getIP() {
try {
const response =
await axios.get(
'https://api4.ipify.org',
{
timeout: 3000,
responseType: 'text'
}
);

const ip =
String(
response.data
).trim();

if (
ip
) {
return ip;
}
} catch (err) {
log(
'warn',
`IPv4 detection failed: ${err.message}`
);
}

try {
const response =
await axios.get(
'https://api6.ipify.org',
{
timeout: 3000,
responseType: 'text'
}
);

const ip =
String(
response.data
).trim();

if (
ip
) {
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

const isp =
data.asOrganization ||
data.asn ||
data.colo ||
'Unknown';

return String(
isp
)
.replace(
/\s+/g,
'_'
)
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

function buildVLESSURL(
IP,
ISP
) {
const ip =
String(
IP || ''
).trim();

/*
* IP may already be [IPv6].
*
* DOMAIN is preferred for SNI/Host.
*/
const sniHost =
DOMAIN ||
stripIPv6Brackets(
ip
);

/*
* VLESS server address needs IPv6
* brackets.
*/
const serverHost =
net.isIPv6(
stripIPv6Brackets(ip)
)
? `[${stripIPv6Brackets(ip)}]`
: ip;

const url =
`vless://${UUID}@${serverHost}:443` +
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
* HTTP helpers
* ======================================================= */

function send404(res) {
if (
res.headersSent
) {
try {
if (
!res.writableEnded
) {
res.end();
}
} catch (_) {}

return;
}

res.writeHead(
404,
{
'Content-Type':
'text/plain; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*'
}
);

res.end(
'Not Found'
);
}


function send500(res) {
if (
res.headersSent
) {
try {
if (
!res.writableEnded
) {
res.end();
}
} catch (_) {}

return;
}

res.writeHead(
500,
{
'Content-Type':
'text/plain; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*'
}
);

res.end(
'Internal Server Error'
);
}


function send503(res) {
if (
res.headersSent
) {
try {
if (
!res.writableEnded
) {
res.end();
}
} catch (_) {}

return;
}

res.writeHead(
503,
{
'Content-Type':
'text/plain; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*'
}
);

res.end(
'Service Unavailable'
);
}


/* =========================================================
* Runtime state
* ======================================================= */

let PUBLIC_IP =
DOMAIN || 'localhost';

let ISP =
'Unknown';


/* =========================================================
* HTTP Server
* ======================================================= */

const server =
http.createServer(
async (req, res) => {

/*
* -------------------------------------------------
* Basic headers
* -------------------------------------------------
*/

if (
!res.headersSent
) {
res.setHeader(
'Access-Control-Allow-Origin',
'*'
);
}


/*
* -------------------------------------------------
* OPTIONS
* -------------------------------------------------
*/

if (
req.method === 'OPTIONS'
) {
res.writeHead(
204,
{
'Access-Control-Allow-Origin':
'*',

'Access-Control-Allow-Methods':
'GET, POST, OPTIONS',

'Access-Control-Allow-Headers':
'*',

'Cache-Control':
'no-store'
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
if (
err
) {
send500(
res
);

return;
}

if (
res.headersSent
) {
return;
}

res.writeHead(
200,
{
'Content-Type':
'text/html; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*'
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
.from(
vlessURL
)
.toString(
'base64'
);

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
* stream-one:
*
* /XPATH/UUID
*
* No sequence number.
* -------------------------------------------------
*/

const expectedPrefix =
`/${XPATH}/`;

const urlWithoutQuery =
String(
req.url || ''
)
.split('?')[0];

if (
!urlWithoutQuery.startsWith(
expectedPrefix
)
) {
send404(
res
);

return;
}

const relative =
urlWithoutQuery.slice(
expectedPrefix.length
);

/*
* stream-one does not accept:
*
* /XPATH/UUID/0
* /XPATH/UUID/1
*/
if (
!relative ||
relative.includes('/')
) {
send404(
res
);

return;
}

let uuid;

try {
uuid =
decodeURIComponent(
relative
);
} catch (_) {
send404(
res
);

return;
}

if (
uuid !== UUID
) {
send404(
res
);

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

send503(
res
);

return;
}

req.on(
'aborted',
() => {
if (
!session.cleaned
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

if (
!attached
) {
if (
!res.headersSent
) {
res.writeHead(
409,
{
'Content-Type':
'text/plain; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*'
}
);
}

if (
!res.writableEnded
) {
res.end(
'Session already has downstream'
);
}

return;
}

return;
}


/*
* -------------------------------------------------
* UPSTREAM POST
*
* One POST carries the complete
* stream-one upstream.
* -------------------------------------------------
*/

if (
req.method === 'POST'
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

send503(
res
);

return;
}


/*
* Only one active POST may belong
* to a session.
*/
if (
session.upstreamStarted &&
session.upstreamReq &&
!session.upstreamEnded &&
!session.upstreamReq.destroyed
) {
if (
!res.headersSent
) {
res.writeHead(
409,
{
'Content-Type':
'text/plain; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*'
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

session.upstreamEnded =
false;

session.armNoDownstreamTimer();


let responseEnded =
false;

let requestAborted =
false;

let receivedBytes =
0;


/*
* Promise chain ensures that multiple
* Node data events cannot cause remote
* writes to execute out of order.
*/
let processing =
Promise.resolve();


req.on(
'data',
chunk => {
if (
requestAborted ||
session.cleaned
) {
return;
}

receivedBytes +=
chunk.length;

if (
SETTINGS.MAX_POST_SIZE > 0 &&
receivedBytes >
SETTINGS.MAX_POST_SIZE
) {
requestAborted =
true;

log(
'warn',
`POST size limit exceeded: ${uuid}`
);

session.cleanup(
'post_size_limit'
);

try {
req.destroy();
} catch (_) {}

return;
}


/*
* Pause immediately so that
* processing remains controlled.
*/
try {
req.pause();
} catch (_) {}


processing =
processing
.then(
async () => {
if (
requestAborted ||
session.cleaned
) {
return;
}

await session.feedUpstream(
chunk
);
}
)
.catch(
err => {
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
responseEnded =
true;

res.writeHead(
500,
{
'Content-Type':
'text/plain; charset=utf-8',

'Cache-Control':
'no-store',

'Access-Control-Allow-Origin':
'*'
}
);

res.end(
'Upstream Error'
);
}
}
)
.finally(
() => {
if (
!requestAborted &&
!session.cleaned
) {
try {
req.resume();
} catch (_) {}
}
}
);
}
);


/*
* POST complete.
*
* Wait until every data chunk
* has been processed before
* half-closing remote TCP.
*/
req.on(
'end',
async () => {
try {
await processing;
} catch (_) {}


if (
requestAborted ||
session.cleaned
) {
return;
}


try {
session.endUpstream();
} catch (err) {
log(
'warn',
`Failed to end upstream: ${err.message}`
);

session.cleanup(
'upstream_end_failed'
);

return;
}


/*
* POST response is only the
* acknowledgement of the HTTP
* request body.
*
* Downstream traffic continues
* through the GET response.
*/
if (
!responseEnded &&
!res.writableEnded
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

'Access-Control-Allow-Origin':
'*',

'X-Padding':
generatePadding(
16,
64
)
}
);
}

if (
!res.writableEnded
) {
res.end();
}
}
}
);


/*
* POST aborted.
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
* POST error.
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
* close does not automatically mean
* an error.
*
* req.complete indicates that the
* complete HTTP message was received.
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

requestAborted =
true;

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
* Unsupported method
* -------------------------------------------------
*/

send404(
res
);
}
);


/* =========================================================
* Koyeb / Node HTTP lifecycle
* ======================================================= */

/*
* Koyeb's external proxy has its own limits.
*
* These settings prevent Node itself from
* unnecessarily terminating long connections.
*/
server.keepAliveTimeout =
65000;

server.headersTimeout =
70000;

/*
* Disable Node's request timeout.
*/
server.requestTimeout =
0;

/*
* Disable generic socket inactivity timeout.
*/
server.timeout =
0;

server.maxConnections =
100;


/* =========================================================
* HTTP server error
* ======================================================= */

server.on(
'error',
err => {
log(
'error',
`HTTP server error: ${err.message}`
);
}
);


/* =========================================================
* Incoming connection tuning
* ======================================================= */

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
* Nezha cleanup
* ======================================================= */

function deleteNezhaFiles() {
const files = [
'nezha-agent',
'config.yaml'
];

for (
const filename
of files
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
if (
shuttingDown
) {
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


/*
* Copy the sessions first because
* cleanup() removes them from the map.
*/
const activeSessions =
Array.from(
sessions.values()
);

for (
const session
of activeSessions
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
process.exit(
0
);
}
);


setTimeout(
() => {
process.exit(
1
);
},
5000
).unref();
}


process.on(
'SIGTERM',
() => {
shutdown(
'SIGTERM'
);
}
);


process.on(
'SIGINT',
() => {
shutdown(
'SIGINT'
);
}
);


/* =========================================================
* Uncaught errors
* ======================================================= */

process.on(
'uncaughtException',
err => {
log(
'error',
`Uncaught exception: ${err.stack || err.message}`
);
}
);


process.on(
'unhandledRejection',
err => {
log(
'error',
`Unhandled rejection: ${
err && err.stack
? err.stack
: err
}`
);
}
);


/* =========================================================
* Bootstrap
* ======================================================= */

async function bootstrap() {
try {

/*
* Validate important configuration
* before starting the server.
*/
parseUUID(
UUID
);

if (
!Number.isInteger(PORT) ||
PORT <= 0 ||
PORT > 65535
) {
throw new Error(
`invalid PORT: ${PORT}`
);
}

if (
SETTINGS.MAX_SESSIONS < 1
) {
throw new Error(
'MAX_SESSIONS must be greater than 0'
);
}

if (
SETTINGS.CONNECT_TIMEOUT < 1
) {
throw new Error(
'CONNECT_TIMEOUT must be greater than 0'
);
}


/*
* Public IP.
*/
PUBLIC_IP =
await getIP();


/*
* ISP.
*/
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
* Start HTTP server.
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
* Start Nezha in background.
*/
runNezha()
.catch(
err => {
log(
'error',
`Nezha startup error: ${err.message}`
);
}
);


/*
* Automatic Access.
*/
addAccessTask()
.catch(
err => {
log(
'error',
`Access task error: ${err.message}`
);
}
);


/*
* Remove temporary Nezha
* files after five minutes.
*/
setTimeout(
deleteNezhaFiles,
300000
).unref?.();
}
);

} catch (err) {
console.error(
`Bootstrap failed: ${
err.stack ||
err.message
}`
);

process.exit(
1
);
}
}


/* =========================================================
* Start
* ======================================================= */

bootstrap();

