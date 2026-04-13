// ═══════════════════════════════════════════════════════════════
// ELEVENLABS AGENT SYNC SERVICE
// Auto-creates/updates an ElevenLabs agent per organization
// Called when org is saved in admin portal
// ═══════════════════════════════════════════════════════════════

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const API_KEY = process.env.ELEVENLABS_API_KEY;

// Available voices — add more from ElevenLabs voice library
const VOICES = {
  rachel: { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — Warm, professional (F)" },
  sarah: { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah — Friendly, clear (F)" },
  adam: { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — Authoritative, calm (M)" },
  josh: { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh — Casual, warm (M)" },
  charlotte: { id: "XB0fDUnXU5powFXDhCwa", label: "Charlotte — Professional, British (F)" },
  daniel: { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel — Confident, deep (M)" },
};

// Build the interview system prompt from org data
function buildInterviewPrompt(org) {
  const companyName = org.name;
  const interviewerName = org.interviewer?.name || "Hiring Manager";

  let prompt = `You are ${interviewerName}, a professional job interviewer at ${companyName}. You are conducting a live voice interview. Be warm, professional, and encouraging — like a senior hiring manager who genuinely wants to find great people.

INTERVIEW STRUCTURE (20 minutes total):
1. GREETING (1-2 min): The candidate has already heard your first message. Confirm their name and the role. Make them comfortable with light small talk.
2. BACKGROUND (3-4 min): Ask about their professional background. Listen actively and ask 1-2 follow-ups based on what they share.
3. ROLE-SPECIFIC QUESTIONS (8-10 min): Ask 4-5 relevant questions. Start easier, get harder. After each answer, acknowledge what they said before the next question.
4. BEHAVIORAL (3-4 min): Ask 1-2 situational questions. "Tell me about a time when..."
5. CANDIDATE QUESTIONS (2-3 min): Ask if they have questions. Answer using the company info below.
6. CLOSING (1 min): Thank them. The hiring team will review and respond within 24-48 hours.

CONVERSATION RULES:
- NEVER mention "HireAxis", "ElevenLabs", "AI", "artificial intelligence", or "language model". You are ${interviewerName} from ${companyName}.
- If asked "Are you a real person?" say: "I'm part of the hiring team here at ${companyName}. Let's focus on getting to know you — that's what matters today."
- If asked to reschedule, say: "I understand. Please reach out to our hiring team at ${companyName} directly and they'll find a better time."
- Keep responses SHORT — 2-3 sentences max. Listen more than you talk.
- Use natural acknowledgments: "Mmhmm", "Got it", "That makes sense", "Interesting"
- Show genuine interest: "Oh that's interesting", "I'd love to hear more about that"
- One question at a time, then listen.
- If short answer, probe: "Could you elaborate?" or "Can you give me a specific example?"
- If off topic, redirect gently: "That's great context. Coming back to the role, I'm curious about..."
- Transition naturally between topics.
- If candidate seems nervous: "Take your time, there's no rush"

VOICE OUTPUT RULES:
- Format for text-to-speech. No bullet points, no markdown, no code.
- Write emails phonetically: "team at ${companyName.toLowerCase().replace(/\s+/g, '')} dot com"
- Write URLs phonetically: "${companyName}'s website"
- Short, conversational sentences only.
- Don't start responses with your name or "Interviewer:".`;

  // Add company knowledge
  if (org.about) prompt += `\n\nABOUT ${companyName.toUpperCase()}:\n${org.about}`;
  if (org.aiKnowledge?.companyInfo) prompt += `\n\nCOMPANY INFORMATION:\n${org.aiKnowledge.companyInfo}`;
  if (org.aiKnowledge?.benefits) prompt += `\n\nBENEFITS & PERKS:\n${org.aiKnowledge.benefits}`;
  if (org.aiKnowledge?.culture) prompt += `\n\nCULTURE & VALUES:\n${org.aiKnowledge.culture}`;
  if (org.aiKnowledge?.faq) prompt += `\n\nFREQUENTLY ASKED QUESTIONS:\nWhen candidates ask these, use these answers:\n${org.aiKnowledge.faq}`;
  if (org.website) prompt += `\n\nCompany website: ${org.website}`;

  return prompt;
}

// Build the first message the AI says when call connects
function buildFirstMessage(org) {
  const interviewerName = org.interviewer?.name || "the hiring team";
  const companyName = org.name;
  return `Hi there, welcome! I'm ${interviewerName} from ${companyName}. Thank you so much for joining us today, I'm really glad you could make it. Before we get started, could you tell me your name?`;
}

// Get voice ID from org settings
function getVoiceId(org) {
  // If org has a specific voice selected
  if (org.voice && VOICES[org.voice]) return VOICES[org.voice].id;
  // Default based on interviewer name heuristic
  const name = (org.interviewer?.name || "").toLowerCase();
  if (name.includes("sarah") || name.includes("rachel") || name.includes("charlotte") || name.includes("jessica") || name.includes("emily") || name.includes("anna")) return VOICES.sarah.id;
  if (name.includes("adam") || name.includes("josh") || name.includes("daniel") || name.includes("michael") || name.includes("james")) return VOICES.adam.id;
  return VOICES.rachel.id; // Default: Rachel
}

// ═══════════════════════════════════════════
// CREATE a new ElevenLabs agent for an org
// ═══════════════════════════════════════════
export async function createAgent(org) {
  if (!API_KEY) throw new Error("ELEVENLABS_API_KEY not set");

  const prompt = buildInterviewPrompt(org);
  const firstMessage = buildFirstMessage(org);
  const voiceId = getVoiceId(org);

  const body = {
    name: `HireAxis — ${org.name}`,
    conversation_config: {
      agent: {
        first_message: firstMessage,
        language: "en",
        prompt: {
          prompt: prompt,
          llm: "gpt-4o",
          temperature: 0.7,
          max_tokens: 200,
        },
      },
      tts: {
        voice_id: voiceId,
        model_id: "eleven_turbo_v2",
        stability: 0.5,
        similarity_boost: 0.75,
        optimize_streaming_latency: 3,
      },
      turn: {
        turn_timeout: 10,
        silence_end_call_timeout: 120,
        turn_eagerness: "normal",
      },
      conversation: {
        max_duration_seconds: 1200, // 20 minutes
      },
    },
    platform_settings: {
      widget: {
        variant: "compact",
        avatar: {
          type: "orb",
          color_1: org.brand?.primaryColor || "#2563eb",
          color_2: org.brand?.accentColor || "#059669",
        },
      },
    },
  };

  const response = await fetch(`${ELEVENLABS_API}/convai/agents/create`, {
    method: "POST",
    headers: {
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs create failed: ${response.status} — ${err}`);
  }

  const data = await response.json();
  console.log(`[ELEVENLABS] Created agent for ${org.name}: ${data.agent_id}`);
  return data.agent_id;
}

// ═══════════════════════════════════════════
// UPDATE an existing ElevenLabs agent
// ═══════════════════════════════════════════
export async function updateAgent(agentId, org) {
  if (!API_KEY) throw new Error("ELEVENLABS_API_KEY not set");

  const prompt = buildInterviewPrompt(org);
  const firstMessage = buildFirstMessage(org);
  const voiceId = getVoiceId(org);

  const body = {
    name: `HireAxis — ${org.name}`,
    conversation_config: {
      agent: {
        first_message: firstMessage,
        language: "en",
        prompt: {
          prompt: prompt,
          llm: "gpt-4o",
          temperature: 0.7,
          max_tokens: 200,
        },
      },
      tts: {
        voice_id: voiceId,
        model_id: "eleven_turbo_v2",
        stability: 0.5,
        similarity_boost: 0.75,
        optimize_streaming_latency: 3,
      },
      turn: {
        turn_timeout: 10,
        silence_end_call_timeout: 120,
        turn_eagerness: "normal",
      },
      conversation: {
        max_duration_seconds: 1200,
      },
    },
    platform_settings: {
      widget: {
        variant: "compact",
        avatar: {
          type: "orb",
          color_1: org.brand?.primaryColor || "#2563eb",
          color_2: org.brand?.accentColor || "#059669",
        },
      },
    },
  };

  const response = await fetch(`${ELEVENLABS_API}/convai/agents/${agentId}`, {
    method: "PATCH",
    headers: {
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs update failed: ${response.status} — ${err}`);
  }

  console.log(`[ELEVENLABS] Updated agent ${agentId} for ${org.name}`);
  return agentId;
}

// ═══════════════════════════════════════════
// DELETE an ElevenLabs agent
// ═══════════════════════════════════════════
export async function deleteAgent(agentId) {
  if (!API_KEY || !agentId) return;

  const response = await fetch(`${ELEVENLABS_API}/convai/agents/${agentId}`, {
    method: "DELETE",
    headers: { "xi-api-key": API_KEY },
  });

  if (response.ok) {
    console.log(`[ELEVENLABS] Deleted agent ${agentId}`);
  }
}

// ═══════════════════════════════════════════
// SYNC — create or update agent for an org
// Called from admin routes when org is saved
// ═══════════════════════════════════════════
export async function syncAgentForOrg(org) {
  try {
    if (org.agentId) {
      // Update existing agent
      await updateAgent(org.agentId, org);
      return org.agentId;
    } else {
      // Create new agent
      const agentId = await createAgent(org);
      return agentId;
    }
  } catch (error) {
    console.error(`[ELEVENLABS] Sync failed for ${org.name}:`, error.message);
    // Don't throw — org save should still succeed even if agent sync fails
    return null;
  }
}

// Export available voices for admin portal dropdown
export function getAvailableVoices() {
  return Object.entries(VOICES).map(([key, val]) => ({
    key,
    id: val.id,
    label: val.label,
  }));
}
