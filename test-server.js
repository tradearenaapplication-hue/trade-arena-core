# Minimal test server for Railway debugging
const http = require('http');

const PORT = parseInt(process.env.PORT || '3001', 10);

console.log('[Boot] Minimal server starting on 0.0.0.0:' + PORT);
console.log('[Boot] NODE_ENV=' + (process.env.NODE_ENV || 'development'));
console.log('[Boot] PORT env=' + process.env.PORT);

const server = http.createServer((req, res) => {
    console.log('[Boot] Request received:', req.method, req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: Date.now(), port: PORT }));
});

server.on('error', (err) => {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
});

server.on('listening', () => {
    const addr = server.address();
    console.log('[Boot] Server listening on', addr);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Minimal test server running on port ${PORT}`);
});