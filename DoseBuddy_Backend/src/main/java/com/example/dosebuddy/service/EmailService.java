package com.example.dosebuddy.service;

import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

/**
 * Centralized email service for DoseBuddy.
 * Handles OTP emails (signup verification, password reset) and missed-dose reminders.
 */
@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);

    private final JavaMailSender mailSender;

    @Value("${app.mail.from}")
    private String fromEmail;

    @Value("${app.mail.from-name}")
    private String fromName;

    public EmailService(JavaMailSender mailSender) {
        this.mailSender = mailSender;
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

    // ── Private helpers ─────────────────────────────────────────────────────

    private void sendHtmlEmail(String to, String subject, String htmlBody) {
        try {
            if (fromEmail == null || fromEmail.isBlank() || "noreply@dosebuddy.com".equalsIgnoreCase(fromEmail)) {
                log.warn("app.mail.from is set to '{}'. Note: Gmail SMTP requires From address to match your MAIL_USERNAME.", fromEmail);
            }
            log.info("Sending email to {} (Subject: '{}') using From address: {}", to, subject, fromEmail);
            MimeMessage message = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
            helper.setFrom(fromEmail, fromName);
            helper.setTo(to);
            helper.setSubject(subject);
            helper.setText(htmlBody, true);
            mailSender.send(message);
            log.info("Email sent successfully to {}", to);
        } catch (MessagingException | java.io.UnsupportedEncodingException e) {
            log.error("Failed to send email to {}: {} (Cause: {})", to, e.getMessage(), e.getCause() != null ? e.getCause().getMessage() : "N/A", e);
        } catch (Exception e) {
            log.error("Unexpected error sending email to {}: {}", to, e.getMessage(), e);
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
