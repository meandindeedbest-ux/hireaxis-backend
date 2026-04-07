import mongoose from 'mongoose';

const transcriptEntrySchema = new mongoose.Schema({
  speaker: { type: String, enum: ['ai', 'candidate'], required: true },
  text: { type: String, required: true },
  timestamp: { type: Number, required: true },  // seconds from start
  questionId: mongoose.Schema.Types.ObjectId,     // links to which question was being asked
  sentiment: String,                               // detected sentiment
  confidence: Number                               // STT confidence score
}, { _id: true });

const dimensionScoreSchema = new mongoose.Schema({
  dimension: { type: String, required: true },
  score: { type: Number, required: true, min: 0, max: 100 },
  evidence: [String],            // specific quotes/moments supporting the score
  notes: String                  // AI-generated notes for this dimension
}, { _id: false });

const questionResponseSchema = new mongoose.Schema({
  questionId: mongoose.Schema.Types.ObjectId,
  questionText: String,
  responseText: String,
  responseStartTime: Number,
  responseDuration: Number,
  followUps: [{
    aiText: String,
    candidateText: String,
    timestamp: Number
  }],
  score: Number,
  evaluation: String             // AI evaluation of this specific answer
}, { _id: true });

const interviewSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true, index: true },

  // Candidate info
  candidate: {
    name: { type: String, required: true },
    email: String,
    phone: String,
    resumeUrl: String,
    metadata: mongoose.Schema.Types.Mixed  // any extra data from ATS
  },

  // Interview execution
  channel: { type: String, enum: ['phone', 'video', 'chat'], required: true },
  status: {
    type: String,
    enum: ['scheduled', 'in_progress', 'completed', 'cancelled', 'failed', 'no_show'],
    default: 'scheduled',
    index: true
  },
  scheduledAt: Date,
  startedAt: Date,
  completedAt: Date,
  durationSeconds: Number,

  // Telephony details
  twilioCallSid: String,
  twilioRecordingUrl: String,
  elevenlabsConversationId: String,

  // Conversation data
  transcript: [transcriptEntrySchema],
  questionResponses: [questionResponseSchema],
  currentQuestionIndex: { type: Number, default: 0 },

  // ─── STRUCTURED SCORECARD (the money output) ───
  scorecard: {
    overallScore: { type: Number, min: 0, max: 100 },
    recommendation: {
      type: String,
      enum: ['strong_advance', 'advance', 'consider', 'reject', null]
    },
    dimensionScores: [dimensionScoreSchema],
    aiSummary: String,              // 2-3 paragraph AI assessment
    strengths: [String],
    concerns: [String],
    redFlagsDetected: [String],
    dealBreakersTriggered: [String],
    suggestedNextSteps: String,

    // Integrity signals
    integrityScore: Number,
    integrityFlags: [{
      type: { type: String },       // 'proxy_suspected', 'scripted_answers', 'voice_inconsistency'
      confidence: Number,
      evidence: String
    }]
  },

  // External references
  metadata: {
    atsId: String,                  // ID in the customer's ATS
    requisitionId: String,
    source: String,                 // 'api', 'dashboard', 'n8n', 'ats_webhook'
    customFields: mongoose.Schema.Types.Mixed
  },

  // Webhook delivery tracking
  webhookDelivery: {
    url: String,
    deliveredAt: Date,
    attempts: { type: Number, default: 0 },
    lastStatus: Number,
    lastError: String
  }
}, { timestamps: true });

interviewSchema.index({ companyId: 1, status: 1, scheduledAt: -1 });
interviewSchema.index({ companyId: 1, roleId: 1, 'scorecard.overallScore': -1 });

export const Interview = mongoose.model('Interview', interviewSchema);
