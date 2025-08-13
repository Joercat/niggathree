const WebSocket = require('ws');
const http = require('http');

console.log('----------------------------------------------------');
console.log('[INFO] Eaglercraft 1.12.2 Proxy Script Started at ' + new Date().toISOString());
console.log('----------------------------------------------------');

// --- 1. Reading Environment Configuration ---
const server_address = process.env.SERVER;
const PORT = process.env.PORT || 10000;

console.log(`[CONFIG] Raw SERVER variable: "${server_address}"`);
console.log(`[CONFIG] Raw PORT variable: "${process.env.PORT}", will use: ${PORT}`);

if (!server_address) {
    console.error("[FATAL] The 'SERVER' environment variable is not set. Exiting.");
    process.exit(1);
}

const parts = server_address.split(':');
const backend_server_ip = parts[0];
const backend_server_port = parts[1];

if (!backend_server_ip || !backend_server_port) {
    console.error(`[FATAL] SERVER variable "${server_address}" is not in the correct 'hostname:port' format. Exiting.`);
    process.exit(1);
}

const backendUrl = `ws://${backend_server_ip}:${backend_server_port}`;
console.log(`[CONFIG] Parsed Backend URL: ${backendUrl}`);

// --- 2. Starting the Proxy Server ---
let wss;
let server;

try {
    // Create a standard HTTP server for a health check endpoint.
    server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    console.log(`[INFO] Attempting to start proxy server on port ${PORT}...`);
    // Attach the WebSocket server to the HTTP server
    wss = new WebSocket.Server({ server: server });

    server.listen(PORT, () => {
        console.log(`[WSS] ✅ Proxy server successfully started and listening on port ${PORT}.`);
    });

} catch (e) {
    console.error('[FATAL] Could not start proxy server:', e);
    process.exit(1);
}

wss.on('error', (error) => {
    console.error('[WSS-ERROR] The main proxy server encountered an error:', error);
});

// --- 3. Handling a New Client Connection ---
wss.on('connection', (ws, req) => {
    const connectionId = Math.random().toString(36).substr(2, 5);
    const clientIp = req.socket.remoteAddress;

    console.log(`\n[CONN-${connectionId}] ➡️ New client connected from IP: ${clientIp}`);

    let falixServer;
    const messageBuffer = []; // Buffer to hold messages until the backend is ready

    try {
        console.log(`[CONN-${connectionId}] ⚪ Attempting to connect to backend at: ${backendUrl}`);
        falixServer = new WebSocket(backendUrl);
    } catch (e) {
        console.error(`[CONN-${connectionId}] ❌ FATAL ERROR CREATING BACKEND SOCKET. This should not happen. Error:`, e);
        ws.close(1011, 'Internal proxy setup error.');
        return;
    }

    // --- Backend Event Handlers ---
    falixServer.on('open', () => {
        console.log(`[CONN-${connectionId}] ✅ Successfully connected to backend. Flushing buffered messages...`);
        // Flush the buffer once the connection is open
        while (messageBuffer.length > 0) {
            const message = messageBuffer.shift();
            falixServer.send(message);
        }
        console.log(`[CONN-${connectionId}] ✅ Buffer flushed. Ready for normal operation.`);
    });

    falixServer.on('message', (event) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(event.data);
        } else {
            console.log(`[CONN-${connectionId}] ⚠️ Client connection was not open. Dropping message from backend.`);
        }
    });

    falixServer.on('close', (code, reason) => {
        console.log(`[CONN-${connectionId}] 🚫 Backend connection closed. Code: ${code}, Reason: ${reason.toString()}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(code, reason);
        }
    });

    falixServer.on('error', (error) => {
        console.error(`[CONN-${connectionId}] ❌ ERROR on backend connection:`, error.message);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Backend connection error.');
        }
    });

    // --- Client Event Handlers ---
    ws.on('message', (message) => {
        if (falixServer.readyState === WebSocket.OPEN) {
            falixServer.send(message);
        } else {
            // Buffer the message if the backend isn't ready
            console.log(`[CONN-${connectionId}] 🟡 Backend not ready. Buffering client message (${messageBuffer.length + 1}).`);
            messageBuffer.push(message);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[CONN-${connectionId}] 🚫 Client disconnected. Code: ${code}, Reason: ${reason.toString()}`);
        if (falixServer && falixServer.readyState === WebSocket.OPEN) {
            falixServer.close(code, reason);
        }
    });

    ws.on('error', (error) => {
        console.error(`[CONN-${connectionId}] ❌ ERROR on client connection:`, error.message);
        if (falixServer && falixServer.readyState === WebSocket.OPEN) {
            falixServer.close(1011, 'Client connection error.');
        }
    });
});
