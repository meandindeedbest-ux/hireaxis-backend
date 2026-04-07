import { logger } from '../utils/logger.js';
import { listConversations, getConversationTranscript } from './elevenlabsService.js';
import { generateScorecard } from './llmService.js';
import { Interview } from '../models/Interview.js';
import { Role } from '../models/Role.js';
import { Company } from '../models/Company.js';

// Track processed conversations in memory AND check database
const processedConversations = new Set();
let initialized = false;

// On first run, load all existing conversation IDs from DB so we don't reprocess them
async function initProcessedSet() {
  if (initialized) return;
  try {
    const existing = await Interview.find(
      { elevenlabsConversationId: { $exists: true, $ne: null } },
      'elevenlabsConversationId'
    ).lean();
    for (const i of existing) {
      if (i.elevenlabsConversationId) {
        processedConversations.add(i.elevenlabsConversationId);
      }
    }
    initialized = true;
    logger.info('Poller initialized — loaded processed conversations:', { count: processedConversations.size });
  } catch (e) {
    logger.error('Failed to init processed set:', { error: e.message });
  }
}

export async function pollCompletedConversations() {
  try {
    await initProcessedSet();

    const data = await listConversations(30);
    const conversations = data.conversations || [];

    for (const conv of conversations) {
      // Skip if already processed (in memory or DB)
      if (processedConversations.has(conv.conversation_id)) continue;

      // Skip if still in progress
      if (conv.status === 'processing' || conv.status === 'in-progress') continue;

      // Only process completed conversations
      if (conv.status === 'done' || conv.status === 'completed' || conv.status === 'ended') {
        try {
          await processConversation(conv.conversation_id);
        } catch (err) {
          logger.error('Error processing conversation:', { id: conv.conversation_id, error: err.message });
        }
        // ALWAYS mark as processed, even if it failed — prevents infinite loop
        processedConversations.add(conv.conversation_id);
      }
    }
  } catch (error) {
    logger.error('Poll failed:', { error: error.message });
  }
}

async function processConversation(conversationId) {
  try {
    // Double-check DB — another poll cycle might have processed it
    const existingInterview = await Interview.findOne({ elevenlabsConversationId: conversationId });
    if (existingInterview) {
      logger.debug('Already in DB, skipping:', { conversationId });
      return;
    }

    logger.info('Processing new conversation:', { conversationId });
    const { transcript, duration } = await getConversationTranscript(conversationId);

    // Clean transcript — remove empty entries and disconnect spam
    const cleanTranscript = (transcript || []).filter(t => t.text && t.text.trim() !== '' && t.text !== '...');
    const cutoffIndex = cleanTranscript.findIndex(t =>
      t.text.includes('end the interview here') ||
      t.text.includes('lost connection') ||
      t.text.includes('seems like you might have stepped away')
    );
    const finalTranscript = cutoffIndex > 0 ? cleanTranscript.slice(0, cutoffIndex + 1) : cleanTranscript;

    // Skip very short conversations (less than 4 meaningful entries)
    if (!finalTranscript || finalTranscript.length < 4) {
      logger.info('Skipping short conversation:', { conversationId, entries: finalTranscript?.length || 0 });
      return;
    }

    // Count actual candidate responses (not just AI talking)
    const candidateResponses = finalTranscript.filter(t => t.speaker === 'candidate' && t.text.length > 5).length;
    if (candidateResponses < 2) {
      logger.info('Skipping — too few candidate responses:', { conversationId, candidateResponses });
      return;
    }

    const company = await Company.findOne({});
    if (!company) return;

    // Detect role from transcript
    const role = await detectRoleFromTranscript(finalTranscript, company._id);
    if (!role) {
      logger.warn('Could not detect role:', { conversationId });
      return;
    }

    // Extract candidate name
    const candidateName = extractCandidateName(finalTranscript) || 'Inbound Caller';

    // Create interview record
    const interview = await Interview.create({
      companyId: company._id,
      roleId: role._id,
      candidate: { name: candidateName },
      channel: 'phone',
      status: 'in_progress',
      startedAt: new Date(Date.now() - (duration * 1000)),
      elevenlabsConversationId: conversationId,
      metadata: { source: 'inbound_call', customFields: { roleTitle: role.title } }
    });

    await Role.findByIdAndUpdate(role._id, { $inc: { 'stats.totalCandidates': 1 } });
    logger.info('Created interview:', { interviewId: interview._id, detectedRole: role.title, candidateName });

    // Generate scorecard
    logger.info('Generating scorecard:', { interviewId: interview._id, conversationId });

    let scorecard;
    try {
      scorecard = await generateScorecard({ ...interview.toObject(), transcript: finalTranscript }, role);
    } catch (scoreErr) {
      logger.error('Scorecard error:', { message: scoreErr.message });
      scorecard = {
        overallScore: 0, recommendation: 'consider', dimensionScores: [],
        aiSummary: 'Scorecard generation failed: ' + scoreErr.message,
        strengths: [], concerns: [], redFlagsDetected: [], dealBreakersTriggered: []
      };
    }

    // Update role stats
    try {
      const avgResult = await Interview.aggregate([
        { $match: { roleId: role._id, status: 'completed', 'scorecard.overallScore': { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$scorecard.overallScore' }, count: { $sum: 1 } } }
      ]);

      await Role.findByIdAndUpdate(role._id, {
        'stats.completedInterviews': (avgResult[0]?.count || 0) + 1,
        'stats.averageScore': Math.round(avgResult[0]?.avg || scorecard.overallScore),
        'stats.averageDuration': duration
      });
    } catch (e) {
      logger.warn('Failed to update role stats:', { error: e.message });
    }

    // Save completed interview
    await Interview.findByIdAndUpdate(interview._id, {
      transcript: finalTranscript,
      durationSeconds: duration,
      completedAt: new Date(),
      status: 'completed',
      scorecard
    });

    logger.info('Interview finalized:', {
      interviewId: interview._id,
      score: scorecard.overallScore,
      recommendation: scorecard.recommendation,
      role: role.title,
      candidate: candidateName
    });

  } catch (fatalError) {
    logger.error('FATAL in processConversation:', { conversationId, message: fatalError.message });
  }
}

// ─── Detect role from CANDIDATE's words and AI's questions ───
async function detectRoleFromTranscript(transcript, companyId) {
  const roles = await Role.find({ companyId, status: 'active' });
  if (roles.length === 0) return null;
  if (roles.length === 1) return roles[0];

  // ONLY check what the CANDIDATE said (first 10 entries)
  // The AI greeting mentions ALL roles, so we ignore AI text for title matching
  const candidateEntries = transcript
    .slice(0, 12)
    .filter(t => t.speaker === 'candidate');

  const candidateText = candidateEntries.map(t => t.text.toLowerCase()).join(' ');

  // Pass 1: exact role title in candidate's words
  for (const role of roles) {
    if (candidateText.includes(role.title.toLowerCase())) {
      logger.info('Role detected — candidate said title:', { roleTitle: role.title });
      return role;
    }
  }

  // Pass 2: key title words in candidate's words (need 2+ matches)
  for (const role of roles) {
    const words = role.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matches = words.filter(w => candidateText.includes(w)).length;
    if (matches >= 2 || (words.length === 1 && matches === 1)) {
      logger.info('Role detected — candidate title keywords:', { roleTitle: role.title, matches });
      return role;
    }
  }

  // Pass 3: match AI questions to role-specific questions
  // Only look at AI questions AFTER the greeting (skip first 2 AI messages which mention all roles)
  const aiMessages = transcript.filter(t => t.speaker === 'ai');
  const aiQuestionText = aiMessages.slice(2).map(t => t.text.toLowerCase()).join(' ');

  let bestRole = null;
  let bestScore = 0;

  for (const role of roles) {
    let score = 0;

    // Match distinctive question words (6+ chars to avoid common words)
    for (const q of role.questions || []) {
      const keyWords = q.text.toLowerCase().split(/\s+/).filter(w => w.length > 6);
      for (const word of keyWords) {
        if (aiQuestionText.includes(word)) score += 2;
      }
      // Match expected topics
      for (const topic of q.expectedTopics || []) {
        if (topic.length > 4 && aiQuestionText.includes(topic.toLowerCase())) score += 4;
      }
    }

    // PENALTY: if the candidate said something that clearly indicates a DIFFERENT role
    // e.g., candidate says "administrative" but this role is "Customer Support"
    const otherRoles = roles.filter(r => r._id.toString() !== role._id.toString());
    for (const other of otherRoles) {
      const otherTitle = other.title.toLowerCase();
      if (candidateText.includes(otherTitle)) {
        score -= 20; // Heavy penalty — candidate explicitly said another role
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }

  if (bestRole && bestScore > 5) {
    logger.info('Role detected — AI question matching:', { roleTitle: bestRole.title, score: bestScore });
    return bestRole;
  }

  // Last resort: check which role's questions appear most in the full transcript
  logger.warn('Weak role detection, using best guess:', { bestRole: bestRole?.title, score: bestScore });
  return bestRole || roles[0];
}

// ─── Extract candidate name ───
function extractCandidateName(transcript) {
  const candidateEntries = transcript
    .filter(t => t.speaker === 'candidate')
    .slice(0, 5);

  for (const entry of candidateEntries) {
    const text = entry.text;
    const patterns = [
      /(?:my name is|i'm|i am|this is|call me|it's|name's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
      /(?:my name is|i'm|i am|this is|call me|it's|name's)\s+([a-z]+(?:\s+[a-z]+)?)/i,
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[.,!]?\s*$/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1] && match[1].length > 1 && match[1].length < 40) {
        const name = match[1].trim();
        const skip = ['yes', 'no', 'hello', 'hi', 'hey', 'sure', 'okay', 'ok', 'yeah', 'thank', 'thanks',
          'good', 'fine', 'well', 'the', 'customer', 'support', 'administrative', 'assistant',
          'i', 'we', 'they', 'that', 'this', 'what', 'when', 'where', 'how', 'why'];
        if (skip.includes(name.toLowerCase())) continue;
        const formatted = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        return formatted;
      }
    }
  }
  return null;
}

// ─── Polling lifecycle ───
let pollingInterval = null;

export function startPolling(intervalMs = 30000) {
  if (pollingInterval) return;
  logger.info('Starting conversation poller:', { intervalMs });
  // Delay first run by 5 seconds to let server fully boot
  setTimeout(() => pollCompletedConversations(), 5000);
  pollingInterval = setInterval(pollCompletedConversations, intervalMs);
}

export function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    logger.info('Conversation poller stopped');
  }
}

export default { pollCompletedConversations, startPolling, stopPolling };
