import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.companyId = decoded.companyId;
    next();
  } catch (error) {
    logger.warn('Auth failed:', { error: error.message });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function generateToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}
