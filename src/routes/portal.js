import { Router } from 'express';
import { Interview } from '../models/Interview.js';
import { Role } from '../models/Role.js';
import { Company } from '../models/Company.js';
import { User } from '../models/Company.js';
import { logger } from '../utils/logger.js';

const router = Router();

// POST /api/portal/register-candidate — Called by candidate portal (no auth required)
router.post('/register-candidate', async (req, res) => {
  try {
    const { name, email, phone, role, company, sessionId, mode } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }

    // Find company (use first company for now, or match by name)
    let companyDoc = null;
    if (company) {
      companyDoc = await Company.findOne({ name: { $regex: new RegExp(company, 'i') } });
    }
    if (!companyDoc) {
      companyDoc = await Company.findOne({});
    }
    if (!companyDoc) {
      return res.status(404).json({ error: 'No company found' });
    }

    // Find matching role
    let roleDoc = null;
    if (role && role !== 'Open Position') {
      roleDoc = await Role.findOne({
        companyId: companyDoc._id,
        status: 'active',
        title: { $regex: new RegExp(role, 'i') }
      });
    }
    if (!roleDoc) {
      roleDoc = await Role.findOne({ companyId: companyDoc._id, status: 'active' });
    }

    // Create interview record with candidate info
    const interview = await Interview.create({
      companyId: companyDoc._id,
      roleId: roleDoc?._id,
      candidate: {
        name,
        email,
        phone,
        metadata: { sessionId, interviewMode: mode }
      },
      channel: mode === 'video' ? 'video' : 'phone',
      status: 'scheduled',
      scheduledAt: new Date(),
      metadata: {
        source: 'candidate_portal',
        customFields: {
          roleTitle: roleDoc?.title || role || 'Open Position',
          sessionId,
          interviewMode: mode
        }
      }
    });

    // Update role stats
    if (roleDoc) {
      await Role.findByIdAndUpdate(roleDoc._id, { $inc: { 'stats.totalCandidates': 1 } });
    }

    logger.info('Candidate registered from portal:', {
      interviewId: interview._id,
      name, email, phone: phone?.replace(/\d{4}$/, '****'),
      role: roleDoc?.title || role,
      mode
    });

    // Send email notification to admin
    try {
      const { sendCandidateRegistrationEmail } = await import('../services/emailService.js');
      const admin = await User.findOne({ companyId: companyDoc._id, role: 'admin' });
      if (admin) {
        await sendCandidateRegistrationEmail(admin.email, {
          candidateName: name,
          candidateEmail: email,
          candidatePhone: phone,
          roleTitle: roleDoc?.title || role || 'Open Position',
          interviewMode: mode,
          interviewId: interview._id.toString()
        });
      }
    } catch (emailErr) {
      logger.warn('Failed to send candidate registration email:', { error: emailErr.message });
    }

    res.status(201).json({
      success: true,
      interviewId: interview._id,
      message: 'Candidate registered successfully'
    });
  } catch (error) {
    logger.error('Portal registration error:', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/portal/roles — Get active roles for candidate portal (no auth)
router.get('/roles', async (req, res) => {
  try {
    const company = await Company.findOne({});
    if (!company) return res.json({ roles: [] });

    const roles = await Role.find({ companyId: company._id, status: 'active' })
      .select('title department channel maxDurationMinutes')
      .sort({ title: 1 });

    res.json({ roles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
