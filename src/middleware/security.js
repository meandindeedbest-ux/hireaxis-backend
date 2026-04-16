// ─── HireAxis Security Middleware ───────────────────────────────────────────
// Add this file to: src/middleware/security.js

import twilio from 'twilio';
import { logger } from '../utils/logger.js';

// ─── Twilio Webhook Signature Validation ────────────────────────────────────
// Rejects any request to Twilio routes that didn't come from Twilio's servers.
// Prevents attackers from spoofing calls/SMS to your webhooks.
export function validateTwilioSignature(req, res, next) {
  // Skip validation in development
  if (process.env.NODE_ENV !== 'production') return next();

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    logger.warn('[SECURITY] Twilio request missing signature', {
      ip: req.ip,
      path: req.path
    });
    return res.status(403).type('text/xml').send(
      '<Response><Say>Unauthorized</Say></Response>'
    );
  }

  const baseUrl = process.env.API_BASE_URL;
  const fullUrl = `${baseUrl}${req.originalUrl}`;

  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    fullUrl,
    req.body || {}
  );

  if (!valid) {
    logger.warn('[SECURITY] Invalid Twilio signature — possible spoofing attempt', {
      ip: req.ip,
      path: req.path,
      signature: signature.substring(0, 20) + '...'
    });
    return res.status(403).type('text/xml').send(
      '<Response><Say>Unauthorized</Say></Response>'
    );
  }

  next();
}

// ─── Admin Secret Header Validation ─────────────────────────────────────────
// All admin routes require this header in addition to JWT auth.
// Even if someone gets a JWT with role:admin, they still need this secret.
export function validateAdminSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    logger.warn('[SECURITY] Admin route accessed without valid secret', {
      ip: req.ip,
      path: req.path,
      hasHeader: !!secret
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ─── SSRF Protection for URL Fetching ────────────────────────────────────────
// Prevents attackers from using your scraper to probe internal services.
// Used in admin routes before fetching any user-supplied URL.
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',  // AWS/GCP metadata service
  '169.254.170.2',    // AWS ECS metadata
  '100.100.100.200',  // Alibaba Cloud metadata
  '192.168..',
  '10.',
  '172.16.',
  'internal',
  'intranet',
  'local',
];

const BLOCKED_PROTOCOLS = ['file:', 'ftp:', 'gopher:', 'dict:', 'ldap:'];

export function validateScraperUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`Protocol not allowed: ${parsed.protocol}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are allowed');
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const blocked of BLOCKED_HOSTS) {
    if (hostname === blocked || hostname.startsWith(blocked) || hostname.endsWith(blocked)) {
      throw new Error(`Host not allowed: ${hostname}`);
    }
  }

  // Block IP addresses that look like internal ranges
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error('Private IP ranges are not allowed');
    }
  }

  return parsed.href;
}

// ─── Audit Logger ─────────────────────────────────────────────────────────────
// Call this to log important security events to MongoDB.
// Usage: await auditLog(req, 'login', { email: 'user@example.com' })
import mongoose from 'mongoose';

const auditSchema = new mongoose.Schema({
  action: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, index: true },
  ip: String,
  userAgent: String,
  details: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 } // 90 day TTL
}, { timestamps: false });

let AuditLog;
function getAuditModel() {
  if (!AuditLog) {
    AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditSchema);
  }
  return AuditLog;
}

export async function auditLog(req, action, details = {}) {
  try {
    const Model = getAuditModel();
    await Model.create({
      action,
      userId: req.userId || null,
      companyId: req.companyId || null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      details
    });
  } catch (err) {
    // Never let audit logging crash the app
    logger.error('[AUDIT] Failed to write audit log:', { error: err.message, action });
  }
}
