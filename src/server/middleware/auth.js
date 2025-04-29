/**
 * JWT guard
 * Add to any route that needs authentication:
 *    const guard = require('../middleware/auth');
 *    app.get('/api/secure', guard, (req,res)=>res.json({ok:true}));
 */

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

module.exports = function authGuard(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
};
