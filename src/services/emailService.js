import { logger } from '../utils/logger.js';

const RESEND_API = 'https://api.resend.com/emails';
const FROM = process.env.SMTP_FROM || 'HireAxis <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      logger.warn('RESEND_API_KEY not set — email not sent');
      return { sent: false, reason: 'not_configured' };
    }
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html })
    });
    const data = await res.json();
    if (!res.ok) {
      logger.error('Resend error:', { status: res.status, error: data });
      return { sent: false, reason: JSON.stringify(data) };
    }
    logger.info('Email sent:', { to, subject, id: data.id });
    return { sent: true, messageId: data.id };
  } catch (error) {
    logger.error('Email send failed:', { to, subject, error: error.message });
    return { sent: false, reason: error.message };
  }
}

function baseTemplate(content, preheader = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#06070a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden">${preheader}</div>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#06070a;padding:40px 20px"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
<tr><td align="center" style="padding-bottom:32px">
<table cellpadding="0" cellspacing="0"><tr>
<td style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#5b6cf7,#0fd492);text-align:center;vertical-align:middle;font-weight:800;font-size:14px;color:#fff">H</td>
<td style="padding-left:10px;font-size:18px;font-weight:700;color:#eeeef5">HireAxis</td>
</tr></table></td></tr>
<tr><td style="background:#0c0d14;border:1px solid #1a1c2e;border-radius:16px;padding:40px 36px">${content}</td></tr>
<tr><td align="center" style="padding-top:28px"><p style="margin:0;font-size:12px;color:#555873;line-height:1.5">HireAxis — AI-powered interviews<br><a href="https://hireaxis.ai" style="color:#5b6cf7;text-decoration:none">hireaxis.ai</a></p></td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendVerificationEmail(email, name, code) {
  return sendEmail({
    to: email,
    subject: `${code} is your HireAxis verification code`,
    html: baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef5">Verify your email</h1>
      <p style="margin:0 0 28px;font-size:15px;color:#7a7d9a;line-height:1.6">Hi ${name}, enter this code to verify your account.</p>
      <div style="background:#06070a;border:1px solid #1a1c2e;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px">
        <div style="font-size:11px;color:#5b6cf7;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Your verification code</div>
        <div style="font-size:36px;font-weight:800;color:#eeeef5;letter-spacing:8px;font-family:'Courier New',monospace">${code}</div>
        <div style="font-size:12px;color:#555873;margin-top:10px">Expires in 30 minutes</div>
      </div>
      <p style="margin:0;font-size:12px;color:#555873">If you didn't create a HireAxis account, ignore this email.</p>
    `, `Your code is ${code}`)
  });
}

export async function sendWelcomeEmail(email, name, companyName) {
  return sendEmail({
    to: email,
    subject: `Welcome to HireAxis, ${name}!`,
    html: baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef5">Welcome to HireAxis!</h1>
      <p style="margin:0 0 28px;font-size:15px;color:#7a7d9a;line-height:1.6">Hi ${name}, your account for <strong style="color:#eeeef5">${companyName}</strong> is ready.</p>
      <div style="text-align:center;margin-bottom:24px"><a href="https://hireaxis-dashboard.vercel.app" style="display:inline-block;padding:14px 32px;background:#5b6cf7;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600">Go to your dashboard</a></div>
    `, `Your HireAxis account is ready.`)
  });
}

export async function sendScorecardEmail(email, candidateName, roleTitle, score, recommendation) {
  const scoreColor = score >= 80 ? '#0fd492' : score >= 60 ? '#f5a623' : '#f25f5c';
  const recLabel = recommendation === 'advance' ? 'Advance' : recommendation === 'consider' ? 'Consider' : 'Reject';
  return sendEmail({
    to: email,
    subject: `Scorecard: ${candidateName} — ${score}/100 for ${roleTitle}`,
    html: baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef5">New scorecard</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#7a7d9a"><strong style="color:#eeeef5">${candidateName}</strong> completed an interview for <strong style="color:#eeeef5">${roleTitle}</strong>.</p>
      <div style="background:#06070a;border:1px solid #1a1c2e;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <div style="font-size:48px;font-weight:800;color:${scoreColor};font-family:'Courier New',monospace">${score}</div>
        <div style="font-size:12px;color:#555873;margin-bottom:8px">Overall score</div>
        <div style="display:inline-block;padding:4px 14px;border-radius:6px;font-size:13px;font-weight:600;color:${scoreColor};background:${scoreColor}15">${recLabel}</div>
      </div>
      <div style="text-align:center"><a href="https://hireaxis-dashboard.vercel.app" style="display:inline-block;padding:12px 28px;background:#5b6cf7;color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600">View scorecard</a></div>
    `, `${candidateName} scored ${score}/100. ${recLabel}`)
  });
}

export async function sendCandidateRegistrationEmail(adminEmail, info) {
  const { candidateName, candidateEmail, candidatePhone, roleTitle, interviewMode, interviewId } = info;
  return sendEmail({
    to: adminEmail,
    subject: `New candidate: ${candidateName} — ${roleTitle}`,
    html: baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef5">New candidate registered</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#7a7d9a">A candidate just joined via the interview portal.</p>
      <div style="background:#06070a;border:1px solid #1a1c2e;border-radius:12px;padding:20px;margin-bottom:24px">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${[
            ['Name', candidateName],
            ['Email', candidateEmail],
            ['Phone', candidatePhone],
            ['Role', roleTitle],
            ['Format', interviewMode === 'video' ? 'Video interview' : 'Voice only'],
            ['Interview ID', interviewId]
          ].map(([label, value]) => `
            <tr>
              <td style="padding:8px 0;font-size:12px;color:#555873;width:100px">${label}</td>
              <td style="padding:8px 0;font-size:14px;color:#eeeef5;font-weight:500">${value || '—'}</td>
            </tr>
          `).join('')}
        </table>
      </div>
      <div style="text-align:center"><a href="https://hireaxis-dashboard.vercel.app" style="display:inline-block;padding:12px 28px;background:#5b6cf7;color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600">View in dashboard</a></div>
    `, `${candidateName} registered for ${roleTitle}`)
  });
}



export async function sendTranscriptEmail({ to, candidateName, role, companyName, transcript, scorecard, duration, interviewId }) {
  const mins = Math.floor((duration || 0) / 60);
  const secs = (duration || 0) % 60;

  // Build transcript HTML
  const transcriptHtml = (transcript || []).map((t, i) => {
    const speaker = t.speaker === 'ai' ? 'Interviewer' : candidateName;
    const color = t.speaker === 'ai' ? '#5b6cf7' : '#0fd492';
    const time = t.timestamp ? `${Math.floor(t.timestamp / 60)}:${String(t.timestamp % 60).padStart(2, '0')}` : '';
    return `<div style="margin-bottom:12px;padding:10px 14px;background:${t.speaker === 'ai' ? '#0a0b12' : '#0d1117'};border-left:3px solid ${color};border-radius:0 8px 8px 0">
      <div style="font-size:11px;font-weight:600;color:${color};margin-bottom:4px">${speaker} ${time ? `<span style="color:#555873;font-weight:400">· ${time}</span>` : ''}</div>
      <div style="font-size:14px;color:#cccde0;line-height:1.5">${t.text}</div>
    </div>`;
  }).join('');

  // Build scorecard summary
  const scoreHtml = scorecard ? `
    <div style="background:#06070a;border:1px solid #1a1c2e;border-radius:12px;padding:20px;margin-bottom:24px">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:42px;font-weight:800;color:${scorecard.overallScore >= 70 ? '#0fd492' : scorecard.overallScore >= 50 ? '#f5a623' : '#e74c3c'}">${scorecard.overallScore}</div>
        <div style="font-size:12px;color:#7a7d9a;text-transform:uppercase;letter-spacing:0.08em">Overall Score · ${scorecard.recommendation?.replace('_', ' ')}</div>
      </div>
      ${(scorecard.dimensionScores || []).map(d => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1a1c2e">
          <span style="font-size:13px;color:#cccde0">${d.dimension}</span>
          <span style="font-size:13px;font-weight:700;color:${d.score >= 70 ? '#0fd492' : d.score >= 50 ? '#f5a623' : '#e74c3c'}">${d.score}</span>
        </div>
      `).join('')}
      ${scorecard.aiSummary ? `<div style="margin-top:16px;font-size:13px;color:#7a7d9a;line-height:1.6">${scorecard.aiSummary}</div>` : ''}
      ${scorecard.strengths?.length ? `<div style="margin-top:12px"><div style="font-size:11px;font-weight:600;color:#0fd492;margin-bottom:6px">STRENGTHS</div>${scorecard.strengths.map(s => `<div style="font-size:13px;color:#cccde0;margin-bottom:4px">✓ ${s}</div>`).join('')}</div>` : ''}
      ${scorecard.concerns?.length ? `<div style="margin-top:12px"><div style="font-size:11px;font-weight:600;color:#e74c3c;margin-bottom:6px">CONCERNS</div>${scorecard.concerns.map(c => `<div style="font-size:13px;color:#cccde0;margin-bottom:4px">⚠ ${c}</div>`).join('')}</div>` : ''}
    </div>
  ` : '';

  return sendEmail({
    to,
    subject: `Interview Complete: ${candidateName} — ${role} (Score: ${scorecard?.overallScore || 'N/A'})`,
    html: baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef5">Interview Complete</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#7a7d9a;line-height:1.6">
        <strong style="color:#eeeef5">${candidateName}</strong> completed their interview for
        <strong style="color:#eeeef5">${role}</strong> at ${companyName}.
        Duration: ${mins}m ${secs}s
      </p>
      ${scoreHtml}
      <h2 style="margin:24px 0 16px;font-size:16px;font-weight:700;color:#eeeef5">Full Interview Transcript</h2>
      <div style="margin-bottom:20px">${transcriptHtml}</div>
      <div style="text-align:center;padding-top:16px">
        <a href="https://hireaxis-dashboard.vercel.app" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#5b6cf7,#0fd492);color:#fff;font-weight:600;font-size:14px;text-decoration:none;border-radius:10px">View on Dashboard</a>
      </div>
    `, `Interview complete: ${candidateName} scored ${scorecard?.overallScore || 'N/A'} for ${role}`)
  });
}

export default { sendVerificationEmail, sendWelcomeEmail, sendScorecardEmail, sendCandidateRegistrationEmail, sendTranscriptEmail };
