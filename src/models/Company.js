import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const companySchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, unique: true, required: true },
  industry: String,
  apiKey: { type: String, unique: true, required: true },
  plan: { type: String, enum: ['trial', 'starter', 'pro', 'enterprise'], default: 'trial' },
  trial: {
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date, default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }, // 14 days
    interviewLimit: { type: Number, default: 20 },
    interviewsUsed: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  settings: {
    defaultVoiceId: { type: String, default: 'JBFqnCBsd6RMkjVDRZzb' },
    defaultLanguage: { type: String, default: 'en' },
    antiCheatEnabled: { type: Boolean, default: true },
    biasAuditEnabled: { type: Boolean, default: true },
    autoAdvanceThreshold: { type: Number, default: null },
    webhookUrl: String,
    brandColor: String,
    logoUrl: String
  },
  integrations: {
    twilio: { accountSid: String, authToken: String, phoneNumber: String },
    elevenlabs: { apiKey: String, agentId: String },
    ats: { provider: { type: String, enum: ['greenhouse', 'lever', 'workday', 'custom', null] }, apiKey: String, webhookUrl: String },
    slack: { webhookUrl: String, channelId: String }
  },
  usage: {
    interviewsThisMonth: { type: Number, default: 0 },
    minutesThisMonth: { type: Number, default: 0 },
    billingCycleStart: Date
  }
}, { timestamps: true });

// Virtual: days remaining in trial
companySchema.virtual('trial.daysRemaining').get(function() {
  if (this.plan !== 'trial' || !this.trial?.endDate) return null;
  const remaining = Math.ceil((this.trial.endDate - Date.now()) / (1000 * 60 * 60 * 24));
  return Math.max(0, remaining);
});

// Virtual: is trial expired
companySchema.virtual('trial.isExpired').get(function() {
  if (this.plan !== 'trial') return false;
  return Date.now() > this.trial?.endDate;
});

companySchema.set('toJSON', { virtuals: true });
companySchema.set('toObject', { virtuals: true });

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  role: { type: String, enum: ['admin', 'recruiter', 'viewer'], default: 'recruiter' },
  emailVerified: { type: Boolean, default: false },
  verificationCode: { type: String, default: null },
  verificationCodeExpiry: { type: Date, default: null }
}, { timestamps: true });

userSchema.methods.verifyPassword = async function(password) {
  return bcrypt.compare(password, this.passwordHash);
};

export const Company = mongoose.model('Company', companySchema);
export const User = mongoose.model('User', userSchema);
