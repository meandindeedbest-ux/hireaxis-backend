import { Router } from 'express';
import { Interview } from '../models/Interview.js';
import { Role } from '../models/Role.js';
import { Company } from '../models/Company.js';
import { initiateOutboundCall } from '../services/elevenlabsService.js';
import { logger } from '../utils/logger.js';

const router = Router();

// POST /api/webhooks/ats/candidate — ATS sends new candidate → auto-trigger interview
router.post('/ats/candidate', async (req, res) => {
  try {
    const { api_key, candidate, role_id, trigger_immediately } = req.body;

    if (!api_key) return res.status(401).json({ error: 'api_key required' });

    const company = await Company.findOne({ apiKey: api_key });
    if (!company) return res.status(401).json({ error: 'Invalid API key' });

    if (!candidate?.name || !role_id) {
      return res.status(400).json({ error: 'candidate.name and role_id are required' });
    }

    const role = await Role.findOne({ _id: role_id, companyId: company._id, status: 'active' });
    if (!role) return res.status(404).json({ error: 'Active role not found' });

    const interview = await Interview.create({
      companyId: company._id,
      roleId: role._id,
      candidate: {
        name: candidate.name,
        email: candidate.email,
        phone: candidate.phone,
        resumeUrl: candidate.resume_url,
        metadata: candidate.metadata
      },
      channel: role.channel,
      status: 'scheduled',
      scheduledAt: new Date(),
      metadata: {
        atsId: candidate.ats_id,
        source: 'ats_webhook',
        customFields: { roleTitle: role.title }
      }
    });

    await Role.findByIdAndUpdate(role._id, { $inc: { 'stats.totalCandidates': 1 } });

    // Auto-trigger if requested and phone number available
    if (trigger_immediately && candidate.phone && role.channel === 'phone') {
      const agentId = role.metadata?.elevenlabsAgentId || process.env.ELEVENLABS_AGENT_ID;
      try {
        const callResult = await initiateOutboundCall(agentId, candidate.phone, {
          candidateName: candidate.name,
          roleTitle: role.title,
          companyName: company.name,
          interviewId: interview._id.toString()
        });

        interview.status = 'in_progress';
        interview.startedAt = new Date();
        interview.elevenlabsConversationId = callResult.call_id;
        await interview.save();
      } catch (callError) {
        logger.error('Auto-trigger failed:', { error: callError.message });
      }
    }

    logger.info('ATS webhook: Interview created', {
      interviewId: interview._id,
      candidate: candidate.name,
      role: role.title
    });

    res.status(201).json({
      interview_id: interview._id,
      status: interview.status,
      channel: interview.channel
    });
  } catch (error) {
    logger.error('ATS webhook error:', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/webhooks/n8n — n8n workflow trigger
router.post('/n8n', async (req, res) => {
  try {
    const { api_key, action, payload } = req.body;

    if (!api_key) return res.status(401).json({ error: 'api_key required' });
    const company = await Company.findOne({ apiKey: api_key });
    if (!company) return res.status(401).json({ error: 'Invalid API key' });

    switch (action) {
      case 'trigger_interview': {
        const { role_id, candidate } = payload;
        const role = await Role.findOne({ _id: role_id, companyId: company._id, status: 'active' });
        if (!role) return res.status(404).json({ error: 'Role not found' });

        const interview = await Interview.create({
          companyId: company._id,
          roleId: role._id,
          candidate,
          channel: role.channel,
          status: 'scheduled',
          scheduledAt: new Date(),
          metadata: { source: 'n8n', customFields: { roleTitle: role.title } }
        });

        res.status(201).json({ interview_id: interview._id, status: 'scheduled' });
        break;
      }

      case 'batch_trigger': {
        const { role_id, candidates } = payload;
        if (!Array.isArray(candidates)) return res.status(400).json({ error: 'candidates must be an array' });

        const role = await Role.findOne({ _id: role_id, companyId: company._id, status: 'active' });
        if (!role) return res.status(404).json({ error: 'Role not found' });

        const interviews = await Interview.insertMany(
          candidates.map(c => ({
            companyId: company._id,
            roleId: role._id,
            candidate: c,
            channel: role.channel,
            status: 'scheduled',
            scheduledAt: new Date(),
            metadata: { source: 'n8n_batch', customFields: { roleTitle: role.title } }
          }))
        );

        await Role.findByIdAndUpdate(role._id, {
          $inc: { 'stats.totalCandidates': candidates.length }
        });

        res.status(201).json({
          created: interviews.length,
          interview_ids: interviews.map(i => i._id)
        });
        break;
      }

      case 'get_results': {
        const { interview_id } = payload;
        const interview = await Interview.findOne({
          _id: interview_id,
          companyId: company._id
        }).select('candidate scorecard status channel durationSeconds');

        if (!interview) return res.status(404).json({ error: 'Interview not found' });
        res.json(interview);
        break;
      }

      default:
        res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    logger.error('n8n webhook error:', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/webhooks/elevenlabs — ElevenLabs conversation events
router.post('/elevenlabs', async (req, res) => {
  try {
    const { event_type, conversation_id, data } = req.body;

    logger.info('ElevenLabs event:', { event_type, conversation_id });

    if (event_type === 'conversation.ended') {
      const interview = await Interview.findOne({ elevenlabsConversationId: conversation_id });
      if (interview && interview.status === 'in_progress') {
        // Transcript and scoring are handled by mediaStream finalizer
        logger.info('ElevenLabs conversation ended for interview:', { interviewId: interview._id });
      }
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('ElevenLabs webhook error:', { error: error.message });
    res.sendStatus(200);
  }
});

export default router;
