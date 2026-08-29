package com.example.dosebuddy.service;

import com.resend.Resend;
import com.resend.core.exception.ResendException;
import com.resend.services.emails.model.CreateEmailOptions;
import com.resend.services.emails.model.CreateEmailResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

/**
 * Centralized email service for DoseBuddy.
 * Uses the Resend HTTP API (https://resend.com) instead of SMTP.
 *
 * Why Resend instead of Gmail SMTP?
 *   Render's free tier blocks ALL outbound SMTP ports (25, 465, 587).
 *   Resend sends over HTTPS (port 443) which is always open.
 *
 * Required environment variable:
 *   RESEND_API_KEY  — obtain from https://resend.com/api-keys
 *   MAIL_FROM       — verified sender address on Resend
 *                     (e.g. dosebuddy@yourdomain.com, or use onboarding@resend.dev for tests)
 */
@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);

    private final Resend resend;
    private final String fromAddress;
    private final String fromName;

    public EmailService(
            @Value("${RESEND_API_KEY:}") String apiKey,
            @Value("${MAIL_FROM:DoseBuddy <onboarding@resend.dev>}") String fromAddress,
            @Value("${app.mail.from-name:DoseBuddy}") String fromName) {

        if (apiKey == null || apiKey.isBlank()) {
            log.warn("[EmailService] RESEND_API_KEY is not set — emails will fail. Set it in Render environment.");
        }
        this.resend      = new Resend(apiKey == null ? "" : apiKey.trim());
        this.fromAddress = fromAddress.trim();
        this.fromName    = fromName.trim();
    }

    // ── OTP Email (Signup Verification) ──────────────────────────────────────

    @Async
    public void sendSignupOtp(String toEmail, String userName, String otp) {
        String subject = "DoseBuddy - Verify Your Email";
        String body = buildOtpEmailBody(userName, otp, "verify your email address",
                "This OTP is valid for 10 minutes.");
        sendHtmlEmail(toEmail, subject, body);
    }

    // ── OTP Email (Forgot Password) ─────────────────────────────────────────

    @Async
    public void sendPasswordResetOtp(String toEmail, String userName, String otp) {
        String subject = "DoseBuddy - Password Reset OTP";
        String body = buildOtpEmailBody(userName, otp, "reset your password",
                "This OTP is valid for 10 minutes. If you did not request this, please ignore this email.");
        sendHtmlEmail(toEmail, subject, body);
    }

    // ── Missed Dose Reminder Email ──────────────────────────────────────────

    @Async
    public void sendMissedDoseReminder(String toEmail, String recipientName,
                                       String patientName, String medicineName,
                                       String dosage, String scheduledTime) {
        String subject = "DoseBuddy - Missed Medication Reminder";
        String body = buildMissedDoseEmailBody(recipientName, patientName, medicineName, dosage, scheduledTime);
        sendHtmlEmail(toEmail, subject, body);
    }

    // ── Synchronous Test Email (Diagnostic endpoint) ─────────────────────────

    public void sendTestEmail(String toEmail) throws ResendException {
        String subject = "DoseBuddy - Diagnostic Test Email";
        String body = buildOtpEmailBody("Test User", "123456", "verify your email address",
                "This is a diagnostic test email from DoseBuddy on Resend.");
        CreateEmailOptions params = CreateEmailOptions.builder()
                .from(fromAddress)
                .to(toEmail)
                .subject(subject)
                .html(body)
                .build();
        CreateEmailResponse response = resend.emails().send(params);
        log.info("[EmailService] Test email sent to {} — Resend ID: {}", toEmail, response.getId());
    }

    public String getFromEmail() {
        return fromAddress;
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    private void sendHtmlEmail(String to, String subject, String htmlBody) {
        try {
            log.info("[EmailService] Sending '{}' to {} from {}", subject, to, fromAddress);
            CreateEmailOptions params = CreateEmailOptions.builder()
                    .from(fromAddress)
                    .to(to)
                    .subject(subject)
                    .html(htmlBody)
                    .build();
            CreateEmailResponse response = resend.emails().send(params);
            log.info("[EmailService] Email sent successfully — Resend ID: {}", response.getId());
        } catch (ResendException e) {
            log.error("[EmailService] Resend API error sending to {}: {}", to, e.getMessage(), e);
        } catch (Exception e) {
            log.error("[EmailService] Unexpected error sending to {}: {}", to, e.getMessage(), e);
        }
    }

    private String buildOtpEmailBody(String userName, String otp, String purpose, String footer) {
        return """
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
                <div style="text-align: center; margin-bottom: 24px;">
                    <span style="font-size: 40px;">💊</span>
                    <h2 style="color: #1e293b; margin: 8px 0 0;">DoseBuddy</h2>
                </div>
                <div style="background: #ffffff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <p style="color: #334155; font-size: 16px;">Hi <strong>%s</strong>,</p>
                    <p style="color: #475569; font-size: 14px;">Use the following OTP to %s:</p>
                    <div style="text-align: center; margin: 24px 0;">
                        <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #6366f1; background: #eef2ff; padding: 12px 24px; border-radius: 8px; border: 2px dashed #a5b4fc;">%s</span>
                    </div>
                    <p style="color: #64748b; font-size: 13px; text-align: center;">%s</p>
                </div>
                <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-top: 16px;">
                    &copy; DoseBuddy — Your personal medicine reminder
                </p>
            </div>
            """.formatted(userName, purpose, otp, footer);
    }

    private String buildMissedDoseEmailBody(String recipientName, String patientName,
                                            String medicineName, String dosage, String scheduledTime) {
        return """
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #fef2f2; border-radius: 12px;">
                <div style="text-align: center; margin-bottom: 24px;">
                    <span style="font-size: 40px;">💊</span>
                    <h2 style="color: #1e293b; margin: 8px 0 0;">DoseBuddy</h2>
                </div>
                <div style="background: #ffffff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <p style="color: #334155; font-size: 16px;">Hi <strong>%s</strong>,</p>
                    <p style="color: #dc2626; font-size: 15px; font-weight: 600;">⚠️ Missed Medication Alert</p>
                    <p style="color: #475569; font-size: 14px;">
                        <strong>%s</strong> missed their scheduled medication:
                    </p>
                    <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
                        <p style="margin: 0; color: #1e293b; font-weight: 600;">%s (%s)</p>
                        <p style="margin: 4px 0 0; color: #64748b; font-size: 13px;">Scheduled at: %s</p>
                    </div>
                    <p style="color: #475569; font-size: 14px;">
                        Please check in with them and ensure they take their medication as soon as possible.
                    </p>
                </div>
                <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-top: 16px;">
                    &copy; DoseBuddy — Your personal medicine reminder
                </p>
            </div>
            """.formatted(recipientName, patientName, medicineName, dosage, scheduledTime);
    }
}
