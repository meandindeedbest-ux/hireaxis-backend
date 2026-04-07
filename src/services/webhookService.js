import { logger } from '../utils/logger.js';
import { Interview } from '../models/Interview.js';
import { Company } from '../models/Company.js';
import crypto from 'crypto';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [5000, 30000, 120000]; // 5s, 30s, 2min

// ─── Deliver Interview Completion Webhook ───
export async function deliverWebhook(interview) {
  const company = await Company.findById(interview.companyId);
  const webhookUrl = interview.webhookDelivery?.url
    || company?.settings?.webhookUrl
    || process.env.DEFAULT_WEBHOOK_URL;

  if (!webhookUrl) {
    logger.debug('No webhook URL configured, skipping delivery');
    return;
  }

  const payload = {
    event: 'interview.completed',
    interview_id: interview._id.toString(),
    timestamp: new Date().toISOString(),
    candidate: {
      name: interview.candidate.name,
      email: interview.candidate.email,
      phone: interview.candidate.phone
    },
    role: {
      id: interview.roleId.toString(),
      title: interview.metadata?.customFields?.roleTitle
    },
    channel: interview.channel,
    duration_seconds: interview.durationSeconds,
    scorecard: {
      overall: interview.scorecard?.overallScore,
      recommendation: interview.scorecard?.recommendation,
      dimensions: interview.scorecard?.dimensionScores?.reduce((acc, d) => {
        acc[d.dimension] = d.score;
        return acc;
      }, {}),
      ai_summary: interview.scorecard?.aiSummary,
      strengths: interview.scorecard?.strengths,
      concerns: interview.scorecard?.concerns,
      red_flags: interview.scorecard?.redFlagsDetected,
      deal_breakers: interview.scorecard?.dealBreakersTriggered,
      suggested_next_steps: interview.scorecard?.suggestedNextSteps,
      integrity_score: interview.scorecard?.integrityScore
    },
    transcript_url: `${process.env.API_BASE_URL}/api/interviews/${interview._id}/transcript`,
    recording_url: interview.twilioRecordingUrl || null,
    metadata: interview.metadata
  };

  await attemptDelivery(interview._id, webhookUrl, payload, 0);
}

async function attemptDelivery(interviewId, url, payload, attempt) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HireAxis-Event': 'interview.completed',
        'X-HireAxis-Signature': generateSignature(payload),
        'User-Agent': 'HireAxis-Webhook/1.0'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    await Interview.findByIdAndUpdate(interviewId, {
      'webhookDelivery.deliveredAt': new Date(),
      'webhookDelivery.attempts': attempt + 1,
      'webhookDelivery.lastStatus': response.status,
      'webhookDelivery.url': url
    });

    if (response.ok) {
      logger.info('Webhook delivered:', { interviewId, url, status: response.status });
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    logger.warn('Webhook delivery failed:', {
      interviewId, url, attempt: attempt + 1, error: error.message
    });

    await Interview.findByIdAndUpdate(interviewId, {
      'webhookDelivery.attempts': attempt + 1,
      'webhookDelivery.lastError': error.message,
      'webhookDelivery.url': url
    });

    // Retry with backoff
    if (attempt < MAX_RETRIES - 1) {
      const delay = RETRY_DELAYS[attempt];
      logger.info(`Retrying webhook in ${delay / 1000}s...`);
      setTimeout(() => attemptDelivery(interviewId, url, payload, attempt + 1), delay);
    } else {
      logger.error('Webhook delivery exhausted all retries:', { interviewId, url });
    }
  }
}

function generateSignature(payload) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'webhook-secret')
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ─── Deliver to n8n Workflow ───
export async function triggerN8nWorkflow(event, data) {
  const n8nUrl = process.env.N8N_WEBHOOK_URL;
  if (!n8nUrl) return;

  try {
    await fetch(n8nUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.N8N_API_KEY}`
      },
      body: JSON.stringify({ event, data, timestamp: new Date().toISOString() })
    });
    logger.info('n8n workflow triggered:', { event });
  } catch (error) {
    logger.error('n8n trigger failed:', { event, error: error.message });
  }
}

export default { deliverWebhook, triggerN8nWorkflow };
