import twilio from 'twilio';
import { logger } from '../utils/logger.js';

function getClient(company = null) {
  const accountSid = company?.integrations?.twilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
  const authToken = company?.integrations?.twilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
  return twilio(accountSid, authToken);
}

// ─── Initiate an Outbound Phone Call ───
export async function makeCall(phoneNumber, webhookUrl, options = {}) {
  const client = getClient(options.company);
  const fromNumber = options.company?.integrations?.twilio?.phoneNumber || process.env.TWILIO_PHONE_NUMBER;

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: fromNumber,
      url: webhookUrl,         // Twilio will POST to this when call connects
      statusCallback: `${process.env.API_BASE_URL}/api/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: options.record !== false,
      recordingStatusCallback: `${process.env.API_BASE_URL}/api/twilio/recording`,
      timeout: options.timeout || 30,
      machineDetection: 'Enable'
    });

    logger.info('Outbound call initiated:', { callSid: call.sid, to: phoneNumber.replace(/\d{4}$/, '****') });
    return call;
  } catch (error) {
    logger.error('Failed to initiate call:', { error: error.message, to: phoneNumber });
    throw error;
  }
}

// ─── Generate TwiML to Connect Call to ElevenLabs WebSocket ───
export function generateMediaStreamTwiML(interviewId, agentId, candidateName) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  // Brief pause before connecting
  response.pause({ length: 1 });

  // Connect to our WebSocket media stream handler
  const connect = response.connect();
  const stream = connect.stream({
    url: `wss://${process.env.API_BASE_URL.replace(/^https?:\/\//, '')}/media-stream`,
    name: 'interview-stream'
  });

  // Pass metadata to the WebSocket
  stream.parameter({ name: 'interviewId', value: interviewId });
  stream.parameter({ name: 'agentId', value: agentId });
  stream.parameter({ name: 'candidateName', value: candidateName });

  return response.toString();
}

// ─── Generate TwiML for ElevenLabs Native Integration ───
export function generateElevenLabsConnectTwiML(agentId, metadata = {}) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  response.pause({ length: 1 });

  // Use ElevenLabs native Twilio integration
  const connect = response.connect();
  const stream = connect.stream({
    url: `wss://api.elevenlabs.io/v1/convai/twilio/audio`,
    name: 'elevenlabs-stream'
  });

  stream.parameter({ name: 'agent_id', value: agentId });

  // Pass dynamic variables for personalization
  if (metadata.candidateName) {
    stream.parameter({ name: 'candidate_name', value: metadata.candidateName });
  }
  if (metadata.interviewId) {
    stream.parameter({ name: 'interview_id', value: metadata.interviewId });
  }
  if (metadata.roleTitle) {
    stream.parameter({ name: 'role_title', value: metadata.roleTitle });
  }

  return response.toString();
}

// ─── Send SMS to Candidate ───
export async function sendSMS(phoneNumber, message, options = {}) {
  const client = getClient(options.company);
  const fromNumber = options.company?.integrations?.twilio?.phoneNumber || process.env.TWILIO_PHONE_NUMBER;

  try {
    const sms = await client.messages.create({
      to: phoneNumber,
      from: fromNumber,
      body: message
    });

    logger.info('SMS sent:', { sid: sms.sid, to: phoneNumber.replace(/\d{4}$/, '****') });
    return sms;
  } catch (error) {
    logger.error('Failed to send SMS:', { error: error.message });
    throw error;
  }
}

// ─── Send WhatsApp Message ───
export async function sendWhatsApp(phoneNumber, message, options = {}) {
  const client = getClient(options.company);
  const fromNumber = options.company?.integrations?.twilio?.phoneNumber || process.env.TWILIO_PHONE_NUMBER;

  try {
    const msg = await client.messages.create({
      to: `whatsapp:${phoneNumber}`,
      from: `whatsapp:${fromNumber}`,
      body: message
    });

    logger.info('WhatsApp sent:', { sid: msg.sid });
    return msg;
  } catch (error) {
    logger.error('Failed to send WhatsApp:', { error: error.message });
    throw error;
  }
}

// ─── Get Call Recording ───
export async function getRecording(callSid, options = {}) {
  const client = getClient(options.company);
  const recordings = await client.calls(callSid).recordings.list();
  return recordings.length > 0 ? recordings[0] : null;
}

// ─── Validate Twilio Webhook Signature ───
export function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = `${process.env.API_BASE_URL}${req.originalUrl}`;

  return twilio.validateRequest(authToken, signature, url, req.body);
}

export default {
  makeCall,
  generateMediaStreamTwiML,
  generateElevenLabsConnectTwiML,
  sendSMS,
  sendWhatsApp,
  getRecording,
  validateTwilioSignature
};
