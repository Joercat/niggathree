const WebSocket = require('ws');
const WebSocketServer = require('ws').WebSocketServer;

// Read the server address and port from a single environment variable
const server_address = process.env.SERVER;

if (!server_address) {
  console.error("Error: The 'SERVER' environment variable must be set in the format 'hostname:port'.");
  process.exit(1);
}

// Split the string into hostname and port
const [backend_server_ip, backend_server_port] = server_address.split(':');

if (!backend_server_ip || !backend_server_port) {
  console.error("Error: The 'SERVER' environment variable is not in the correct 'hostname:port' format.");
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
