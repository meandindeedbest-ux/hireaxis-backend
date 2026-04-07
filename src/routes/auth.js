import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { Company, User } from '../models/Company.js';
import { generateToken } from '../middleware/auth.js';
import { sendVerificationEmail, sendWelcomeEmail } from '../services/emailService.js';
import { logger } from '../utils/logger.js';

const router = Router();

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { companyName, email, password, name, industry } = req.body;

    if (!companyName || !email || !password || !name) {
      return res.status(400).json({ error: 'companyName, email, password, and name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const apiKey = `hx_live_${uuid().replace(/-/g, '')}`;
    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const company = await Company.create({
      name: companyName, slug, industry, apiKey,
      plan: 'trial',
      trial: { startDate: new Date(), endDate: trialEnd, interviewLimit: 20, interviewsUsed: 0, isActive: true },
      settings: { defaultLanguage: 'en' },
      usage: { billingCycleStart: new Date() }
    });

    const verificationCode = generateVerificationCode();
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      email: email.toLowerCase(), passwordHash, name,
      companyId: company._id, role: 'admin',
      emailVerified: false,
      verificationCode,
      verificationCodeExpiry: new Date(Date.now() + 30 * 60 * 1000)
    });

    const token = generateToken({ userId: user._id, companyId: company._id, role: user.role });

    // Send verification email
    const emailResult = await sendVerificationEmail(email, name, verificationCode);

    logger.info('New registration:', { company: companyName, email, emailSent: emailResult.sent });

    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, emailVerified: false },
      company: {
        id: company._id, name: company.name, apiKey, plan: 'trial',
        trial: { daysRemaining: 14, interviewLimit: 20, interviewsUsed: 0, endDate: trialEnd }
      },
      verificationRequired: true,
      emailSent: emailResult.sent
    });
  } catch (error) {
    logger.error('Registration error:', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/verify
router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'email and code are required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ message: 'Email already verified', verified: true });
    if (user.verificationCode !== code) return res.status(400).json({ error: 'Invalid verification code' });
    if (user.verificationCodeExpiry && Date.now() > user.verificationCodeExpiry) {
      return res.status(400).json({ error: 'Code expired. Click "Resend code" to get a new one.' });
    }

    user.emailVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpiry = null;
    await user.save();

    // Send welcome email
    const company = await Company.findById(user.companyId);
    await sendWelcomeEmail(user.email, user.name, company?.name || 'your company');

    logger.info('Email verified:', { email });
    res.json({ message: 'Email verified successfully', verified: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/resend-code
router.post('/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ message: 'Email already verified' });

    const newCode = generateVerificationCode();
    user.verificationCode = newCode;
    user.verificationCodeExpiry = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const emailResult = await sendVerificationEmail(email, user.name, newCode);
    logger.info('Verification code resent:', { email, sent: emailResult.sent });

    res.json({ message: 'New verification code sent to your email', emailSent: emailResult.sent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const company = await Company.findById(user.companyId);

    let trialInfo = null;
    if (company?.plan === 'trial') {
      const daysRemaining = Math.max(0, Math.ceil((company.trial.endDate - Date.now()) / (1000 * 60 * 60 * 24)));
      trialInfo = {
        daysRemaining, interviewLimit: company.trial.interviewLimit,
        interviewsUsed: company.trial.interviewsUsed,
        endDate: company.trial.endDate, isExpired: daysRemaining === 0
      };
      if (daysRemaining === 0) { company.trial.isActive = false; await company.save(); }
    }

    const token = generateToken({ userId: user._id, companyId: user.companyId, role: user.role });

    // If not verified, resend code
    if (!user.emailVerified) {
      const newCode = generateVerificationCode();
      user.verificationCode = newCode;
      user.verificationCodeExpiry = new Date(Date.now() + 30 * 60 * 1000);
      await user.save();
      await sendVerificationEmail(email, user.name, newCode);
    }

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, emailVerified: user.emailVerified },
      company: { id: company?._id, name: company?.name, plan: company?.plan || 'trial', trial: trialInfo }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });

    const jwt = await import('jsonwebtoken');
    const decoded = jwt.default.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const company = await Company.findById(user.companyId);
    let trialInfo = null;
    if (company?.plan === 'trial') {
      const daysRemaining = Math.max(0, Math.ceil((company.trial.endDate - Date.now()) / (1000 * 60 * 60 * 24)));
      trialInfo = { daysRemaining, interviewLimit: company.trial.interviewLimit, interviewsUsed: company.trial.interviewsUsed, endDate: company.trial.endDate, isExpired: daysRemaining === 0 };
    }

    res.json({
      user: { id: user._id, name: user.name, email: user.email, role: user.role, emailVerified: user.emailVerified },
      company: { id: company?._id, name: company?.name, plan: company?.plan, trial: trialInfo }
    });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

export default router;
