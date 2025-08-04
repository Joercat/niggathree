const WebSocket = require('ws');
const WebSocketServer = require('ws').WebSocketServer;

// Read the IP address from the environment variable
const backend_server_ip = process.env.FALIX_SERVER_IP;

// Read the port from the environment variable
const backend_server_port = process.env.FALIX_SERVER_PORT;

if (!backend_server_ip || !backend_server_port) {
  console.error("Error: FALIX_SERVER_IP and FALIX_SERVER_PORT environment variables must be set.");
  process.exit(1);
}

const wss = new WebSocketServer({ port: process.env.PORT || 10000 });

console.log(`Render proxy starting on port ${process.env.PORT || 10000}`);
console.log(`Proxying to: ws://${backend_server_ip}:${backend_server_port}`);

wss.on('connection', ws => {
  console.log('Client connected to Render proxy. Establishing connection to backend...');

  const falixServer = new WebSocket(`ws://${backend_server_ip}:${backend_server_port}`);

  falixServer.onopen = () => {
    console.log('Successfully connected to backend server.');
  };

  falixServer.onclose = () => {
    console.log('Connection to backend server closed. Disconnecting client.');
    ws.close();
  };

  falixServer.onerror = (error) => {
    console.error('Error connecting to backend server:', error.message);
    ws.close();
  };

  ws.on('message', message => {
    if (falixServer.readyState === WebSocket.OPEN) {
      falixServer.send(message);
    }
  });

  falixServer.on('message', message => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from Render proxy. Closing backend connection.');
    if (falixServer.readyState === WebSocket.OPEN) {
      falixServer.close();
    }
  });
});
