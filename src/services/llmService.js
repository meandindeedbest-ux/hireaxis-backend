import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from '../utils/logger.js';

// ─── LLM Client Factory ───
function getClient() {
  if (process.env.LLM_PROVIDER === 'openai') {
    return { provider: 'openai', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
  }
  return { provider: 'anthropic', client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) };
}

async function complete(systemPrompt, userMessage, options = {}) {
  const { provider, client } = getClient();
  const { temperature = 0.7, maxTokens = 4096, jsonMode = false } = options;

  try {
    if (provider === 'anthropic') {
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });
      return response.content[0].text;
    } else {
      const response = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        max_tokens: maxTokens,
        temperature,
        response_format: jsonMode ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      });
      return response.choices[0].message.content;
    }
  } catch (error) {
    logger.error('LLM completion failed:', { provider, error: error.message });
    throw error;
  }
}

// ─── Generate Interview Plan from Job Description ───
export async function generateInterviewPlan(jobTitle, jobDescription, options = {}) {
  const { channel = 'phone', language = 'en', duration = 30 } = options;

  const systemPrompt = `You are an expert hiring manager and interview designer. Given a job title and description, generate a comprehensive, structured interview plan.

You must respond with ONLY valid JSON (no markdown, no backticks) in this exact format:
{
  "systemPrompt": "The complete system prompt for the AI interviewer conducting this interview. Include personality, tone, company context, and interview rules. This should be 200-400 words and read naturally.",
  "openingMessage": "The first thing the AI interviewer says when the call connects. Warm, professional, 2-3 sentences.",
  "closingMessage": "The wrap-up message. Thank them, explain next steps, 2-3 sentences.",
  "questions": [
    {
      "order": 1,
      "text": "The interview question",
      "category": "technical|behavioral|situational|motivation|culture|experience",
      "difficulty": "easy|medium|hard",
      "expectedTopics": ["keyword1", "keyword2"],
      "followUpLogic": "Instructions for the AI on when and how to follow up on this question",
      "maxDurationSeconds": 180,
      "weight": 1.0,
      "isRequired": true
    }
  ],
  "scoringDimensions": [
    {
      "name": "dimension_name",
      "weight": 1.0,
      "description": "What this dimension measures",
      "rubric": {
        "excellent": "90-100: Description of excellent performance",
        "good": "70-89: Description of good performance", 
        "adequate": "50-69: Description of adequate performance",
        "poor": "0-49: Description of poor performance"
      }
    }
  ],
  "redFlags": ["Things that should raise concern"],
  "dealBreakers": ["Absolute disqualifiers"]
}

Rules:
- Generate ${Math.floor(duration / 3)} questions that fit in a ${duration}-minute interview
- Start with easy/warm-up questions, escalate difficulty
- Mix question categories: at least 2 technical, 2 behavioral, 1 motivation, 1 culture fit
- Scoring dimensions should be 4-6 dimensions relevant to this specific role
- The system prompt should instruct the AI to be conversational, empathetic, and adaptive
- Channel is "${channel}" — adjust tone accordingly (phone = more conversational, video = acknowledge visual, chat = concise)
- Interview language: ${language}`;

  const userMessage = `Job Title: ${jobTitle}\n\nJob Description:\n${jobDescription}`;

  const result = await complete(systemPrompt, userMessage, { temperature: 0.6, maxTokens: 6000 });

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    logger.error('Failed to parse interview plan JSON:', { error: error.message, raw: result.substring(0, 500) });
    throw new Error('Failed to generate valid interview plan. Please try again.');
  }
}

// ─── Generate Real-Time Response During Interview ───
export async function generateInterviewResponse(context) {
  const {
    systemPrompt,
    transcript,
    currentQuestion,
    questionsRemaining,
    candidateName,
    elapsedSeconds,
    maxDurationSeconds
  } = context;

  const conversationHistory = transcript.map(t =>
    `${t.speaker === 'ai' ? 'Interviewer' : candidateName}: ${t.text}`
  ).join('\n');

  const timeRemaining = maxDurationSeconds - elapsedSeconds;
  const shouldWrapUp = timeRemaining < 120 || questionsRemaining <= 1;

  const userMessage = `CONVERSATION SO FAR:
${conversationHistory}

CURRENT STATE:
- Current question: ${currentQuestion?.text || 'None — need to ask next question'}
- Questions remaining: ${questionsRemaining}
- Time elapsed: ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s
- Time remaining: ${Math.floor(timeRemaining / 60)}m
${shouldWrapUp ? '- IMPORTANT: Time is running low. Begin wrapping up.' : ''}

INSTRUCTIONS:
Based on the candidate's last response, decide your next action:
1. If the answer was shallow, ask a targeted follow-up (max 2 follow-ups per question)
2. If the answer was sufficient, acknowledge it naturally and transition to the next question
3. If wrapping up, deliver the closing message

Respond with ONLY valid JSON:
{
  "action": "follow_up|next_question|wrap_up",
  "response": "What the interviewer says next",
  "liveScoring": {
    "currentQuestionScore": 0-100,
    "dimensionUpdates": { "dimension_name": score }
  },
  "flags": ["any red flags or notable observations"],
  "shouldProbe": "description of what to probe deeper if anything, or null"
}`;

  const result = await complete(systemPrompt, userMessage, {
    temperature: 0.7,
    maxTokens: 1500
  });

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    logger.error('Failed to parse interview response:', { error: error.message });
    // Fallback: just move to next question
    return {
      action: 'next_question',
      response: "That's a great point, thank you for sharing that. Let me move on to my next question.",
      liveScoring: { currentQuestionScore: 50, dimensionUpdates: {} },
      flags: [],
      shouldProbe: null
    };
  }
}

// ─── Generate Final Scorecard ───
export async function generateScorecard(interview, role) {
  const systemPrompt = `You are an expert hiring assessor. Given a complete interview transcript and the scoring rubric, generate a comprehensive, fair, and evidence-based scorecard.

Be specific — cite exact moments from the transcript as evidence for your scores. Be balanced — note both strengths and concerns honestly. Your assessment directly impacts hiring decisions, so accuracy and fairness are paramount.

Respond with ONLY valid JSON in this exact format:
{
  "overallScore": 0-100,
  "recommendation": "strong_advance|advance|consider|reject",
  "dimensionScores": [
    {
      "dimension": "dimension_name",
      "score": 0-100,
      "evidence": ["Direct quote or paraphrase from transcript supporting score"],
      "notes": "Detailed assessment for this dimension"
    }
  ],
  "aiSummary": "2-3 paragraph comprehensive assessment of the candidate",
  "strengths": ["Specific strength with example"],
  "concerns": ["Specific concern with example"],
  "redFlagsDetected": ["Any red flags observed, or empty array"],
  "dealBreakersTriggered": ["Any deal breakers hit, or empty array"],
  "suggestedNextSteps": "Recommendation for what the hiring team should do next",
  "integrityScore": 0-100,
  "integrityFlags": []
}`;

  const transcript = interview.transcript.map(t =>
    `[${Math.floor(t.timestamp / 60)}:${String(t.timestamp % 60).padStart(2, '0')}] ${t.speaker === 'ai' ? 'Interviewer' : interview.candidate.name}: ${t.text}`
  ).join('\n');

  const scoringRubric = role.scoringDimensions.map(d =>
    `${d.name} (weight: ${d.weight}): ${d.description}\n  Excellent: ${d.rubric.excellent}\n  Good: ${d.rubric.good}\n  Adequate: ${d.rubric.adequate}\n  Poor: ${d.rubric.poor}`
  ).join('\n\n');

  const userMessage = `ROLE: ${role.title}
DEPARTMENT: ${role.department || 'N/A'}

SCORING RUBRIC:
${scoringRubric}

RED FLAGS TO WATCH FOR:
${role.redFlags?.join(', ') || 'None specified'}

DEAL BREAKERS:
${role.dealBreakers?.join(', ') || 'None specified'}

FULL INTERVIEW TRANSCRIPT:
${transcript}

INTERVIEW DURATION: ${Math.floor(interview.durationSeconds / 60)} minutes
CHANNEL: ${interview.channel}

Generate the complete scorecard now.`;

  const result = await complete(systemPrompt, userMessage, {
    temperature: 0.3,  // low temperature for consistent scoring
    maxTokens: 4000
  });

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    logger.error('Failed to parse scorecard:', { error: error.message });
    throw new Error('Failed to generate scorecard');
  }
}

export default { generateInterviewPlan, generateInterviewResponse, generateScorecard };
