import { Router } from 'express';
import { Interview } from '../models/Interview.js';
import { logger } from '../utils/logger.js';

const router = Router();

// GET /api/candidates — List all candidates with their best scores
router.get('/', async (req, res) => {
  try {
    const { roleId, minScore, maxScore, recommendation, search, page = 1, limit = 20 } = req.query;

    const matchStage = { companyId: req.user.companyId, status: 'completed' };
    if (roleId) matchStage.roleId = roleId;
    if (recommendation) matchStage['scorecard.recommendation'] = recommendation;
    if (minScore || maxScore) {
      matchStage['scorecard.overallScore'] = {};
      if (minScore) matchStage['scorecard.overallScore'].$gte = Number(minScore);
      if (maxScore) matchStage['scorecard.overallScore'].$lte = Number(maxScore);
    }
    if (search) {
      matchStage['candidate.name'] = { $regex: search, $options: 'i' };
    }

    const interviews = await Interview.find(matchStage)
      .sort({ 'scorecard.overallScore': -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('candidate channel status scorecard.overallScore scorecard.recommendation scorecard.dimensionScores scorecard.strengths scorecard.concerns durationSeconds completedAt roleId')
      .populate('roleId', 'title department');

    const total = await Interview.countDocuments(matchStage);

    const candidates = interviews.map(i => ({
      interview_id: i._id,
      name: i.candidate.name,
      email: i.candidate.email,
      phone: i.candidate.phone,
      role: i.roleId?.title,
      department: i.roleId?.department,
      channel: i.channel,
      overall_score: i.scorecard?.overallScore,
      recommendation: i.scorecard?.recommendation,
      dimensions: i.scorecard?.dimensionScores?.reduce((acc, d) => {
        acc[d.dimension] = d.score;
        return acc;
      }, {}),
      strengths: i.scorecard?.strengths,
      concerns: i.scorecard?.concerns,
      duration_minutes: i.durationSeconds ? Math.round(i.durationSeconds / 60) : null,
      completed_at: i.completedAt
    }));

    res.json({ candidates, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/candidates/compare — Compare multiple candidates side by side
router.get('/compare', async (req, res) => {
  try {
    const { ids } = req.query; // comma-separated interview IDs
    if (!ids) return res.status(400).json({ error: 'ids query parameter required (comma-separated interview IDs)' });

    const interviewIds = ids.split(',').map(id => id.trim());
    if (interviewIds.length < 2 || interviewIds.length > 5) {
      return res.status(400).json({ error: 'Provide 2-5 interview IDs for comparison' });
    }

    const interviews = await Interview.find({
      _id: { $in: interviewIds },
      companyId: req.user.companyId,
      status: 'completed'
    })
      .select('candidate scorecard channel durationSeconds roleId')
      .populate('roleId', 'title scoringDimensions');

    if (interviews.length < 2) {
      return res.status(404).json({ error: 'At least 2 completed interviews required for comparison' });
    }

    const comparison = {
      role: interviews[0].roleId?.title,
      dimensions: interviews[0].roleId?.scoringDimensions?.map(d => d.name) || [],
      candidates: interviews.map(i => ({
        interview_id: i._id,
        name: i.candidate.name,
        overall_score: i.scorecard?.overallScore,
        recommendation: i.scorecard?.recommendation,
        dimension_scores: i.scorecard?.dimensionScores?.reduce((acc, d) => {
          acc[d.dimension] = { score: d.score, notes: d.notes };
          return acc;
        }, {}),
        strengths: i.scorecard?.strengths,
        concerns: i.scorecard?.concerns,
        duration_minutes: Math.round(i.durationSeconds / 60),
        channel: i.channel
      }))
    };

    // Sort by overall score descending
    comparison.candidates.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));

    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/candidates/rankings/:roleId — Ranked leaderboard for a role
router.get('/rankings/:roleId', async (req, res) => {
  try {
    const interviews = await Interview.find({
      companyId: req.user.companyId,
      roleId: req.params.roleId,
      status: 'completed',
      'scorecard.overallScore': { $exists: true }
    })
      .sort({ 'scorecard.overallScore': -1 })
      .select('candidate scorecard.overallScore scorecard.recommendation scorecard.dimensionScores completedAt channel')
      .limit(50);

    const rankings = interviews.map((i, idx) => ({
      rank: idx + 1,
      interview_id: i._id,
      name: i.candidate.name,
      email: i.candidate.email,
      overall_score: i.scorecard.overallScore,
      recommendation: i.scorecard.recommendation,
      dimensions: i.scorecard.dimensionScores?.reduce((acc, d) => {
        acc[d.dimension] = d.score;
        return acc;
      }, {}),
      completed_at: i.completedAt,
      channel: i.channel
    }));

    res.json({ role_id: req.params.roleId, total: rankings.length, rankings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
