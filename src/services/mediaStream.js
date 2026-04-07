import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { Interview } from '../models/Interview.js';
import { generateScorecard } from './llmService.js';
import { Role } from '../models/Role.js';
import { deliverWebhook } from './webhookService.js';

// ─── Handle Twilio Media Stream WebSocket Connection ───
export function handleMediaStream(twilioWs, req) {
  let elevenLabsWs = null;
  let streamSid = null;
  let callSid = null;
  let interviewId = null;
  let agentId = null;
  let candidateName = null;
  let startTime = Date.now();
  let transcriptBuffer = [];

  // Parse URL params if present
  const url = new URL(req.url, `ws://${req.headers.host}`);

  twilioWs.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case 'start':
          // Extract metadata from Twilio stream start event
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;

          // Extract custom parameters
          const params = data.start.customParameters || {};
          interviewId = params.interviewId;
          agentId = params.agentId || process.env.ELEVENLABS_AGENT_ID;
          candidateName = params.candidateName || 'Candidate';

          logger.info('Media stream started:', { streamSid, callSid, interviewId });

          // Update interview status
          if (interviewId) {
            await Interview.findByIdAndUpdate(interviewId, {
              status: 'in_progress',
              startedAt: new Date(),
              twilioCallSid: callSid
            });
          }

          // Connect to ElevenLabs Conversational AI WebSocket
          elevenLabsWs = connectToElevenLabs(agentId, {
            candidateName,
            interviewId,
            onAudioChunk: (audioData) => {
              // Send ElevenLabs audio back to Twilio
              if (twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: {
                    payload: audioData  // base64 encoded mulaw audio
                  }
                }));
              }
            },
            onTranscript: (entry) => {
              transcriptBuffer.push(entry);
            },
            onConversationEnd: async () => {
              await finalizeInterview(interviewId, transcriptBuffer, startTime);
            }
          });
          break;

        case 'media':
          // Forward Twilio audio to ElevenLabs
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              user_audio_chunk: data.media.payload
            }));
          }
          break;

        case 'stop':
          logger.info('Media stream stopped:', { streamSid, callSid });
          cleanupConnections(elevenLabsWs);
          await finalizeInterview(interviewId, transcriptBuffer, startTime);
          break;

        default:
          break;
      }
    } catch (error) {
      logger.error('Error processing media stream message:', { error: error.message });
    }
  });

  twilioWs.on('close', () => {
    logger.info('Twilio WebSocket closed:', { streamSid });
    cleanupConnections(elevenLabsWs);
  });

  twilioWs.on('error', (error) => {
    logger.error('Twilio WebSocket error:', { error: error.message });
    cleanupConnections(elevenLabsWs);
  });
}

// ─── Connect to ElevenLabs Conversational AI via WebSocket ───
function connectToElevenLabs(agentId, callbacks) {
  const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;

  const ws = new WebSocket(wsUrl, {
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY
    }
  });

  ws.on('open', () => {
    logger.info('Connected to ElevenLabs Conversational AI');

    // Send initialization with dynamic variables
    ws.send(JSON.stringify({
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        candidate_name: callbacks.candidateName,
        interview_id: callbacks.interviewId
      },
      conversation_config_override: {
        tts: {
          output_format: 'ulaw_8000'  // Required for Twilio telephony
        }
      }
    }));
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'audio':
          // Forward AI voice audio to Twilio
          if (message.audio?.chunk) {
            callbacks.onAudioChunk(message.audio.chunk);
          }
          break;

        case 'agent_response':
          // AI finished speaking — log transcript
          if (message.agent_response?.trim()) {
            callbacks.onTranscript({
              speaker: 'ai',
              text: message.agent_response,
              timestamp: Math.floor((Date.now() - callbacks._startTime) / 1000)
            });
          }
          break;

        case 'user_transcript':
          // Candidate speech transcribed
          if (message.user_transcript?.trim()) {
            callbacks.onTranscript({
              speaker: 'candidate',
              text: message.user_transcript,
              timestamp: Math.floor((Date.now() - callbacks._startTime) / 1000)
            });
          }
          break;

        case 'conversation_ended':
          logger.info('ElevenLabs conversation ended');
          callbacks.onConversationEnd?.();
          break;

        case 'interruption':
          // Candidate interrupted the AI — natural turn-taking
          logger.debug('Interruption detected');
          break;
      }
    } catch (error) {
      logger.error('Error processing ElevenLabs message:', { error: error.message });
    }
  });

  ws.on('close', () => {
    logger.info('ElevenLabs WebSocket closed');
  });

  ws.on('error', (error) => {
    logger.error('ElevenLabs WebSocket error:', { error: error.message });
  });

  // Store start time for timestamp calculation
  callbacks._startTime = Date.now();

  return ws;
}

// ─── Finalize Interview — Generate Scorecard and Deliver Webhook ───
async function finalizeInterview(interviewId, transcript, startTime) {
  if (!interviewId) return;

  try {
    const durationSeconds = Math.floor((Date.now() - startTime) / 1000);

    const interview = await Interview.findById(interviewId);
    if (!interview || interview.status === 'completed') return;

    // Save transcript
    interview.transcript = transcript;
    interview.durationSeconds = durationSeconds;
    interview.completedAt = new Date();
    interview.status = 'completed';

    // Generate scorecard using LLM
    const role = await Role.findById(interview.roleId);
    if (role) {
      logger.info('Generating scorecard:', { interviewId });
      const scorecard = await generateScorecard(interview, role);
      interview.scorecard = scorecard;

      // Update role stats
      await Role.findByIdAndUpdate(role._id, {
        $inc: {
          'stats.totalCandidates': 0,
          'stats.completedInterviews': 1
        },
        $set: {
          'stats.averageScore': scorecard.overallScore  // simplified; should be running average
        }
      });
    }

    await interview.save();
    logger.info('Interview finalized:', {
      interviewId,
      score: interview.scorecard?.overallScore,
      recommendation: interview.scorecard?.recommendation,
      duration: `${Math.floor(durationSeconds / 60)}m`
    });

    // Deliver webhook
    if (interview.webhookDelivery?.url || interview.metadata?.customFields?.webhookUrl) {
      await deliverWebhook(interview);
    }

  } catch (error) {
    logger.error('Failed to finalize interview:', { interviewId, error: error.message });
    await Interview.findByIdAndUpdate(interviewId, {
      status: 'failed',
      'metadata.customFields.failureReason': error.message
    });
  }
}

function cleanupConnections(elevenLabsWs) {
  if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
    elevenLabsWs.close();
  }
}
