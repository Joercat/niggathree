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
};

// --- B. Constants & Configuration ---
const CONSTANTS = {
    CLOSE_NORMAL: 1000,
    CLOSE_INTERNAL_ERROR: 1011,
    HEARTBEAT_INTERVAL: 30000,
};

logger.info('----------------------------------------------------');
logger.info('Eaglercraft 1.12.2 WebSocket-to-TCP Proxy (Fixed)');
logger.info('----------------------------------------------------');

// --- 1. Reading Environment Configuration ---
const server_address = process.env.SERVER;
const PORT = parseInt(process.env.PORT || '10000', 10);

if (!server_address) {
    logger.fatal("The 'SERVER' environment variable is not set. This is required.");
}
if (isNaN(PORT)) {
    logger.fatal(`The 'PORT' environment variable "${process.env.PORT}" is not a valid number.`);
}

const parts = server_address.split(':');
const BACKEND_SERVER_IP = parts[0];
const BACKEND_SERVER_PORT = parseInt(parts[1], 10);

if (!BACKEND_SERVER_IP || isNaN(BACKEND_SERVER_PORT)) {
    logger.fatal(`SERVER variable "${server_address}" is not in the correct 'hostname:port' format.`);
}

logger.info(`Proxy will listen on port: ${PORT}`);
logger.info(`Backend Minecraft server TCP address: ${BACKEND_SERVER_IP}:${BACKEND_SERVER_PORT}`);


// --- 2. Startup Check for Backend Server ---
/**
 * Tries to establish a brief TCP connection to the backend server to ensure it's online.
 * @returns {Promise<void>} Resolves if connection is successful, rejects otherwise.
 */
function checkBackendServer() {
    return new Promise((resolve, reject) => {
        logger.info(`Performing pre-flight check on backend server at ${BACKEND_SERVER_IP}:${BACKEND_SERVER_PORT}...`);

        const socket = net.createConnection({ host: BACKEND_SERVER_IP, port: BACKEND_SERVER_PORT });

        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error('Connection timed out after 5 seconds.'));
        });

        socket.on('connect', () => {
            logger.info(chalk.green('✅ Backend server is online. Pre-flight check passed.'));
            socket.end(); // Immediately close the connection
            resolve();
        });

        socket.on('error', (err) => {
            let reason = '';
            if (err.code === 'ECONNREFUSED') {
                reason = 'Connection refused. Is the server running? Is the IP/port correct?';
            } else if (err.code === 'ENOTFOUND') {
                reason = 'Address not found. Check the hostname for typos.';
            } else {
                reason = `An unexpected network error occurred: ${err.message}`;
            }
            reject(new Error(reason));
        });
    });
}


// --- 3. Initializing the Server ---
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// --- 4. Handling a New Client Connection ---
wss.on('connection', (clientWs, req) => {
    const connectionId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    logger.conn(connectionId, `➡️  New client connected from IP: ${clientIp}`);
    
    const backendTcp = net.createConnection({ host: BACKEND_SERVER_IP, port: BACKEND_SERVER_PORT });

    clientWs.isAlive = true;
    clientWs.on('pong', () => { clientWs.isAlive = true; });

    // --- Backend TCP Event Handlers ---
    backendTcp.on('connect', () => {
        logger.conn(connectionId, '✅ Successfully connected to backend Minecraft server.');

        // ----------------------- FIX: START -----------------------
        // This is the corrected logic for handling the Eaglercraft 1.12.2 protocol.

        // Handle messages from the Eaglercraft Client (WebSocket)
        clientWs.on('message', (message) => {
            if (Buffer.isBuffer(message) && message.length > 0) {
                const opcode = message[0];
                if (opcode === 0x01) { // 0x01 = Client-to-Server Game Packet
                    if (!backendTcp.destroyed) {
                        // Slice off the opcode and send the rest of the buffer (the raw MC packet) to the server.
                        backendTcp.write(message.slice(1));
                    }
                } else {
                    logger.conn(connectionId, `WARN: Received unknown/unhandled opcode from client: 0x${opcode.toString(16)}`);
                }
            }
        });

        // Handle data from the Minecraft Server (TCP)
        backendTcp.on('data', (data) => {
            // The server sends raw MC data. We must wrap it with the 0x02 opcode.
            const opcode = Buffer.from([0x02]); // 0x02 = Server-to-Client Game Packet
            const wrappedPacket = Buffer.concat([opcode, data]);
            
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(wrappedPacket);
            }
        });

        // ------------------------ FIX: END ------------------------
    });

    backendTcp.on('close', () => {
        logger.conn(connectionId, '🚫 Backend TCP connection closed. Closing client connection.');
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(CONSTANTS.CLOSE_NORMAL, 'Backend server disconnected.');
        }
    });

    backendTcp.on('error', (error) => {
        logger.error(`[CONN-${connectionId}] ❌ Error on backend TCP connection:`, error);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(CONSTANTS.CLOSE_INTERNAL_ERROR, 'Backend connection error.');
        }
    });

    // --- Client WebSocket Event Handlers ---
    clientWs.on('close', (code, reason) => {
        const reasonText = reason?.toString() || 'No reason given';
        logger.conn(connectionId, `🚫 Client disconnected. Code: ${code}, Reason: ${reasonText}. Closing backend connection.`);
        if (!backendTcp.destroyed) {
            backendTcp.destroy();
        }
    });

    clientWs.on('error', (error) => {
        logger.error(`[CONN-${connectionId}] ❌ Error on client connection:`, error.message);
        if (!backendTcp.destroyed) {
            backendTcp.destroy();
        }
    });
});

// --- 5. Heartbeat to Prune Dead Connections ---
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, CONSTANTS.HEARTBEAT_INTERVAL);

// --- 6. Main Application Logic ---
async function startServer() {
    try {
        await checkBackendServer();
        
        server.listen(PORT, () => {
            logger.info(`✅ Proxy is online and listening on port ${PORT}`);
        });

    } catch (error) {
        logger.fatal('Could not start proxy. The backend server check failed:', error.message);
    }
}

const gracefulShutdown = (signal) => {
    logger.warn(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(heartbeat);
    server.close(() => {
        logger.info('HTTP server closed.');
        wss.close(() => {
            logger.info('WebSocket server closed. Proxy shut down.');
            process.exit(0);
        });
    });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error, origin) => { logger.fatal(`UNCAUGHT EXCEPTION at: ${origin}`, error); });
process.on('unhandledRejection', (reason, promise) => { logger.fatal('UNHANDLED REJECTION at:', reason); });

// Start the application
startServer();
