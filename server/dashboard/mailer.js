// dashboard/mailer.js
import nodemailer from 'nodemailer';

// sending logic would be here, but it includes personal information.
// the rest of the email, such as content and shi might be old, but who really cares?

export async function sendVerificationEmail(toEmail, token) {
  const verifyLink = `https://ai.lachlanm05.com/verify?token=${token}`;
  
  try {
    const info = await transporter.sendMail({
      from: '"Lachlan AI Gateway" <noreply@lachlanm05.com>',
      to: toEmail,
      subject: 'Verify your AI Gateway Account',
      text: `Welcome! Click here to verify: ${verifyLink}`,
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Welcome to the Gateway</h2>
          <p>You need to verify your email to start hosting models.</p>
          <a href="${verifyLink}" style="padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Verify Email</a>
        </div>
      `
    });
    console.log('Message sent: %s', info.messageId);
  } catch (err) {
    console.error("Email Error:", err);
  }
}