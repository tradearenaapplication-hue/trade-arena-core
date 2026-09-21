const express = require('express');
const cors = require('cors');
const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    console.log('Anthropic status:', response.status, JSON.stringify(data).slice(0, 300));
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }

});

app.post('/api/openai', async (req, res) => {
  // For GPT models
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Proxy OpenAI error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/gemini', async (req, res) => {
  try {
    const model = req.body.model || 'gemini-1.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY || ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: req.body.contents,
        generationConfig: req.body.generationConfig
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Proxy Gemini error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const fs = require('fs');
const path = require('path');

/**
 * Helper to check if a requested path stays inside the base directory
 * Prevents path traversal vulnerabilities
 */
function isPathSafe(baseDir, targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const normalizedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(baseDir, targetPath);
  return resolvedTarget === normalizedBase || resolvedTarget.startsWith(normalizedBase + path.sep);
}

/**
 * In-memory rate-limiter middleware for route handlers
 * Prevents Denial of Service (DoS) and brute-force abuse on file system endpoints
 */
const rateLimitMap = new Map();

function rateLimiter(maxRequests = 30, windowMs = 60000) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const now = Date.now();
    const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };

    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + windowMs;
    }

    record.count += 1;
    rateLimitMap.set(ip, record);

    if (record.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }

    next();
  };
}

app.post('/api/maintenance/log', rateLimiter(30, 60000), (req, res) => {
  try {
    const { agent, message, level } = req.body || {};
    // SECURITY: Validate inputs to prevent crashes and null pointer dereferences
    if (!agent || typeof agent !== 'string' || !message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid log payload' });
    }

    const logDir = path.join(__dirname, '.jules');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const safeAgent = agent.toUpperCase() === 'SENTINEL' ? 'SENTINEL' : 'MAINTENANCE';
    const logFile = safeAgent === 'SENTINEL' ? 'sentinel.md' : 'maintenance.md';

    // SECURITY: Ensure log destination is within the target directory
    if (!isPathSafe(logDir, logFile)) {
      return res.status(403).json({ success: false, error: 'Access denied: Invalid log path' });
    }

    const logPath = path.join(logDir, logFile);
    const safeLevel = (typeof level === 'string' && level.trim()) ? level.trim().toUpperCase() : 'INFO';
    const entry = `\n## ${new Date().toISOString()} - [${safeLevel}] ${safeAgent}\n${message}\n`;
    fs.appendFileSync(logPath, entry);

    res.json({ success: true });
  } catch (error) {
    console.error('Proxy log error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/maintenance/patch', rateLimiter(30, 60000), async (req, res) => {
  const { filepath, patch, description } = req.body || {};
  try {
    // SECURITY: Sanitize filepath to prevent Path Traversal vulnerabilities before filesystem access
    if (!filepath || typeof filepath !== 'string') {
      return res.status(400).json({ error: 'Invalid filepath' });
    }
    const fullPath = path.resolve(__dirname, filepath);
    const relative = path.relative(__dirname, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return res.status(403).json({ error: 'Access denied: Invalid file path' });
    }
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // In a real self-healing system, we would validate the patch
    // For this implementation, we log the intent and could apply it
    console.log(`[Developer Agent] Patch requested for ${filepath}: ${description}`);

    // Simple overwrite for this demo-scale self-healing
    // fs.writeFileSync(resolvedPath, patch);

    res.json({ success: true, message: 'Patch received and logged for review' });
  } catch (error) {
    console.error('Proxy patch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const port = 3001;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`🚀 Proxy server running at http://localhost:${port}`);
    console.log('Set ANTHROPIC_API_KEY env var for Claude');
  });
}

module.exports = { app, isPathSafe };
