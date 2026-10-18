// Stands in for neko's WebSocket (ws://127.0.0.1:8099/api/ws) in the viewer end-to-end test. The
// Go agent's neko relay connects here; messages are passed to and from the fake neko page, which
// does the WebRTC media part in a real Chromium and records the ordered Neko control/* JSON.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const page = readFileSync(new URL('./fake-neko.html', import.meta.url));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
const wss = new WebSocketServer({ server, path: '/api/ws' });
let nekoPage = null;
let client = null;
wss.on('connection', (ws, req) => {
  if (new URL(req.url, 'http://x').searchParams.get('role') === 'page') {
    nekoPage = ws;
    ws.on('message', (m) => client?.send(m.toString()));
    console.log('fake neko page connected');
    return;
  }
  client = ws;
  console.log('agent relay connected');
  nekoPage?.send(JSON.stringify({ bridge: 'client_connected' }));
  ws.on('message', (m) => nekoPage?.send(m.toString()));
});
server.listen(Number(process.env.PORT ?? 8099), '127.0.0.1', () => console.log('neko bridge ready'));
