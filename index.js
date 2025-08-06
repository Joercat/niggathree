
const WebSocket = require('ws');

console.log('----------------------------------------------------');
console.log('[INFO] PROXY SCRIPT STARTED at ' + new Date().toISOString());
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

console.log(`[CONFIG] Parsed Backend Host: ${backend_server_ip}`);
console.log(`[CONFIG] Parsed Backend Port: ${backend_server_port}`);

// --- 2. Starting the Proxy Server ---
let wss;
try {
  console.log(`[WSS] Attempting to start proxy server on port ${PORT}...`);
  wss = new WebSocket.Server({ port: PORT });
  console.log(`[WSS] ✅ Proxy server successfully started.`);
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
  const backendUrl = `ws://${backend_server_ip}:${backend_server_port}`;

  try {
    console.log(`[CONN-${connectionId}] ⚪ Attempting to connect to backend at: ${backendUrl}`);
    falixServer = new WebSocket(backendUrl);
  } catch (e) {
    console.error(`[CONN-${connectionId}] ❌ FATAL ERROR CREATING BACKEND SOCKET. This should not happen. Error:`, e);
    ws.close(1011, 'Internal proxy setup error.');
    return;
  }
  
  // -- Event Handlers for the connection TO THE BACKEND --
  falixServer.on('open', () => {
    console.log(`[CONN-${connectionId}] ✅ Successfully connected to backend.`);
  });

  falixServer.on('message', (event) => {
    console.log(`[CONN-${connectionId}] 📩 [BACKEND SAYS]: Received message. Type: ${typeof event.data}. Forwarding to client.`);
    // The .data property is crucial here.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(event.data);
    } else {
       console.log(`[CONN-${connectionId}] ⚠️ Client connection was not open. Could not forward backend message.`);
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


  // -- Event Handlers for the connection FROM THE CLIENT --
  ws.on('message', (message) => {
    console.log(`[CONN-${connectionId}] 📩 [CLIENT SAYS]: Received message. Forwarding to backend.`);
    if (falixServer.readyState === WebSocket.OPEN) {
      falixServer.send(message);
    } else {
      console.log(`[CONN-${connectionId}] ⚠️ Backend connection was not open. Could not forward client message.`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[CONN-${connectionId}] 🚫 Client disconnected. Code: ${code}, Reason: ${reason.toString()}`);
    if (falixServer.readyState === WebSocket.OPEN) {
      falixServer.close(code, reason);
    }
  });

  ws.on('error', (error) => {
    console.error(`[CONN-${connectionId}] ❌ ERROR on client connection:`, error.message);
    if (falixServer.readyState === WebSocket.OPEN) {
      falixServer.close(1011, 'Client connection error.');
    }
  });
});
