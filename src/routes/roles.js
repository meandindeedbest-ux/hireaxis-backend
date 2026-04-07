import { Router } from 'express';
import { Role } from '../models/Role.js';
import { generateInterviewPlan } from '../services/llmService.js';
import { syncAllRolesToAgent } from '../services/elevenlabsService.js';
import { Company } from '../models/Company.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ─── Helper: sync agent with all active roles ───
async function autoSyncAgent(companyId) {
  try {
    const roles = await Role.find({ companyId, status: 'active' });
    await syncAllRolesToAgent(roles);
    logger.info('Agent auto-synced with all active roles:', { count: roles.length });
  } catch (e) {
    logger.warn('Agent auto-sync failed:', { error: e.message });
  }
}

// GET /api/roles
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;

    const roles = await Role.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Role.countDocuments(filter);
    res.json({ roles, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/roles/:id
router.get('/:id', async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    res.json(role);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/roles — Create role + auto-sync ALL roles to agent
router.post('/', async (req, res) => {
  try {
    const { title, department, description, channel, language, maxDurationMinutes, knowledgeBase } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!description) return res.status(400).json({ error: 'description is required' });

    // Step 1: AI generates the interview plan
    logger.info('Generating interview plan:', { title, channel });
    const plan = await generateInterviewPlan(title, description, {
      channel: channel || 'phone',
      language: language || 'en',
      duration: maxDurationMinutes || 30
    });

    // Step 2: Save role to database
    const role = await Role.create({
      companyId: req.companyId,
      title,
      department,
      description,
      channel: channel || 'phone',
      language: language || 'en',
      maxDurationMinutes: maxDurationMinutes || 30,
      systemPrompt: plan.systemPrompt,
      openingMessage: plan.openingMessage,
      closingMessage: plan.closingMessage,
      questions: plan.questions,
      scoringDimensions: plan.scoringDimensions,
      redFlags: plan.redFlags || [],
      dealBreakers: plan.dealBreakers || [],
      knowledgeBase: knowledgeBase || []
    });

    // Step 3: AUTO-SYNC — Update ElevenLabs agent with ALL active roles
    await autoSyncAgent(req.companyId);

    logger.info('Role created:', { roleId: role._id, title, questions: role.questions.length });
    res.status(201).json(role);
  } catch (error) {
    logger.error('Failed to create role:', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/roles/:id — Update role + re-sync all roles
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'department', 'description', 'status', 'channel', 'language',
      'maxDurationMinutes', 'questions', 'scoringDimensions', 'systemPrompt',
      'openingMessage', 'closingMessage', 'redFlags', 'dealBreakers', 'voiceId', 'knowledgeBase'];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const role = await Role.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      updates,
      { new: true }
    );

    if (!role) return res.status(404).json({ error: 'Role not found' });

    // AUTO-SYNC if anything meaningful changed
    const syncFields = ['title', 'status', 'questions', 'systemPrompt', 'openingMessage', 'closingMessage', 'scoringDimensions', 'redFlags', 'dealBreakers'];
    if (syncFields.some(f => req.body[f] !== undefined)) {
      await autoSyncAgent(req.companyId);
    }

    res.json(role);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/roles/:id/regenerate — Regenerate plan + sync
router.post('/:id/regenerate', async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const plan = await generateInterviewPlan(role.title, role.description, {
      channel: role.channel,
      language: role.language,
      duration: role.maxDurationMinutes
    });

    role.systemPrompt = plan.systemPrompt;
    role.openingMessage = plan.openingMessage;
    role.closingMessage = plan.closingMessage;
    role.questions = plan.questions;
    role.scoringDimensions = plan.scoringDimensions;
    role.redFlags = plan.redFlags || [];
    role.dealBreakers = plan.dealBreakers || [];
    await role.save();

    await autoSyncAgent(req.companyId);

    res.json(role);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/roles/:id/sync — Manually sync agent
router.post('/:id/sync', async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    await autoSyncAgent(req.companyId);
    res.json({ message: 'Agent synced with all active roles', roleId: role._id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/roles/:id — Archive role + re-sync
router.delete('/:id', async (req, res) => {
  try {
    const role = await Role.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { status: 'archived' },
      { new: true }
    );
    if (!role) return res.status(404).json({ error: 'Role not found' });

    // Re-sync agent (archived role will be excluded)
    await autoSyncAgent(req.companyId);

    res.json({ message: 'Role archived', id: role._id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
