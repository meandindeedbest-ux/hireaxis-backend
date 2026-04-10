import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { logger } from './utils/logger.js';
import { connectDB } from './config/database.js';
import { authMiddleware } from './middleware/auth.js';
import { startPolling } from './services/conversationPoller.js';

// Route imports
import authRoutes from './routes/auth.js';
import roleRoutes from './routes/roles.js';
import interviewRoutes from './routes/interviews.js';
import candidateRoutes from './routes/candidates.js';
import webhookRoutes from './routes/webhooks.js';
import twilioRoutes from './routes/twilio.js';
import portalRoutes from './routes/portal.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';

const app = express();
app.set('trust proxy', 1);
const server = createServer(app);

// ─── Middleware ───
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }));
app.use(cors());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/twilio', express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));

// ─── Health Check ───
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'hireaxis-api', version: '1.0.0' });
});

// ─── Public Routes ───
app.use('/uploads', express.static('uploads'));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/twilio', twilioRoutes);
app.use('/api/webhooks', webhookRoutes);

// ─── Protected Routes ───
app.use('/api/roles', apiLimiter, authMiddleware, roleRoutes);
app.use('/api/interviews', apiLimiter, authMiddleware, interviewRoutes);
app.use('/api/candidates', apiLimiter, authMiddleware, candidateRoutes);
app.use('/api/analytics', apiLimiter, authMiddleware, analyticsRoutes);

// ─── Error Handler ───
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

// ─── Start ───
const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();

  server.listen(PORT, () => {
    logger.info(`HireAxis API running on port ${PORT}`);
    logger.info(`WebSocket endpoint: ws://localhost:${PORT}/media-stream`);

    // Start polling ElevenLabs for completed conversations every 30 seconds
    startPolling(30000);
    logger.info('Conversation poller started — checking ElevenLabs every 30s');
  });
}

start().catch(err => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
