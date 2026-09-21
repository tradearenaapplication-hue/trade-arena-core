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

app.post('/api/maintenance/log', (req, res) => {
  const { agent, message, level } = req.body;
  const logDir = path.join(__dirname, '.jules');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

  const logFile = agent === 'SENTINEL' ? 'sentinel.md' : 'maintenance.md';
  const logPath = path.join(logDir, logFile);

  const entry = `\n## ${new Date().toISOString()} - [${level || 'INFO'}] ${agent}\n${message}\n`;
  fs.appendFileSync(logPath, entry);

  res.json({ success: true });
});

app.post('/api/maintenance/patch', async (req, res) => {
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
