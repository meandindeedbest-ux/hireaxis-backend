# HireAxis — AI Interview Engine

API-first interview platform with three delivery channels: phone (Twilio + ElevenLabs), video (WebRTC), and chat (SMS/WhatsApp). Built with structured output scoring and multi-tenant architecture.

## Architecture

```
Candidate ─→ Twilio (Phone) ──┐
Candidate ─→ WebRTC (Video) ──┼─→ ElevenLabs Conv. AI 2.0 ─→ LLM Orchestration ─→ Structured Scorecard
Candidate ─→ SMS/Chat ────────┘        (STT + TTS)            (Claude / GPT)          ↓
                                                                                   Webhook → ATS
                                                                                   Webhook → n8n
                                                                                   Dashboard API
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js + Express |
| Voice AI | ElevenLabs Conversational AI 2.0 |
| Telephony | Twilio Voice + Messaging |
| LLM | Anthropic Claude (primary) / OpenAI GPT (fallback) |
| Database | MongoDB + Mongoose |
| Queue | Redis + Bull |
| Automation | n8n webhooks |
| Auth | JWT + API keys |

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> && cd hireaxis-backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Start MongoDB and Redis
docker run -d -p 27017:27017 mongo:7
docker run -d -p 6379:6379 redis:7

# 4. Start the server
npm run dev
```

Server starts on `http://localhost:3000`

## API Reference

### Authentication

All protected endpoints require:
```
Authorization: Bearer <jwt_token>
```

**Register:**
```
POST /api/auth/register
{
  "companyName": "Acme Corp",
  "name": "Jane Doe",
  "email": "jane@acme.com",
  "password": "securepassword",
  "industry": "Technology"
}
→ { token, user, company: { apiKey } }
```

**Login:**
```
POST /api/auth/login
{ "email": "jane@acme.com", "password": "securepassword" }
→ { token, user }
```

---

### Roles (Interview Configuration)

**Create Role** — AI auto-generates the full interview plan:
```
POST /api/roles
{
  "title": "Senior Software Engineer",
  "department": "Engineering",
  "description": "Full job description text here...",
  "channel": "phone",          // phone | video | chat
  "language": "en",
  "maxDurationMinutes": 30
}

→ Returns complete role with AI-generated:
  - systemPrompt (interviewer personality + rules)
  - questions[] (ordered, categorized, weighted)
  - scoringDimensions[] (rubrics for each dimension)
  - openingMessage / closingMessage
  - redFlags[] / dealBreakers[]
```

**List Roles:** `GET /api/roles?status=active&page=1&limit=20`

**Get Role:** `GET /api/roles/:id`

**Update Role:** `PATCH /api/roles/:id`

**Regenerate Plan:** `POST /api/roles/:id/regenerate`

**Archive Role:** `DELETE /api/roles/:id`

---

### Interviews

**Create + Trigger Interview:**
```
POST /api/interviews
{
  "roleId": "role_id_here",
  "candidate": {
    "name": "Marcus Johnson",
    "email": "marcus@example.com",
    "phone": "+15551234567",
    "resumeUrl": "https://...",
    "metadata": { "linkedin": "..." }
  },
  "channel": "phone",
  "triggerNow": true,
  "callbackUrl": "https://yourapp.com/webhooks/hireaxis",
  "metadata": {
    "atsId": "greenhouse_12345",
    "requisitionId": "REQ-2026-0847",
    "source": "api"
  }
}

→ {
    "interview_id": "...",
    "status": "in_progress",  // call initiated immediately
    "channel": "phone",
    "candidate": "Marcus Johnson",
    "role": "Senior Software Engineer"
  }
```

**Schedule for Later:**
```
POST /api/interviews
{
  "roleId": "...",
  "candidate": { "name": "...", "phone": "..." },
  "scheduledAt": "2026-03-20T14:00:00Z"
}
```

**List Interviews:** `GET /api/interviews?roleId=...&status=completed&channel=phone`

**Get Full Interview:** `GET /api/interviews/:id`

**Get Transcript:** `GET /api/interviews/:id/transcript`

**Get Scorecard:** `GET /api/interviews/:id/scorecard`

**Cancel:** `POST /api/interviews/:id/cancel`

---

### Structured Scorecard Output

Every completed interview produces this scorecard:

```json
{
  "interview_id": "int_7xk2m9p",
  "candidate": "Marcus Johnson",
  "role": "Senior Software Engineer",
  "channel": "phone",
  "duration": 1934,
  "scorecard": {
    "overall": 84,
    "recommendation": "advance",
    "dimensions": {
      "technical_skills": {
        "score": 89,
        "evidence": ["Explained distributed system design with depth..."],
        "notes": "Strong grasp of Kafka, event-driven architecture..."
      },
      "communication": {
        "score": 78,
        "evidence": ["Clear explanations but occasionally verbose..."],
        "notes": "Articulate but could be more concise..."
      },
      "motivation": {
        "score": 82,
        "evidence": ["Expressed genuine interest in the problem space..."],
        "notes": "Aligned with company mission..."
      },
      "culture_fit": {
        "score": 86,
        "evidence": ["Values collaboration, mentioned pair programming..."],
        "notes": "Team-oriented mindset..."
      }
    },
    "ai_summary": "Marcus demonstrated strong technical depth...",
    "strengths": [
      "Deep expertise in distributed systems",
      "Clear problem-solving methodology"
    ],
    "concerns": [
      "Limited experience with frontend technologies",
      "Could improve conciseness in explanations"
    ],
    "red_flags": [],
    "deal_breakers": [],
    "suggested_next_steps": "Recommend for technical deep-dive round...",
    "integrity_score": 97
  }
}
```

---

### Candidates

**List with Filtering:**
```
GET /api/candidates?roleId=...&minScore=70&recommendation=advance&search=marcus
```

**Compare Side-by-Side:**
```
GET /api/candidates/compare?ids=id1,id2,id3
```

**Rankings for a Role:**
```
GET /api/candidates/rankings/:roleId
```

---

### Analytics

**Dashboard Summary:** `GET /api/analytics/dashboard`

**Scoring Trends:** `GET /api/analytics/scoring?roleId=...&days=30`

**Per-Role Performance:** `GET /api/analytics/roles/:roleId`

---

### Webhooks (Inbound)

**From ATS (auto-trigger interviews):**
```
POST /api/webhooks/ats/candidate
{
  "api_key": "hx_live_...",
  "candidate": {
    "name": "Jane Smith",
    "email": "jane@example.com",
    "phone": "+15551234567",
    "ats_id": "greenhouse_12345"
  },
  "role_id": "...",
  "trigger_immediately": true
}
```

**From n8n (batch operations):**
```
POST /api/webhooks/n8n
{
  "api_key": "hx_live_...",
  "action": "batch_trigger",
  "payload": {
    "role_id": "...",
    "candidates": [
      { "name": "Alice", "phone": "+1..." },
      { "name": "Bob", "phone": "+1..." }
    ]
  }
}
```

### Webhooks (Outbound)

When an interview completes, HireAxis delivers a webhook:

```
POST <your_callback_url>
Headers:
  X-HireAxis-Event: interview.completed
  X-HireAxis-Signature: <hmac_sha256>

Body: { full scorecard payload }
```

Retries: 3 attempts with exponential backoff (5s, 30s, 2min).

---

## Voice Pipeline (How a Phone Interview Works)

1. `POST /api/interviews` with `triggerNow: true`
2. Server calls ElevenLabs outbound API → ElevenLabs calls candidate via Twilio
3. Candidate answers → audio streams via WebSocket
4. ElevenLabs handles STT (speech-to-text) in real-time
5. Transcript sent to LLM for next response decision
6. LLM generates adaptive follow-up → ElevenLabs TTS speaks it
7. Loop continues through all questions
8. Call ends → full transcript sent to LLM for scorecard generation
9. Structured scorecard saved → webhook delivered → n8n triggered

Total latency per turn: ~500ms (ElevenLabs sub-100ms + LLM ~400ms)

---

## Project Structure

```
src/
├── server.js                  # Express + WebSocket setup
├── config/
│   └── database.js            # MongoDB connection
├── middleware/
│   └── auth.js                # JWT authentication
├── models/
│   ├── Company.js             # Multi-tenant company + users
│   ├── Role.js                # Interview configuration per position
│   └── Interview.js           # Interview records + scorecards
├── routes/
│   ├── auth.js                # Register / login
│   ├── roles.js               # CRUD + AI plan generation
│   ├── interviews.js          # Create, trigger, manage interviews
│   ├── candidates.js          # Search, compare, rank candidates
│   ├── twilio.js              # Twilio webhook handlers
│   ├── webhooks.js            # Inbound ATS + n8n webhooks
│   └── analytics.js           # Dashboard + scoring analytics
├── services/
│   ├── llmService.js          # Claude/GPT orchestration
│   ├── elevenlabsService.js   # ElevenLabs agent management
│   ├── twilioService.js       # Call management + TwiML
│   ├── mediaStream.js         # WebSocket audio bridge
│   └── webhookService.js      # Outbound webhook delivery
└── utils/
    └── logger.js              # Winston logging
```

## Estimated Cost Per Interview

| Component | 25-min interview |
|-----------|-----------------|
| ElevenLabs Voice AI | ~$2.50 |
| Twilio Telephony | ~$0.75 |
| LLM (Claude Sonnet) | ~$0.20 |
| Infrastructure | ~$0.05 |
| **Total** | **~$3.50** |

Suggested pricing: $15-25/interview or $500-2000/month unlimited per role.
