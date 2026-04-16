import { validateTwilioSignature } from '../middleware/security.js';
import { Router } from 'express';
import { generateElevenLabsConnectTwiML } from '../services/twilioService.js';
import { syncAgentWithRole } from '../services/elevenlabsService.js';
import { Interview } from '../models/Interview.js';
import { Role } from '../models/Role.js';
import { Company } from '../models/Company.js';
import { logger } from '../utils/logger.js';
import twilio from 'twilio';

const router = Router();

// POST /api/twilio/incoming — IVR Menu: caller selects which role to interview for
router.post('/incoming', validateTwilioSignature,, async (req, res) => {
  try {
    const { From, CallSid, To } = req.body;
    logger.info('Inbound call received:', { from: From, callSid: CallSid, to: To });

    // Check if there's a pre-scheduled interview for this caller
    const scheduled = await Interview.findOne({
      'candidate.phone': From,
      status: 'scheduled',
      channel: 'phone'
    }).populate('roleId');

    if (scheduled && scheduled.roleId) {
      // Direct connect — they have a scheduled interview
      logger.info('Found scheduled interview, syncing agent:', { roleTitle: scheduled.roleId.title });
      try {
        await syncAgentWithRole(scheduled.roleId);
      } catch (e) {
        logger.warn('Agent sync failed for scheduled:', { error: e.message });
      }

      scheduled.status = 'in_progress';
      scheduled.startedAt = new Date();
      scheduled.twilioCallSid = CallSid;
      await scheduled.save();

      const twiml = generateElevenLabsConnectTwiML(process.env.ELEVENLABS_AGENT_ID, {
        candidateName: scheduled.candidate.name,
        interviewId: scheduled._id.toString(),
        roleTitle: scheduled.roleId.title
      });
      return res.type('text/xml').send(twiml);
    }

    // No scheduled interview — show IVR menu with available roles
    const company = await Company.findOne({});
    if (!company) {
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const r = new VoiceResponse();
      r.say({ voice: 'Polly.Joanna' }, 'Welcome. No company has been configured yet. Please contact the administrator.');
      return res.type('text/xml').send(r.toString());
    }

    const roles = await Role.find({ companyId: company._id, status: 'active' }).sort({ createdAt: -1 });

    if (roles.length === 0) {
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const r = new VoiceResponse();
      r.say({ voice: 'Polly.Joanna' }, 'Welcome. There are no open positions at this time. Please try again later.');
      return res.type('text/xml').send(r.toString());
    }

    if (roles.length === 1) {
      // Only one role — skip the menu, go straight to interview
      logger.info('Single role available, syncing agent:', { roleTitle: roles[0].title });
      try {
        await syncAgentWithRole(roles[0]);
      } catch (e) {
        logger.warn('Agent sync failed:', { error: e.message });
      }

      const twiml = generateElevenLabsConnectTwiML(process.env.ELEVENLABS_AGENT_ID, {
        candidateName: From || 'caller',
        roleTitle: roles[0].title
      });
      return res.type('text/xml').send(twiml);
    }

    // Multiple roles — build IVR menu
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    const gather = response.gather({
      numDigits: 1,
      action: `${process.env.API_BASE_URL}/api/twilio/role-select`,
      method: 'POST',
      timeout: 10
    });

    let greeting = 'Welcome to HireAxis interview line. Please select the position you are interviewing for. ';
    roles.forEach((role, i) => {
      if (i < 9) {
        greeting += `Press ${i + 1} for ${role.title}. `;
      }
    });

    gather.say({ voice: 'Polly.Joanna' }, greeting);

    // If no input, repeat
    response.say({ voice: 'Polly.Joanna' }, 'We did not receive your selection. Please call again.');

    logger.info('IVR menu presented:', { rolesCount: roles.length, roles: roles.map(r => r.title) });
    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('Error handling inbound call:', { error: error.message });
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const r = new VoiceResponse();
    r.say({ voice: 'Polly.Joanna' }, 'We apologize, but we are experiencing technical difficulties. Please try again later.');
    res.type('text/xml').send(r.toString());
  }
});

// POST /api/twilio/role-select — Handle IVR selection, sync agent, connect to interview
router.post('/role-select', validateTwilioSignature,, async (req, res) => {
  try {
    const { Digits, From, CallSid } = req.body;
    const selection = parseInt(Digits, 10);

    logger.info('Role selected:', { digit: selection, from: From, callSid: CallSid });

    const company = await Company.findOne({});
    const roles = await Role.find({ companyId: company._id, status: 'active' }).sort({ createdAt: -1 });

    if (isNaN(selection) || selection < 1 || selection > roles.length) {
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const r = new VoiceResponse();
      r.say({ voice: 'Polly.Joanna' }, 'Invalid selection. Please call again and select a valid option.');
      return res.type('text/xml').send(r.toString());
    }

    const selectedRole = roles[selection - 1];
    logger.info('Syncing agent with selected role:', { roleTitle: selectedRole.title, roleId: selectedRole._id });

    // Sync the ElevenLabs agent with the selected role's interview plan
    try {
      await syncAgentWithRole(selectedRole);
      logger.info('Agent synced for role:', { roleTitle: selectedRole.title });
    } catch (syncError) {
      logger.error('Failed to sync agent for selected role:', { error: syncError.message });
    }

    // Brief confirmation then redirect to ElevenLabs native handler
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say({ voice: 'Polly.Joanna' }, `Great! Connecting you to your interview for the ${selectedRole.title} position. One moment please.`);
    response.pause({ length: 2 });
    
    // Redirect back to incoming — ElevenLabs native integration will pick it up
    // We set a flag so our incoming handler knows to skip the IVR
    response.redirect({ method: 'POST' }, `${process.env.API_BASE_URL}/api/twilio/connect-agent`);

    logger.info('Redirecting to agent after sync:', { roleTitle: selectedRole.title, callSid: CallSid });
    res.type('text/xml').send(response.toString());

  } catch (error) {
    logger.error('Error in role selection:', { error: error.message });
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const r = new VoiceResponse();
    r.say({ voice: 'Polly.Joanna' }, 'We apologize for the technical difficulty. Please try again later.');
    res.type('text/xml').send(r.toString());
  }
});

// POST /api/twilio/connect-agent — Connect call directly to ElevenLabs agent
// POST /api/twilio/connect-agent — Connect call directly to ElevenLabs agent  
router.post('/connect-agent', async (req, res) => {
  try {
    const { From, CallSid } = req.body;
    logger.info('Connecting to ElevenLabs agent:', { from: From, callSid: CallSid });

    const twiml = generateElevenLabsConnectTwiML(process.env.ELEVENLABS_AGENT_ID, {
      candidateName: From || 'candidate'
    });

    res.type('text/xml').send(twiml);
  } catch (error) {
    logger.error('Error connecting agent:', { error: error.message });
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const r = new VoiceResponse();
    r.say({ voice: 'Polly.Joanna' }, 'We are having trouble connecting. Please try again.');
    res.type('text/xml').send(r.toString());
  }
});

// POST /api/twilio/status — Call status updates
router.post('/status', validateTwilioSignature,, async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    logger.info('Call status update:', { callSid: CallSid, status: CallStatus, duration: CallDuration });

    if (CallStatus === 'completed' || CallStatus === 'no-answer' || CallStatus === 'busy' || CallStatus === 'failed') {
      const interview = await Interview.findOne({ twilioCallSid: CallSid });
      if (interview) {
        if (CallStatus === 'no-answer') {
          interview.status = 'no_show';
        } else if (CallStatus === 'failed' || CallStatus === 'busy') {
          interview.status = 'failed';
        }
        if (CallDuration) {
          interview.durationSeconds = Number(CallDuration);
        }
        await interview.save();
      }
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('Error processing status callback:', { error: error.message });
    res.sendStatus(200);
  }
});

// POST /api/twilio/recording — Recording status webhook
router.post('/recording', async (req, res) => {
  try {
    const { CallSid, RecordingUrl, RecordingStatus } = req.body;
    logger.info('Recording update:', { callSid: CallSid, status: RecordingStatus });

    if (RecordingStatus === 'completed' && RecordingUrl) {
      await Interview.findOneAndUpdate(
        { twilioCallSid: CallSid },
        { twilioRecordingUrl: `${RecordingUrl}.mp3` }
      );
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('Error processing recording callback:', { error: error.message });
    res.sendStatus(200);
  }
});

export default router;
