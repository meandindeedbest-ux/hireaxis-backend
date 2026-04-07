import { Router } from 'express';
import { Interview } from '../models/Interview.js';
import { Role } from '../models/Role.js';
import mongoose from 'mongoose';

const router = Router();

// GET /api/analytics/dashboard — Summary stats for dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = new mongoose.Types.ObjectId(req.companyId);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [todayStats, weekStats, channelStats, activeRoles] = await Promise.all([
      // Today's interviews
      Interview.aggregate([
        { $match: { companyId, createdAt: { $gte: todayStart } } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
          avgScore: { $avg: '$scorecard.overallScore' }
        }}
      ]),

      // This week's interviews
      Interview.aggregate([
        { $match: { companyId, createdAt: { $gte: weekStart } } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          avgScore: { $avg: '$scorecard.overallScore' },
          avgDuration: { $avg: '$durationSeconds' },
          totalMinutes: { $sum: { $divide: ['$durationSeconds', 60] } }
        }}
      ]),

      // Stats by channel
      Interview.aggregate([
        { $match: { companyId, status: 'completed', createdAt: { $gte: weekStart } } },
        { $group: {
          _id: '$channel',
          count: { $sum: 1 },
          avgScore: { $avg: '$scorecard.overallScore' },
          avgDuration: { $avg: '$durationSeconds' }
        }}
      ]),

      // Active roles count
      Role.countDocuments({ companyId, status: 'active' })
    ]);

    const today = todayStats[0] || { total: 0, completed: 0, inProgress: 0, avgScore: 0 };
    const week = weekStats[0] || { total: 0, completed: 0, avgScore: 0, avgDuration: 0, totalMinutes: 0 };

    const channels = {};
    channelStats.forEach(ch => {
      channels[ch._id] = {
        count: ch.count,
        avg_score: Math.round(ch.avgScore * 10) / 10,
        avg_duration_minutes: Math.round(ch.avgDuration / 60)
      };
    });

    // Pipeline totals
    const pipeline = await Interview.aggregate([
      { $match: { companyId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const pipelineCounts = {};
    pipeline.forEach(p => { pipelineCounts[p._id] = p.count; });

    res.json({
      today: {
        interviews: today.total,
        completed: today.completed,
        in_progress: today.inProgress,
        avg_score: today.avgScore ? Math.round(today.avgScore * 10) / 10 : null
      },
      this_week: {
        interviews: week.total,
        completed: week.completed,
        avg_score: week.avgScore ? Math.round(week.avgScore * 10) / 10 : null,
        avg_duration_minutes: week.avgDuration ? Math.round(week.avgDuration / 60) : null,
        total_minutes: Math.round(week.totalMinutes || 0)
      },
      active_roles: activeRoles,
      channels,
      pipeline: pipelineCounts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/scoring — Score distribution and trends
router.get('/scoring', async (req, res) => {
  try {
    const companyId = new mongoose.Types.ObjectId(req.companyId);
    const { roleId, days = 30 } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - Number(days));

    const match = { companyId, status: 'completed', completedAt: { $gte: since } };
    if (roleId) match.roleId = new mongoose.Types.ObjectId(roleId);

    // Score distribution (buckets of 10)
    const distribution = await Interview.aggregate([
      { $match: match },
      { $bucket: {
        groupBy: '$scorecard.overallScore',
        boundaries: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        default: 'other',
        output: { count: { $sum: 1 } }
      }}
    ]);

    // Recommendation breakdown
    const recommendations = await Interview.aggregate([
      { $match: match },
      { $group: { _id: '$scorecard.recommendation', count: { $sum: 1 } } }
    ]);

    // Daily trend
    const trend = await Interview.aggregate([
      { $match: match },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } },
        count: { $sum: 1 },
        avgScore: { $avg: '$scorecard.overallScore' }
      }},
      { $sort: { _id: 1 } }
    ]);

    // Top dimension scores across all interviews
    const dimensionAvg = await Interview.aggregate([
      { $match: match },
      { $unwind: '$scorecard.dimensionScores' },
      { $group: {
        _id: '$scorecard.dimensionScores.dimension',
        avgScore: { $avg: '$scorecard.dimensionScores.score' },
        count: { $sum: 1 }
      }},
      { $sort: { avgScore: -1 } }
    ]);

    res.json({
      score_distribution: distribution,
      recommendations: recommendations.reduce((acc, r) => { acc[r._id] = r.count; return acc; }, {}),
      daily_trend: trend.map(d => ({
        date: d._id,
        interviews: d.count,
        avg_score: Math.round(d.avgScore * 10) / 10
      })),
      dimension_averages: dimensionAvg.map(d => ({
        dimension: d._id,
        avg_score: Math.round(d.avgScore * 10) / 10,
        sample_size: d.count
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/roles/:roleId — Per-role performance breakdown
router.get('/roles/:roleId', async (req, res) => {
  try {
    const companyId = new mongoose.Types.ObjectId(req.companyId);
    const roleId = new mongoose.Types.ObjectId(req.params.roleId);

    const role = await Role.findOne({ _id: roleId, companyId });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const stats = await Interview.aggregate([
      { $match: { companyId, roleId, status: 'completed' } },
      { $group: {
        _id: null,
        totalInterviews: { $sum: 1 },
        avgScore: { $avg: '$scorecard.overallScore' },
        avgDuration: { $avg: '$durationSeconds' },
        strongAdvance: { $sum: { $cond: [{ $eq: ['$scorecard.recommendation', 'strong_advance'] }, 1, 0] } },
        advance: { $sum: { $cond: [{ $eq: ['$scorecard.recommendation', 'advance'] }, 1, 0] } },
        consider: { $sum: { $cond: [{ $eq: ['$scorecard.recommendation', 'consider'] }, 1, 0] } },
        reject: { $sum: { $cond: [{ $eq: ['$scorecard.recommendation', 'reject'] }, 1, 0] } }
      }}
    ]);

    const s = stats[0] || {};

    res.json({
      role: { id: role._id, title: role.title, department: role.department },
      total_interviews: s.totalInterviews || 0,
      avg_score: s.avgScore ? Math.round(s.avgScore * 10) / 10 : null,
      avg_duration_minutes: s.avgDuration ? Math.round(s.avgDuration / 60) : null,
      recommendations: {
        strong_advance: s.strongAdvance || 0,
        advance: s.advance || 0,
        consider: s.consider || 0,
        reject: s.reject || 0
      },
      pass_rate: s.totalInterviews
        ? Math.round(((s.strongAdvance + s.advance) / s.totalInterviews) * 100)
        : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
