const WebSocket = require('ws');
const http = require('http');
const net = require('net');
const chalk = require('chalk');

// --- A. Utility: Structured Logger ---
const logger = {
    info: (message) => console.log(chalk.green(`[INFO] ${new Date().toISOString()} | ${message}`)),
    warn: (message) => console.log(chalk.yellow(`[WARN] ${new Date().toISOString()} | ${message}`)),
    error: (message, error) => console.error(chalk.red(`[ERROR] ${new Date().toISOString()} | ${message}`), error || ''),
    fatal: (message, error) => {
        console.error(chalk.bgRed.white(`[FATAL] ${new Date().toISOString()} | ${message}`), error || '');
        process.exit(1);
    },
    conn: (id, message) => console.log(chalk.cyan(`[CONN-${id}] ${message}`)),
    debug: (id, message) => console.log(chalk.magenta(`[DEBUG-${id}] ${message}`)),
};

// --- B. Constants & Configuration ---
const CONSTANTS = {
    CLOSE_NORMAL: 1000,
    CLOSE_INTERNAL_ERROR: 1011,
    HEARTBEAT_INTERVAL: 30000,
};

logger.info('---------------------------------------------------------');
logger.info('Eaglercraft 1.12.2 WebSocket-to-TCP Proxy (Diagnostic Build)');
logger.info('---------------------------------------------------------');

// --- 1. Reading Environment Configuration ---
const SERVER_ADDRESS = process.env.SERVER;
const PORT = parseInt(process.env.PORT || '10000', 10);
const DEBUG_PACKETS = process.env.DEBUG_PACKETS === 'true'; // <-- NEW!

if (DEBUG_PACKETS) {
    logger.warn('Packet debugging is ENABLED. This will produce a lot of log output.');
}

if (!SERVER_ADDRESS) {
    logger.fatal("The 'SERVER' environment variable is not set. This is required.");
}
if (isNaN(PORT)) {
    logger.fatal(`The 'PORT' environment variable "${process.env.PORT}" is not a valid number.`);
}

const parts = SERVER_ADDRESS.split(':');
const BACKEND_SERVER_IP = parts[0];
const BACKEND_SERVER_PORT = parseInt(parts[1], 10);

if (!BACKEND_SERVER_IP || isNaN(BACKEND_SERVER_PORT)) {
    logger.fatal(`SERVER variable "${SERVER_ADDRESS}" is not in the correct 'hostname:port' format.`);
}

logger.info(`Proxy will listen on port: ${PORT}`);
logger.info(`Backend Minecraft server TCP address: ${BACKEND_SERVER_IP}:${BACKEND_SERVER_PORT}`);

// --- 2. Initializing the Server ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Eaglercraft Proxy is running.');
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// --- 3. Handling a New Client Connection ---
let connectionCounter = 0;
wss.on('connection', (clientWs, req) => {
    const connectionId = (++connectionCounter).toString(16).toUpperCase();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    logger.conn(connectionId, `➡️  New client connected from IP: ${clientIp}`);
    
    const backendTcp = net.createConnection({ host: BACKEND_SERVER_IP, port: BACKEND_SERVER_PORT });

    clientWs.isAlive = true;

    // --- Backend TCP Event Handlers ---
    backendTcp.on('connect', () => {
        logger.conn(connectionId, '✅ Successfully connected to backend Minecraft server.');

        // --- Eaglercraft Protocol Handling ---

        // Handle messages from the Eaglercraft Client (WebSocket) -> Minecraft Server (TCP)
        clientWs.on('message', (message) => {
            if (Buffer.isBuffer(message) && message.length > 0) {
                if (DEBUG_PACKETS) {
                    logger.debug(connectionId, `C->S | Size: ${message.length} bytes, Data: ${message.toString('hex', 0, 16)}...`);
                }
                
                // Eaglercraft 1.12.2 prefixes game packets with 0x01. We must remove this.
                if (message[0] === 0x01) {
                    if (!backendTcp.destroyed) {
                        backendTcp.write(message.slice(1));
                    }
                } else {
                    logger.warn(`[CONN-${connectionId}] Received unknown opcode from client: 0x${message[0].toString(16)}`);
                }
            }
        });

        // Handle data from the Minecraft Server (TCP) -> Eaglercraft Client (WebSocket)
        backendTcp.on('data', (data) => {
            if (DEBUG_PACKETS) {
                logger.debug(connectionId, `S->C | Size: ${data.length} bytes, Data: ${data.toString('hex', 0, 16)}...`);
            }
            
            // Eaglercraft 1.12.2 expects game packets to be prefixed with 0x02. We must add this.
            const opcode = Buffer.from([0x02]);
            const wrappedPacket = Buffer.concat([opcode, data]);
            
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(wrappedPacket);
            }
        });
    });

    // --- Connection Teardown and Error Handling ---

    backendTcp.on('close', () => {
        logger.conn(connectionId, '🚫 Backend TCP connection closed. Terminating client WebSocket.');
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(CONSTANTS.CLOSE_NORMAL, 'Backend server disconnected.');
        }
    });

    backendTcp.on('error', (error) => {
        logger.error(`[CONN-${connectionId}] ❌ Error on backend TCP connection: ${error.message}. Terminating client WebSocket.`);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(CONSTANTS.CLOSE_INTERNAL_ERROR, 'Backend connection error.');
        }
        backendTcp.destroy();
    });

    clientWs.on('close', (code, reason) => {
        const reasonText = reason?.toString() || 'No reason given';
        logger.conn(connectionId, `🚫 Client WebSocket disconnected. Code: ${code}, Reason: ${reasonText}. Terminating backend TCP connection.`);
        if (!backendTcp.destroyed) {
            backendTcp.destroy();
        }
    });

    clientWs.on('error', (error) => {
        logger.error(`[CONN-${connectionId}] ❌ Error on client WebSocket: ${error.message}. Terminating backend TCP connection.`);
        if (!backendTcp.destroyed) {
            backendTcp.destroy();
        }
    });

    clientWs.on('pong', () => { clientWs.isAlive = true; });
});

// --- 4. Heartbeat to Prune Dead Connections ---
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            logger.info('Heartbeat failed, terminating dead connection.');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, CONSTANTS.HEARTBEAT_INTERVAL);

// --- 5. Main Application Startup ---
server.listen(PORT, () => {
    logger.info(`✅ Proxy is online and listening on port ${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
