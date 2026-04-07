import { logger } from '../utils/logger.js';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

function headers() {
  return {
    'xi-api-key': process.env.ELEVENLABS_API_KEY,
    'Content-Type': 'application/json'
  };
}

async function apiCall(method, path, body = null) {
  const options = { method, headers: headers() };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${ELEVENLABS_BASE}${path}`, options);
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('ElevenLabs API error:', { status: response.status, path, error: errorText });
    throw new Error(`ElevenLabs API error: ${response.status} — ${errorText}`);
  }
  return response.json();
}

// ─── Build a multi-role system prompt for the ElevenLabs agent ───
function buildMultiRolePrompt(roles) {
  if (!roles || roles.length === 0) {
    return 'You are an AI interviewer. No positions are currently available. Politely let the caller know and end the conversation.';
  }

  const roleList = roles.map(r => r.title).join(', ');

  let roleBlocks = '';
  for (const role of roles) {
    const questions = (role.questions || [])
      .sort((a, b) => a.order - b.order)
      .map((q, i) => `   ${i + 1}. ${q.text}`)
      .join('\n');

    roleBlocks += `
=== ${role.title.toUpperCase()} ===
Questions to ask (in order):
${questions}
Closing message: "${role.closingMessage || 'Thank you for your time. We will be in touch soon.'}"
Max duration: ${role.maxDurationMinutes || 30} minutes
---
`;
  }

  return `You are an AI interviewer for HireAxis. You conduct professional phone and video interviews.

STEP 1 — GREETING AND NAME:
When a caller connects, FIRST greet them warmly and ask for their full name.
Say: "Welcome to the HireAxis interview line! Before we begin, may I have your full name please?"
Wait for them to say their name. Remember it and use it throughout the interview.

STEP 2 — ROLE SELECTION:
After getting their name, tell them the available positions and ask which one they're interviewing for.
Say: "Thank you, [NAME]. We currently have openings for: ${roleList}. Which position are you interviewing for today?"
Wait for their answer. Match what they say to one of the roles below.

STEP 3 — CONDUCT THE INTERVIEW:
Once you know the role, use the questions listed below for that specific role. 

${roleBlocks}

INTERVIEW RULES:
- Ask ONE question at a time, then wait for the candidate to fully respond
- Listen carefully and acknowledge their answer naturally before moving on
- If an answer is vague or incomplete, ask a specific follow-up (max 2 follow-ups per question)
- Keep your responses concise — 2-3 sentences max
- Be warm, professional, and encouraging throughout
- Use the candidate's name occasionally (not every response)
- Adapt your tone based on the candidate's energy
- After all questions for the selected role, deliver the closing message
- Never reveal scores or evaluations to the candidate
- If the candidate goes off-topic, gently steer them back
- If the candidate asks which role to pick, briefly describe each one to help them decide`;
}

// ─── Sync ElevenLabs agent with ALL active roles ───
export async function syncAllRolesToAgent(roles) {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!agentId) {
    logger.warn('No ELEVENLABS_AGENT_ID set, skipping agent sync');
    return null;
  }

  const prompt = buildMultiRolePrompt(roles);
  const roleNames = roles.map(r => r.title);

  const firstMessage = roles.length === 1
    ? `Welcome to the HireAxis interview line! Before we begin, may I have your full name please?`
    : `Welcome to the HireAxis interview line! Before we begin, may I have your full name please?`;

  const updatePayload = {
    conversation_config: {
      agent: {
        prompt: {
          prompt: prompt
        },
        first_message: firstMessage,
        language: 'en'
      }
    }
  };

  try {
    const result = await apiCall('PATCH', `/convai/agents/${agentId}`, updatePayload);
    logger.info('Synced ElevenLabs agent with all roles:', { agentId, roles: roleNames, totalQuestions: roles.reduce((sum, r) => sum + (r.questions?.length || 0), 0) });
    return result;
  } catch (error) {
    logger.error('Failed to sync agent:', { error: error.message, roles: roleNames });
    throw error;
  }
}

// ─── Legacy: sync single role (kept for backward compat) ───
export async function syncAgentWithRole(role) {
  return syncAllRolesToAgent([role]);
}

// ─── Build interview prompt from a single role (used by poller for scoring) ───
export function buildInterviewPrompt(role) {
  const questionsList = role.questions
    .sort((a, b) => a.order - b.order)
    .map((q, i) => `${i + 1}. ${q.text}`)
    .join('\n');

  return `Interview for: ${role.title}\nQuestions:\n${questionsList}`;
}

// ─── List recent conversations ───
export async function listConversations(limit = 30) {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  try {
    return await apiCall('GET', `/convai/conversations?agent_id=${agentId}&page_size=${limit}`);
  } catch (error) {
    logger.error('Failed to list conversations:', { error: error.message });
    return { conversations: [] };
  }
}

// ─── Get full conversation with transcript ───
export async function getConversation(conversationId) {
  try {
    return await apiCall('GET', `/convai/conversations/${conversationId}`);
  } catch (error) {
    logger.error('Failed to get conversation:', { conversationId, error: error.message });
    throw error;
  }
}

// ─── Extract clean transcript from a conversation ───
export async function getConversationTranscript(conversationId) {
  const conversation = await getConversation(conversationId);

  if (!conversation?.transcript) return { transcript: [], duration: 0 };

  const transcript = conversation.transcript.map(entry => ({
    speaker: entry.role === 'agent' ? 'ai' : 'candidate',
    text: entry.message,
    timestamp: Math.round(entry.time_in_call_secs || 0)
  }));

  const duration = conversation.metadata?.call_duration_secs
    || (transcript.length > 0 ? transcript[transcript.length - 1].timestamp : 0);

  return {
    transcript,
    duration: Math.round(duration),
    status: conversation.status,
    conversationId
  };
}

// ─── Initiate Outbound Call ───
export async function initiateOutboundCall(agentId, phoneNumber, metadata = {}) {
  const payload = {
    agent_id: agentId || process.env.ELEVENLABS_AGENT_ID,
    agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
    to_number: phoneNumber,
    conversation_initiation_client_data: {
      dynamic_variables: {
        candidate_name: metadata.candidateName || 'the candidate',
        role_title: metadata.roleTitle || 'the position',
        company_name: metadata.companyName || 'our company',
        interview_id: metadata.interviewId || ''
      }
    }
  };

  const result = await apiCall('POST', '/convai/twilio/outbound-call', payload);
  logger.info('Initiated outbound call:', {
    agentId: agentId || process.env.ELEVENLABS_AGENT_ID,
    phoneNumber: phoneNumber.replace(/\d{4}$/, '****'),
    callId: result.call_id
  });
  return result;
}

// ─── List Voices ───
export async function listVoices() {
  const result = await apiCall('GET', '/voices');
  return result.voices?.map(v => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels,
    previewUrl: v.preview_url
  })) || [];
}

// ─── Signed URL for browser interviews ───
export async function getSignedAgentUrl(agentId) {
  const id = agentId || process.env.ELEVENLABS_AGENT_ID;
  const result = await apiCall('GET', `/convai/agents/${id}/link`);
  return result.signed_url;
}

export default {
  buildMultiRolePrompt,
  syncAllRolesToAgent,
  syncAgentWithRole,
  buildInterviewPrompt,
  listConversations,
  getConversation,
  getConversationTranscript,
  initiateOutboundCall,
  listVoices,
  getSignedAgentUrl
};
