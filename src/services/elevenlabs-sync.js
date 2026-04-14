// ═══════════════════════════════════════════════════════════════
// ELEVENLABS AGENT SYNC SERVICE v2
// Auto-creates/updates ElevenLabs agent per org with dynamic role
// ═══════════════════════════════════════════════════════════════

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const API_KEY = process.env.ELEVENLABS_API_KEY;

const VOICES = {
  rachel: { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — Warm, professional (F)" },
  sarah: { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah — Friendly, clear (F)" },
  adam: { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — Authoritative, calm (M)" },
  josh: { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh — Casual, warm (M)" },
  charlotte: { id: "XB0fDUnXU5powFXDhCwa", label: "Charlotte — Professional, British (F)" },
  daniel: { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel — Confident, deep (M)" },
};

function getVoiceId(org) {
  if (org.voice && VOICES[org.voice]) return VOICES[org.voice].id;
  const name = (org.interviewer?.name || "").toLowerCase();
  if (["sarah","rachel","charlotte","jessica","emily","anna","lisa","maria"].some(n => name.includes(n))) return VOICES.sarah.id;
  if (["adam","josh","daniel","michael","james","david","robert","alex"].some(n => name.includes(n))) return VOICES.adam.id;
  return VOICES.rachel.id;
}

function buildFirstMessage(org) {
  const n = org.interviewer?.name || "the hiring team";
  return `Hi there, welcome! I'm ${n} from ${org.name}. Thank you so much for joining us today for the {{role_title}} interview. I'm really looking forward to learning more about you. Could you start by telling me your name?`;
}

function buildPrompt(org) {
  const co = org.name;
  const iv = org.interviewer?.name || "Hiring Manager";

  let p = `You are ${iv}, a professional job interviewer at ${co}. You are conducting a live voice interview for the {{role_title}} position. Be warm, professional, and encouraging.

THE ROLE: You are interviewing for the {{role_title}} position at ${co}. Tailor ALL questions to this specific role. Ask questions that test the skills, knowledge, and experience needed for a {{role_title}}.

INTERVIEW STRUCTURE (20 minutes):
1. GREETING (1-2 min): Confirm their name. Mention the {{role_title}} role. Be warm.
2. BACKGROUND (3-4 min): Ask about relevant experience for {{role_title}}. Follow up.
3. ROLE-SPECIFIC QUESTIONS (8-10 min): 4-5 questions specific to {{role_title}}. If it's engineering, ask technical. If support, ask about customers. If sales, ask about closing. Start easy, get harder. Acknowledge answers before next question.
4. BEHAVIORAL (3-4 min): 1-2 situational questions relevant to {{role_title}} challenges.
5. CANDIDATE QUESTIONS (2-3 min): Let them ask about the {{role_title}} role or ${co}.
6. CLOSING (1 min): Thank them. Hiring team responds within 24-48 hours.

RULES:
- NEVER mention "HireAxis", "ElevenLabs", "AI", "artificial intelligence", or "language model".
- If asked "Are you real?": "I'm part of the hiring team at ${co}. Let's focus on you."
- If asked to reschedule: "Please reach out to our hiring team at ${co} directly."
- Keep responses to 2-3 sentences. Listen more than talk.
- Use: "Mmhmm", "Got it", "That makes sense", "Interesting"
- One question at a time. If short answer, probe deeper.
- If off topic, redirect gently.
- If nervous: "Take your time, no rush."

VOICE RULES:
- No bullet points, markdown, or code. Short conversational sentences.
- Write emails phonetically. Don't start with your name.`;

  if (org.interviewer?.personality) p += `\n\nPERSONALITY: ${org.interviewer.personality}`;
  if (org.about) p += `\n\nABOUT ${co.toUpperCase()}:\n${org.about}`;
  if (org.aiKnowledge?.companyInfo) p += `\n\nCOMPANY INFO:\n${org.aiKnowledge.companyInfo}`;
  if (org.aiKnowledge?.benefits) p += `\n\nBENEFITS:\n${org.aiKnowledge.benefits}`;
  if (org.aiKnowledge?.culture) p += `\n\nCULTURE:\n${org.aiKnowledge.culture}`;
  if (org.aiKnowledge?.faq) p += `\n\nFAQ:\n${org.aiKnowledge.faq}`;
  if (org.website) p += `\n\nWebsite: ${org.website}`;

  return p;
}

function buildBody(org) {
  return {
    name: `HireAxis — ${org.name}`,
    conversation_config: {
      agent: {
        first_message: buildFirstMessage(org),
        language: "en",
        dynamic_variables: {
          dynamic_variable_placeholders: {
            role_title: "Open Position",
            candidate_name: "Candidate",
            company_name: org.name,
          },
        },
        prompt: { prompt: buildPrompt(org), llm: "gpt-4o", temperature: 0.7, max_tokens: 200 },
      },
      tts: { voice_id: getVoiceId(org), model_id: "eleven_turbo_v2", stability: 0.5, similarity_boost: 0.75, optimize_streaming_latency: 3 },
      turn: { turn_timeout: 10, silence_end_call_timeout: 120, turn_eagerness: "normal" },
      conversation: { max_duration_seconds: 1200 },
    },
    platform_settings: {
      widget: { variant: "compact", avatar: { type: "orb", color_1: org.brand?.primaryColor || "#2563eb", color_2: org.brand?.accentColor || "#059669" } },
    },
  };
}

export async function createAgent(org) {
  if (!API_KEY) throw new Error("ELEVENLABS_API_KEY not set");
  const r = await fetch(`${ELEVENLABS_API}/convai/agents/create`, {
    method: "POST", headers: { "xi-api-key": API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(buildBody(org)),
  });
  if (!r.ok) throw new Error(`ElevenLabs create failed: ${r.status} — ${await r.text()}`);
  const d = await r.json();
  console.log(`[ELEVENLABS] Created agent for ${org.name}: ${d.agent_id}`);
  return d.agent_id;
}

export async function updateAgent(agentId, org) {
  if (!API_KEY) throw new Error("ELEVENLABS_API_KEY not set");
  const r = await fetch(`${ELEVENLABS_API}/convai/agents/${agentId}`, {
    method: "PATCH", headers: { "xi-api-key": API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(buildBody(org)),
  });
  if (!r.ok) throw new Error(`ElevenLabs update failed: ${r.status} — ${await r.text()}`);
  console.log(`[ELEVENLABS] Updated agent ${agentId} for ${org.name}`);
  return agentId;
}

export async function deleteAgent(agentId) {
  if (!API_KEY || !agentId) return;
  await fetch(`${ELEVENLABS_API}/convai/agents/${agentId}`, { method: "DELETE", headers: { "xi-api-key": API_KEY } });
  console.log(`[ELEVENLABS] Deleted agent ${agentId}`);
}

export async function syncAgentForOrg(org) {
  try {
    return org.agentId ? await updateAgent(org.agentId, org) : await createAgent(org);
  } catch (e) {
    console.error(`[ELEVENLABS] Sync failed for ${org.name}:`, e.message);
    return null;
  }
}

export function getAvailableVoices() {
  return Object.entries(VOICES).map(([key, v]) => ({ key, id: v.id, label: v.label }));
}
