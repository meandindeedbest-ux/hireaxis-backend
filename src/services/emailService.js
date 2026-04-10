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

export default {
  sendVerificationEmail,
  sendWelcomeEmail,
  sendScorecardEmail,
  sendCandidateRegistrationEmail,
};
