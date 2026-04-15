// ═══════════════════════════════════════════════════════════════
// CONVERSATION POLLER v2
// Polls ElevenLabs for completed conversations, saves transcript
// to Interview document in MongoDB, generates scorecard via OpenAI
// ═══════════════════════════════════════════════════════════════

import { listConversations, getConversationTranscript } from './elevenlabsService.js';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

// In-memory set of processed conversation IDs (persisted in DB too)
const processedConversations = new Set();

// Lazy model accessors — models are registered by server.js before polling starts
const getInterview = () => mongoose.models.Interview || mongoose.model('Interview');
const getCompany = () => mongoose.models.Company;

// Lazy scorecard function loader
let _generateScorecard = null;
let _scorecardLoaded = false;
async function loadScorecard() {
  if (_scorecardLoaded) return _generateScorecard;
  _scorecardLoaded = true;
  try {
    const llm = await import('./llmService.js');
    _generateScorecard = llm.generateScorecard || llm.default?.generateScorecard || null;
  } catch (e) {
    _generateScorecard = null;
  }
  return _generateScorecard;
}

async function initProcessedSet() {
  if (processedConversations.size > 0) return;
  const Interview = getInterview();
  if (!Interview) return;
  try {
    const processed = await Interview.find({ elevenlabsConversationId: { $exists: true } })
      .select('elevenlabsConversationId')
      .lean();
    processed.forEach(i => processedConversations.add(i.elevenlabsConversationId));
    logger.info(`Loaded ${processedConversations.size} processed conversations from DB`);
  } catch (e) {
    logger.error('Failed to init processed set:', { error: e.message });
  }
}

// ─── Main poll function (called on interval from server.js) ───
export async function pollCompletedConversations() {
  try {
    await initProcessedSet();

    // Fetch ALL conversations (no agent_id filter — we have per-org agents now)
    const data = await listConversations(30);
    const conversations = data.conversations || [];

    for (const conv of conversations) {
      if (processedConversations.has(conv.conversation_id)) continue;
      if (conv.status === 'processing' || conv.status === 'in-progress') continue;

      if (conv.status === 'done' || conv.status === 'completed' || conv.status === 'ended') {
        try {
          await processConversation(conv.conversation_id);
        } catch (err) {
          logger.error('Error processing conversation:', { id: conv.conversation_id, error: err.message });
        }
        // Always mark as processed to prevent infinite retry
        processedConversations.add(conv.conversation_id);
      }
    }
  } catch (error) {
    logger.error('Poll failed:', { error: error.message });
  }
}

// ─── Process a single conversation ───
async function processConversation(conversationId) {
  try {
    // Skip if already in DB
    const Interview = getInterview();
    if (!Interview) { logger.error('Interview model not registered'); return; }
    const existing = await Interview.findOne({ elevenlabsConversationId: conversationId });
    if (existing) {
      logger.info('Conversation already processed:', { conversationId });
      return;
    }

    logger.info('Processing new conversation:', { conversationId });
    const { transcript, duration } = await getConversationTranscript(conversationId);

    // Clean transcript — remove empty entries and disconnect noise
    const cleanTranscript = (transcript || []).filter(t =>
      t.text && t.text.trim() !== '' && t.text !== '...'
    );

    const cutoffIndex = cleanTranscript.findIndex(t =>
      t.text.includes('end the interview here') ||
      t.text.includes('lost connection') ||
      t.text.includes('seems like you might have stepped away')
    );
    const finalTranscript = cutoffIndex > 0
      ? cleanTranscript.slice(0, cutoffIndex + 1)
      : cleanTranscript;

    // Skip very short conversations (less than 4 meaningful entries)
    if (!finalTranscript || finalTranscript.length < 4) {
      logger.info('Skipping short conversation:', {
        conversationId,
        entries: finalTranscript?.length || 0
      });
      return;
    }

    // Count actual candidate responses
    const candidateResponses = finalTranscript.filter(
      t => t.speaker === 'candidate' && t.text.length > 5
    ).length;
    if (candidateResponses < 2) {
      logger.info('Skipping — too few candidate responses:', { conversationId, candidateResponses });
      return;
    }

    // Try to find the company (for scorecard context)
    const Company = mongoose.models.Company;
    const company = Company ? await Company.findOne({}) : null;

    // Detect candidate name from transcript
    const candidateName = detectCandidateName(finalTranscript);

    // Detect role from transcript
    const role = detectRoleFromTranscript(finalTranscript);

    // ─── Generate scorecard via OpenAI ───
    let scorecard = null;
    const scorecardFn = await loadScorecard();
    if (scorecardFn) {
      try {
        logger.info('Generating scorecard:', { conversationId });
        scorecard = await scorecardFn(finalTranscript, {
          role: role || 'General',
          company: company?.name || 'Unknown'
        });
      } catch (e) {
        logger.error('Scorecard generation failed:', { conversationId, error: e.message });
      }
    }

    // ─── Save Interview to MongoDB ───
    const interview = new Interview({
      elevenlabsConversationId: conversationId,
      candidateName: candidateName || 'Unknown Candidate',
      role: role || 'Open Position',
      company: company?._id,
      companyName: company?.name || 'Unknown',
      duration: duration || 0,
      status: 'completed',
      completedAt: new Date(),

      // THE KEY PART — save the full transcript array
      transcript: finalTranscript.map(t => ({
        speaker: t.speaker,  // 'ai' or 'candidate'
        text: t.text,
        timestamp: t.timestamp || 0
      })),

      // Save scorecard if generated
      scorecard: scorecard || null,
    });

    await interview.save();
    logger.info('Interview saved to DB:', {
      conversationId,
      interviewId: interview._id,
      candidateName,
      role,
      transcriptEntries: finalTranscript.length,
      hasScorecard: !!scorecard
    });

  } catch (error) {
    logger.error('processConversation failed:', { conversationId, error: error.message });
    throw error;
  }
}

// ─── Detect candidate name from transcript ───
function detectCandidateName(transcript) {
  // Look for early candidate responses that might contain a name
  const earlyResponses = transcript
    .filter(t => t.speaker === 'candidate')
    .slice(0, 3);

  for (const r of earlyResponses) {
    const text = r.text.trim();
    // Common patterns: "My name is John", "I'm John", "Hi, John here", just "John Smith"
    const nameMatch = text.match(/(?:my name is|i'm|i am|this is|it's|hey,?\s*i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (nameMatch) return nameMatch[1];

    // If it's a very short response (just a name), might be the name
    if (text.split(' ').length <= 3 && text.length < 30 && /^[A-Z]/.test(text)) {
      return text.replace(/[.,!?]$/g, '');
    }
  }
  return null;
}

// ─── Detect role from transcript ───
function detectRoleFromTranscript(transcript) {
  const aiMessages = transcript.filter(t => t.speaker === 'ai').slice(0, 5);
  const allText = aiMessages.map(t => t.text).join(' ');

  // Look for role mentions in AI's intro
  const roleMatch = allText.match(/(?:for the|for a|the)\s+([A-Z][^.!?]{3,40})\s+(?:position|role|opening|interview)/i);
  if (roleMatch) return roleMatch[1].trim();

  return null;
}

// ─── startPolling: called by server.js to begin the polling interval ───
export function startPolling(intervalMs = 60000) {
  logger.info(`Conversation poller starting (interval: ${intervalMs}ms)`);
  // Run once immediately, then on interval
  pollCompletedConversations();
  setInterval(pollCompletedConversations, intervalMs);
}

export { pollCompletedConversations };
export default { startPolling, pollCompletedConversations };
