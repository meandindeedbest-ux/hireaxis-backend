import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  order: { type: Number, required: true },
  text: { type: String, required: true },
  category: {
    type: String,
    enum: ['technical', 'behavioral', 'situational', 'motivation', 'culture', 'experience'],
    required: true
  },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  expectedTopics: [String],       // keywords the answer should touch on
  followUpLogic: String,          // LLM prompt for adaptive follow-ups
  maxDurationSeconds: { type: Number, default: 180 },
  weight: { type: Number, default: 1.0 },
  isRequired: { type: Boolean, default: true }
}, { _id: true });

const scoringDimensionSchema = new mongoose.Schema({
  name: { type: String, required: true },  // e.g. "technical", "communication"
  weight: { type: Number, default: 1.0 },
  description: String,
  rubric: {
    excellent: String,   // "90-100: Demonstrates deep expertise..."
    good: String,        // "70-89: Solid understanding..."
    adequate: String,    // "50-69: Basic knowledge..."
    poor: String         // "0-49: Insufficient..."
  }
}, { _id: true });

const roleSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  title: { type: String, required: true },
  department: String,
  description: String,           // full job description text
  status: { type: String, enum: ['active', 'paused', 'archived'], default: 'active' },

  // Interview configuration
  channel: {
    type: String,
    enum: ['phone', 'video', 'chat', 'any'],
    default: 'phone'
  },
  language: { type: String, default: 'en' },
  supportedLanguages: [String],
  voiceId: String,               // override company default
  maxDurationMinutes: { type: Number, default: 30 },

  // AI-generated interview plan
  systemPrompt: { type: String, required: true },  // the master prompt for the AI interviewer
  openingMessage: String,         // first thing the AI says
  closingMessage: String,         // wrap-up message
  questions: [questionSchema],
  scoringDimensions: [scoringDimensionSchema],

  // Adaptive behavior
  adaptiveFollowUps: { type: Boolean, default: true },
  maxFollowUpsPerQuestion: { type: Number, default: 2 },
  difficultyEscalation: { type: Boolean, default: true },

  // Red flags to probe
  redFlags: [String],
  dealBreakers: [String],

  // RAG knowledge base (company-specific context)
  knowledgeBase: [{
    title: String,
    content: String,
    source: String
  }],

  // Stats (denormalized for performance)
  stats: {
    totalCandidates: { type: Number, default: 0 },
    completedInterviews: { type: Number, default: 0 },
    averageScore: { type: Number, default: 0 },
    averageDuration: { type: Number, default: 0 }
  }
}, { timestamps: true });

roleSchema.index({ companyId: 1, status: 1 });

export const Role = mongoose.model('Role', roleSchema);
