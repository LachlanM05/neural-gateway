// dashboard/mailer.js
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp.protonmail.ch', // Check the popup, might be smtp.proton.me
  port: 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER, 
    pass: process.env.SMTP_PASS 
  },

  tls: {
    ciphers: 'SSLv3' // Sometimes needed for Proton compatibility
  }
});

// Sleep utility for throttling bulk emails
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


export async function sendVerificationEmail(toEmail, token) {
  const verifyLink = `https://ai.lachlanm05.com/verify?token=${token}`;
  
  try {
    const info = await transporter.sendMail({
      from: '"Neural Gateway // lachlanm05.com" <noreply@lachlanm05.com>',
      to: toEmail,
      subject: 'verify your email',
      text: `thanks for signing up! click this link to verify your email: ${verifyLink} if this wasn't you, ignore this email.`,
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>welcome to my Nerual Gateway</h2>
          <p>You need to verify your email to start proxying.</p>
          <a href="${verifyLink}" style="padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Verify Email</a>
        </div>
      `
    });
    console.log('Message sent: %s', info.messageId);
  } catch (err) {
    console.error("Email Error:", err);
  }
}

export async function sendPasswordResetEmail(toEmail, token) {
  const resetLink = `https://ai.lachlanm05.com/reset-password?token=${token}`;
  
  try {
    const info = await transporter.sendMail({
      from: '"Neural Gateway // lachlanm05.com" <noreply@lachlanm05.com>',
      to: toEmail,
      subject: 'Password Reset Request',
      text: `You requested a password reset. Click this link to reset your password: ${resetLink} \nIf you didn't request this, you can safely ignore this email.`,
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Neural Gateway - Password Reset</h2>
          <p>You requested a password reset.</p>
          <a href="${resetLink}" style="padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Reset Password</a>
          <p style="margin-top: 20px; font-size: 0.8em; color: #666;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `
    });
    console.log('[PM2] Password Reset Email sent: %s', info.messageId);
  } catch (err) {
    console.error("[PM2] Email Error:", err);
  }
}

export async function sendGlobalEmail(toEmailsArray, subject, bodyHtml) {
  console.log(`[PM2] Starting global email broadcast to ${toEmailsArray.length} recipients...`);
  let sentCount = 0;
  for (const email of toEmailsArray) {
    try {
      await transporter.sendMail({
        from: '"Neural Gateway // lachlanm05.com" <noreply@lachlanm05.com>',
        to: email,
        subject: subject,
        html: bodyHtml,
        text: bodyHtml.replace(/<[^>]*>?/gm, '') // Basic fallback text
      });
      sentCount++;
      // Sleep for a second to avoid rate limits
      await sleep(1000); 
    } catch (err) {
      console.error(`[PM2] Error sending global email to ${email}:`, err);
    }
  }
  console.log(`[PM2] Global email broadcast finished. Sent to ${sentCount}/${toEmailsArray.length} recipients.`);
}
