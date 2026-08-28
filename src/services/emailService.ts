import nodemailer from 'nodemailer';

const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

export const sendPasswordResetEmail = async (
  toEmail: string,
  resetToken: string
): Promise<void> => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
  const resetUrl = `${clientUrl}/reset-password/${resetToken}`;

  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Project Assistant" <no-reply@example.com>',
    to: toEmail,
    subject: 'Password Reset Request',
    text: `You requested a password reset. Click the link below to reset your password:\n\n${resetUrl}\n\nThis link expires in 10 minutes. If you did not request this, please ignore this email.`,
    html: `
      <p>You requested a password reset.</p>
      <p>Click the link below to reset your password:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>This link expires in <strong>10 minutes</strong>.</p>
      <p>If you did not request this, please ignore this email.</p>
    `,
  });
};

export interface ReminderMilestone {
  title: string;
  description?: string;
  dueDate: Date;
}

const fmtDueDate = (d: Date) =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

/**
 * Deadline reminder — sent to one student at a time so the greeting and any
 * per-student framing stays personal, even though the trigger (the "Send
 * reminder" button on the team page) fires the same content to everyone on
 * the team at once. Lists every still-open milestone, not just the nearest
 * one, and flags anything already overdue.
 */
export const sendDeadlineReminderEmail = async (
  toEmail: string,
  studentName: string,
  teamName: string,
  milestones: ReminderMilestone[]
): Promise<void> => {
  const transporter = createTransporter();
  const now = new Date();
  const sorted = [...milestones].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const textLines = sorted.map((m) => {
    const overdue = m.dueDate < now;
    return `- ${m.title} — due ${fmtDueDate(m.dueDate)}${overdue ? ' (OVERDUE)' : ''}${m.description ? `
  ${m.description}` : ''}`;
  });

  const htmlItems = sorted
    .map((m) => {
      const overdue = m.dueDate < now;
      return `
      <li style="margin-bottom: 10px;">
        <strong>${m.title}</strong>${overdue ? ' <span style="color:#dc2626;">(OVERDUE)</span>' : ''}<br/>
        <span style="color:#6b7280;">Due ${fmtDueDate(m.dueDate)}</span>
        ${m.description ? `<br/><span style="color:#6b7280;">${m.description}</span>` : ''}
      </li>`;
    })
    .join('');

  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Project Assistant" <no-reply@example.com>',
    to: toEmail,
    subject: `Deadline reminder — ${teamName}`,
    text: `Hi ${studentName},\n\nThis is a reminder about the following upcoming milestone${sorted.length === 1 ? '' : 's'} for "${teamName}":\n\n${textLines.join('\n')}\n\nPlease make sure your work is on track.`,
    html: `
      <p>Hi ${studentName},</p>
      <p>This is a reminder about the following upcoming milestone${sorted.length === 1 ? '' : 's'} for <strong>${teamName}</strong>:</p>
      <ul>${htmlItems}</ul>
      <p>Please make sure your work is on track.</p>
    `,
  });
};
