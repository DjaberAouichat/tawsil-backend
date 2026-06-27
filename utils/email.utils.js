import dotenv from "dotenv"
dotenv.config()
import nodemailer from "nodemailer";

const EMAIL_APP_NAME = (process.env.EMAIL_APP_NAME || "TawsilGO").trim()
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || EMAIL_APP_NAME).trim()
const EMAIL_PRIMARY_COLOR = (process.env.EMAIL_PRIMARY_COLOR || "#FF6500").trim()
const EMAIL_SUPPORT_CONTACT = (process.env.EMAIL_SUPPORT_CONTACT || process.env.EMAIL_FROM || "").trim()
const EMAIL_ALLOW_SELF_SIGNED_TLS =
  String(process.env.EMAIL_ALLOW_SELF_SIGNED_TLS || "")
    .trim()
    .toLowerCase() === "true"

if (EMAIL_ALLOW_SELF_SIGNED_TLS) {
  console.warn("EMAIL_ALLOW_SELF_SIGNED_TLS=true: SMTP certificate verification is disabled.")
}

const EMAIL_HOST = process.env.EMAIL_HOST || process.env.SMTP_HOST
const EMAIL_PORT = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 587)
const EMAIL_SECURE = String(process.env.EMAIL_SECURE || "").trim().toLowerCase() === "true"
const EMAIL_USER = process.env.EMAIL_USER || process.env.SMTP_USER
const EMAIL_PASS = process.env.EMAIL_PASS || process.env.SMTP_PASS
const EMAIL_FROM = (process.env.EMAIL_FROM || process.env.SMTP_FROM || EMAIL_USER || "").trim()

const buildFromAddress = () => `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`

const buildEmailLayout = (contentHtml) => `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background-color: ${EMAIL_PRIMARY_COLOR}; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
      <h1 style="color: white; margin: 0; font-size: 24px;">${EMAIL_APP_NAME}</h1>
    </div>
    <div style="background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
      ${contentHtml}
      <hr style="margin: 30px 0; border: none; border-top: 1px solid #e0e0e0;">
      <p style="color: #666; font-size: 14px; margin: 0;">
        Cordialement,<br>
        L'equipe ${EMAIL_APP_NAME}
      </p>
      ${EMAIL_SUPPORT_CONTACT ? `<p style="color: #666; font-size: 13px; margin-top: 12px;">Support: ${EMAIL_SUPPORT_CONTACT}</p>` : ""}
    </div>
  </div>
`

// Lazy-load transporter to ensure env vars are available
let _transporter = null;
const getTransporter = () => {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: EMAIL_HOST,
      port: EMAIL_PORT,
      secure: EMAIL_SECURE,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
      },
      ...(EMAIL_ALLOW_SELF_SIGNED_TLS
        ? {
            tls: {
              rejectUnauthorized: false,
            },
          }
        : {}),
    });
  }
  return _transporter;
};

export const sendVerificationEmail = async (email, code) => {
  try {
    const subject = "Vérifiez votre adresse email";

    const htmlMessage = `
      <div style="font-size: 16px; line-height: 1.6; color: #333;">
        <p style="color: #28a745; font-weight: bold; margin-bottom: 20px;">Bienvenue sur ${EMAIL_APP_NAME} !</p>

        <p>Merci de vous être inscrit. Pour finaliser votre inscription, veuillez confirmer votre adresse email.</p>

        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 8px 0; text-align: center;">
            <strong style="color: ${EMAIL_PRIMARY_COLOR};">Utilisez ce code de verification :</strong>
          </p>
          <p style="text-align: center; font-size: 32px; letter-spacing: 6px; margin: 12px 0; font-weight: bold; color: #222;">${code}</p>
        </div>

        <p>Saisissez ce code dans l'application pour valider votre compte.</p>

        <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0; color: #856404;">
            <strong>Note :</strong> Ce code expire dans 15 minutes.
          </p>
        </div>

        <p>Si vous n'avez pas créé de compte, vous pouvez ignorer cet email en toute sécurité.</p>
      </div>
    `;

    const mailOptions = {
      from: buildFromAddress(),
      to: email,
      subject: subject,
      html: buildEmailLayout(htmlMessage),
    };

    await getTransporter().sendMail(mailOptions);
    return true;
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error("EMAIL SEND FAILED —", error?.message || error);
      console.error("STATUS CODE  =", error?.code || 'N/A');
    }
    throw new Error(`sendVerificationEmail failed for ${email}: ${error?.message || error}`);
  }
};

export const sendPasswordResetEmail = async (email, token) => {
  try {
    const frontendBase = process.env.FRONTEND_URL || "http://localhost:5173"
    const resetUrl = `${frontendBase}/auth/reset-password/${token}`

    const subject = "Réinitialisez votre mot de passe";

    const htmlMessage = `
      <div style="font-size: 16px; line-height: 1.6; color: #333;">
        <p style="color: #28a745; font-weight: bold; margin-bottom: 20px;">Réinitialisation de mot de passe</p>

        <p>Vous avez demandé une réinitialisation de votre mot de passe. Pour définir un nouveau mot de passe, veuillez cliquer sur le bouton ci-dessous.</p>

        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 8px 0; text-align: center;">
            <strong style="color: ${EMAIL_PRIMARY_COLOR};">Cliquez sur le bouton ci-dessous pour réinitialiser votre mot de passe</strong>
          </p>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #28a745; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block;">
            Réinitialiser mon mot de passe
          </a>
        </div>

        <p>Si le bouton ne fonctionne pas, vous pouvez copier et coller le lien suivant dans votre navigateur :</p>
        <p style="word-break: break-all; background-color: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace;">${resetUrl}</p>

        <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0; color: #856404;">
            <strong>Note :</strong> Ce lien expire dans 1 heure.
          </p>
        </div>

        <p>Si vous n'avez pas demandé une réinitialisation de mot de passe, vous pouvez ignorer cet email en toute sécurité.</p>
      </div>
    `;

    const mailOptions = {
      from: buildFromAddress(),
      to: email,
      subject: subject,
      html: buildEmailLayout(htmlMessage),
    }

    await getTransporter().sendMail(mailOptions)
    return true
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error("sendPasswordResetEmail failed", error?.message || error)
    }
    return false
  }
}

export const sendNotificationEmail = async (email, subject, htmlMessage) => {
  try {
    const mailOptions = {
      from: buildFromAddress(),
      to: email,
      subject: subject,
      html: buildEmailLayout(htmlMessage),
    };

    await getTransporter().sendMail(mailOptions);
    return true;
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error("sendNotificationEmail failed", error?.message || error);
    }
    return false;
  }
};

export const sendDeliveryOtpEmail = async (email, otp, deliveryId) => {
  try {
    const subject = "Code OTP de livraison"

    const htmlMessage = `
      <div style="font-size: 16px; line-height: 1.6; color: #333;">
        <p style="color: #28a745; font-weight: bold; margin-bottom: 20px;">Code de confirmation de livraison</p>

        <p>Un chauffeur a accepte votre demande de livraison. Pour confirmer la reception, partagez ce code uniquement avec le destinataire au moment de la livraison.</p>

        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 8px 0; text-align: center;">
            <strong style="color: ${EMAIL_PRIMARY_COLOR};">Votre code OTP :</strong>
          </p>
          <p style="text-align: center; font-size: 32px; letter-spacing: 6px; margin: 12px 0; font-weight: bold; color: #222;">${otp}</p>
        </div>

        ${deliveryId ? `<p style="color: #666; font-size: 13px;">Reference: ${deliveryId}</p>` : ""}

        <p style="color: #856404; background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 12px; border-radius: 8px;">
          <strong>Important :</strong> Ne partagez pas ce code avec le chauffeur avant d'avoir recu le colis.
        </p>
      </div>
    `

    const mailOptions = {
      from: buildFromAddress(),
      to: email,
      subject,
      html: buildEmailLayout(htmlMessage),
    }

    await getTransporter().sendMail(mailOptions)
    return true
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error("sendDeliveryOtpEmail failed", error?.message || error)
    }
    return false
  }
}
