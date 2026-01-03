// dashboard/mailer.js
import nodemailer from 'nodemailer';

// sens info hidden, nodemailer function goes here.

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
