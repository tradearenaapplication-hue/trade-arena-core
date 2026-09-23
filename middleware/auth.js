const crypto = require('crypto');

// Simple admin API key middleware for urgent hardening.
// Usage: set ADMIN_API_KEY env var to a strong random value, and send it via
// the X-ADMIN-API-KEY header or Authorization: Bearer <key>.

module.exports = function adminAuth(req, res, next) {
  try {
    const headerKey = (req.get('x-admin-api-key') || '').trim();
    const authHeader = req.get('authorization') || '';
    const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const provided = headerKey || bearerKey || '';

    const expected = process.env.ADMIN_API_KEY || '';
    if (!expected) {
      // Failsafe: if no admin key configured, block admin routes to avoid accidental exposure
      return res.status(503).json({ success: false, error: 'Admin auth not configured' });
    }

    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    return next();
  } catch (e) {
    console.error('[adminAuth] Error validating admin key:', e && e.message ? e.message : e);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
