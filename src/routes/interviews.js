import { Router } from 'express';
import { Interview } from '../models/Interview.js';
import { Role } from '../models/Role.js';
import { Company } from '../models/Company.js';
import { initiateOutboundCall, getSignedAgentUrl } from '../services/elevenlabsService.js';
import { makeCall, generateElevenLabsConnectTwiML, sendSMS } from '../services/twilioService.js';
import { triggerN8nWorkflow } from '../services/webhookService.js';
import { logger } from '../utils/logger.js';

const router = Router();

// GET /api/interviews — List interviews with filtering
router.get('/', async (req, res) => {
  try {
    const { roleId, status, channel, page = 1, limit = 20, sort = '-createdAt' } = req.query;
    const filter = { companyId: req.companyId };
    if (roleId) filter.roleId = roleId;
    if (status) filter.status = status;
    if (channel) filter.channel = channel;

    const interviews = await Interview.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-transcript')  // exclude transcript from list view for performance
      .populate('roleId', 'title department');

    const total = await Interview.countDocuments(filter);

    res.json({ interviews, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/interviews/:id — Get full interview with scorecard
router.get('/:id', async (req, res) => {
  try {
    const interview = await Interview.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('roleId', 'title department scoringDimensions');
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    res.json(interview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/interviews/:id/transcript — Get transcript only
router.get('/:id/transcript', async (req, res) => {
  try {
    const interview = await Interview.findOne(
      { _id: req.params.id, companyId: req.companyId },
      'transcript candidate.name durationSeconds channel'
    );
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    res.json({
      candidate: interview.candidate.name,
      channel: interview.channel,
      duration: interview.durationSeconds,
      transcript: interview.transcript
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/interviews/:id/scorecard — Get structured scorecard
router.get('/:id/scorecard', async (req, res) => {
  try {
    const interview = await Interview.findOne(
      { _id: req.params.id, companyId: req.companyId },
      'scorecard candidate.name roleId channel durationSeconds'
    ).populate('roleId', 'title');

    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    if (!interview.scorecard?.overallScore) {
      return res.status(404).json({ error: 'Scorecard not yet generated' });
    }

    res.json({
      interview_id: interview._id,
      candidate: interview.candidate.name,
      role: interview.roleId?.title,
      channel: interview.channel,
      duration: interview.durationSeconds,
      scorecard: interview.scorecard
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/interviews — Create and optionally trigger an interview ───
router.post('/', async (req, res) => {
  try {
    const {
      roleId,
      candidate,       // { name, email, phone, resumeUrl, metadata }
      channel,          // override role's default channel
      scheduledAt,      // ISO date string or null for immediate
      callbackUrl,      // webhook URL for this specific interview
      triggerNow,       // boolean — initiate the call/session immediately
      metadata          // { atsId, requisitionId, source, customFields }
    } = req.body;

    // Validate
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });
    if (!candidate?.name) return res.status(400).json({ error: 'candidate.name is required' });

    const role = await Role.findOne({ _id: roleId, companyId: req.companyId, status: 'active' });
    if (!role) return res.status(404).json({ error: 'Active role not found' });

    const interviewChannel = channel || role.channel;

    // Validate channel requirements
    if (interviewChannel === 'phone' && !candidate.phone) {
      return res.status(400).json({ error: 'candidate.phone is required for phone interviews' });
    }

    // Create interview record
    const interview = await Interview.create({
      companyId: req.companyId,
      roleId: role._id,
      candidate,
      channel: interviewChannel,
      status: scheduledAt ? 'scheduled' : 'scheduled',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      webhookDelivery: callbackUrl ? { url: callbackUrl } : undefined,
      metadata: {
        ...metadata,
        source: metadata?.source || 'api',
        customFields: {
          ...metadata?.customFields,
          roleTitle: role.title
        }
      }
    });

    // Update role stats
    await Role.findByIdAndUpdate(role._id, { $inc: { 'stats.totalCandidates': 1 } });

    logger.info('Interview created:', {
      interviewId: interview._id,
      role: role.title,
      candidate: candidate.name,
      channel: interviewChannel
    });

    // ─── Trigger Immediately if Requested ───
    if (triggerNow || !scheduledAt) {
      const company = await Company.findById(req.companyId);
      const agentId = role.metadata?.elevenlabsAgentId || process.env.ELEVENLABS_AGENT_ID;

      try {
        if (interviewChannel === 'phone') {
          // Option A: Use ElevenLabs native Twilio integration (recommended)
          const callResult = await initiateOutboundCall(agentId, candidate.phone, {
            candidateName: candidate.name,
            roleTitle: role.title,
            companyName: company.name,
            interviewId: interview._id.toString()
          });

          interview.elevenlabsConversationId = callResult.call_id;
          interview.status = 'in_progress';
          interview.startedAt = new Date();
          await interview.save();

        } else if (interviewChannel === 'video') {
          // Generate a signed URL for the browser-based interview
          const signedUrl = await getSignedAgentUrl(agentId);

          interview.metadata.customFields = {
            ...interview.metadata.customFields,
            interviewUrl: signedUrl,
            agentId
          };
          await interview.save();

          // Send link to candidate via email/SMS
          if (candidate.phone) {
            await sendSMS(candidate.phone,
              `Hi ${candidate.name}! Your interview for ${role.title} at ${company.name} is ready. Join here: ${signedUrl}`,
              { company }
            );
          }

        } else if (interviewChannel === 'chat') {
          // Chat interviews are text-only — generate session URL
          const sessionUrl = `${process.env.API_BASE_URL}/interview/${interview._id}/chat`;
          interview.metadata.customFields = {
            ...interview.metadata.customFields,
            chatUrl: sessionUrl
          };
          await interview.save();

          if (candidate.phone) {
            await sendSMS(candidate.phone,
              `Hi ${candidate.name}! Ready for your ${role.title} interview at ${company.name}? Start here: ${sessionUrl}`,
              { company }
            );
          }
        }

        // Trigger n8n workflow
        await triggerN8nWorkflow('interview.started', {
          interviewId: interview._id,
          candidate: candidate.name,
          role: role.title,
          channel: interviewChannel
        });

      } catch (triggerError) {
        logger.error('Failed to trigger interview:', { error: triggerError.message });
        interview.status = 'failed';
        interview.metadata.customFields = {
          ...interview.metadata.customFields,
          failureReason: triggerError.message
        };
        await interview.save();

        return res.status(502).json({
          error: 'Interview created but failed to trigger',
          interview_id: interview._id,
          details: triggerError.message
        });
      }
    }

    res.status(201).json({
      interview_id: interview._id,
      status: interview.status,
      channel: interview.channel,
      candidate: interview.candidate.name,
      role: role.title,
      scheduled_at: interview.scheduledAt,
      interview_url: interview.metadata?.customFields?.interviewUrl
        || interview.metadata?.customFields?.chatUrl
        || null
    });

  } catch (error) {
    logger.error('Failed to create interview:', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/interviews/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    const interview = await Interview.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId, status: { $in: ['scheduled', 'in_progress'] } },
      { status: 'cancelled' },
      { new: true }
    );
    if (!interview) return res.status(404).json({ error: 'Interview not found or cannot be cancelled' });
    res.json({ message: 'Interview cancelled', id: interview._id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
