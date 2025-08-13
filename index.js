// --- 0. Dependencies ---
const WebSocket = require('ws');
const http = require('http');
// Using chalk for colored console output makes logs much easier to read.
// Make sure to install it: npm install chalk@4
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
    // Standard WebSocket close codes
    CLOSE_NORMAL: 1000,
    CLOSE_GOING_AWAY: 1001,
    CLOSE_PROTOCOL_ERROR: 1002,
    CLOSE_INTERNAL_ERROR: 1011,
    // How often to check for dead connections (in milliseconds)
    HEARTBEAT_INTERVAL: 30000,
};

logger.info('----------------------------------------------------');
logger.info('Eaglercraft 1.12.2 Proxy Script - Enhanced Version');
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
const backend_server_ip = parts[0];
const backend_server_port = parseInt(parts[1], 10);

if (!backend_server_ip || isNaN(backend_server_port)) {
    logger.fatal(`SERVER variable "${server_address}" is not in the correct 'hostname:port' format.`);
}

const backendUrl = `ws://${backend_server_ip}:${backend_server_port}`;
logger.info(`Proxy will listen on port: ${PORT}`);
logger.info(`Backend Minecraft server URL: ${backendUrl}`);

// --- 2. Initializing the Server ---
const server = http.createServer((req, res) => {
    // A simple health check endpoint for deployment environments
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
    logger.info(`Received upgrade request from ${request.socket.remoteAddress}`);
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// --- 3. Handling a New Client Connection ---
wss.on('connection', (clientWs, req) => {
    const connectionId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const clientIp = req.socket.remoteAddress;

    logger.conn(connectionId, `➡️  New client connected from IP: ${clientIp}`);

    // Heartbeat mechanism: Mark client as alive
    clientWs.isAlive = true;
    clientWs.on('pong', () => {
        clientWs.isAlive = true;
        logger.conn(connectionId, `❤️  Received pong from client.`);
    });

    let backendWs;
    const messageBuffer = [];

    try {
        logger.conn(connectionId, `⚪ Attempting to connect to backend: ${backendUrl}`);
        backendWs = new WebSocket(backendUrl, {
            // Forward headers from the client that the backend might need
            headers: {
                'X-Forwarded-For': clientIp
            }
        });
    } catch (e) {
        logger.error(`[CONN-${connectionId}] ❌ CRITICAL: Failed to create WebSocket instance for backend.`, e);
        clientWs.close(CONSTANTS.CLOSE_INTERNAL_ERROR, 'Proxy failed to initiate backend connection.');
        return;
    }

    // --- Backend Event Handlers ---
    backendWs.on('open', () => {
        logger.conn(connectionId, `✅ Successfully connected to backend. Flushing ${messageBuffer.length} buffered messages...`);
        while (messageBuffer.length > 0) {
            const message = messageBuffer.shift();
            backendWs.send(message);
        }
        logger.conn(connectionId, `✅ Buffer flushed. Proxy is now transparent.`);
    });

    backendWs.on('message', (message) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(message);
        } else {
            logger.warn(`[CONN-${connectionId}] ⚠️ Client connection was closed. Dropping message from backend.`);
        }
    });

    backendWs.on('close', (code, reason) => {
        const reasonText = reason?.toString() || 'No reason given';
        logger.conn(connectionId, `🚫 Backend connection closed. Code: ${code}, Reason: ${reasonText}. Closing client connection.`);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason);
        }
    });

    backendWs.on('error', (error) => {
        logger.error(`[CONN-${connectionId}] ❌ Error on backend connection:`, error);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(CONSTANTS.CLOSE_INTERNAL_ERROR, 'Backend connection error.');
        }
    });

    // --- Client Event Handlers ---
    clientWs.on('message', (message) => {
        if (backendWs.readyState === WebSocket.OPEN) {
            backendWs.send(message);
        } else if (backendWs.readyState === WebSocket.CONNECTING) {
            logger.conn(connectionId, `🟡 Backend not ready. Buffering client message (${messageBuffer.length + 1}).`);
            messageBuffer.push(message);
        } else {
            logger.warn(`[CONN-${connectionId}] ⚠️ Backend connection was closed or errored. Dropping message from client.`);
        }
    });

    clientWs.on('close', (code, reason) => {
        const reasonText = reason?.toString() || 'No reason given';
        logger.conn(connectionId, `🚫 Client disconnected. Code: ${code}, Reason: ${reasonText}. Closing backend connection.`);
        if (backendWs && backendWs.readyState === WebSocket.OPEN) {
            backendWs.close(code, reason);
        }
    });

    clientWs.on('error', (error) => {
        logger.error(`[CONN-${connectionId}] ❌ Error on client connection:`, error);
        if (backendWs && backendWs.readyState === WebSocket.OPEN) {
            backendWs.close(CONSTANTS.CLOSE_INTERNAL_ERROR, 'Client connection error.');
        }
    });
});

wss.on('error', (error) => {
    logger.error('The main proxy WebSocket server encountered an error:', error);
});

// --- 4. Heartbeat to Prune Dead Connections ---
const heartbeat = setInterval(() => {
    logger.info(`Running heartbeat check on ${wss.clients.size} clients...`);
    wss.clients.forEach((ws) => {
        // Find the connectionId if possible (this is for logging only)
        // Note: This is an inefficient way to get the ID. For high performance, you'd attach the ID to the ws object itself.
        if (ws.isAlive === false) {
            logger.warn(`Client failed heartbeat check. Terminating connection.`);
            return ws.terminate();
        }
        ws.isAlive = false; // Set to false, expect a 'pong' to set it back to true
        ws.ping(() => {});
    });
}, CONSTANTS.HEARTBEAT_INTERVAL);

// --- 5. Start Server and Handle Shutdown ---
server.listen(PORT, () => {
    logger.info(`✅ HTTP/WebSocket server listening on port ${PORT}`);
});

const gracefulShutdown = (signal) => {
    logger.warn(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(heartbeat); // Stop the heartbeat
    wss.close(() => {
        logger.info('All WebSocket clients disconnected.');
        server.close(() => {
            logger.info('HTTP server shut down.');
            process.exit(0);
        });
    });

    // Forcefully terminate any remaining clients after a timeout
    setTimeout(() => {
        logger.error('Could not close connections in time, forcing shutdown.');
        process.exit(1);
    }, 5000); // 5-second timeout
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error, origin) => {
    logger.fatal(`UNCAUGHT EXCEPTION at: ${origin}`, error);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.fatal('UNHANDLED REJECTION at:', promise);
    logger.fatal('Reason:', reason);
});
