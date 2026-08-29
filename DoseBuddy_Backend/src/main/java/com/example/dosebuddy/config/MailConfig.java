package com.example.dosebuddy.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;

import java.util.Properties;

/**
 * Programmatic JavaMailSender configuration for DoseBuddy.
 *
 * Spring Boot's MailSenderAutoConfiguration is excluded in DosebuddyApplication.java
 * so this class is the SOLE source of the JavaMailSender bean.
 *
 * Fixes for Render Free tier:
 *   - Port 465 SMTPS (SSL from the start) — bypasses Render's port 587 block
 *   - App password whitespace stripping (Google shows spaces in the UI)
 *   - TLS 1.2/1.3 protocol negotiation
 *   - 10-second connection / read / write timeouts
 */
@Configuration
public class MailConfig {

    private static final Logger log = LoggerFactory.getLogger(MailConfig.class);

    /** SMTP host — defaults to Gmail */
    @Value("${MAIL_HOST:smtp.gmail.com}")
    private String host;

    /**
     * SMTP port from the Render environment variable MAIL_PORT.
     * Defaults to 465 (SMTPS / SSL).  If you kept MAIL_PORT=587 in Render,
     * we still enforce SSL via the socketFactory; set MAIL_PORT=465 to match.
     */
    @Value("${MAIL_PORT:465}")
    private int port;

    /** Gmail address — must match the authenticated account */
    @Value("${MAIL_USERNAME:}")
    private String username;

    /**
     * Google App Password. The Google UI shows spaces between groups, e.g.
     * "abcd efgh ijkl mnop". We strip those spaces automatically so copy-paste
     * from Google's UI works without modification.
     */
    @Value("${MAIL_PASSWORD:}")
    private String password;

    @Bean
    public JavaMailSender javaMailSender() {
        JavaMailSenderImpl mailSender = new JavaMailSenderImpl();
        mailSender.setHost(host.trim());
        mailSender.setPort(port);

        String cleanUsername = (username != null) ? username.trim() : "";
        String cleanPassword = (password != null) ? password.replaceAll("\\s+", "") : "";

        if (cleanUsername.isBlank()) {
            log.warn("[MailConfig] MAIL_USERNAME is empty — SMTP authentication will fail.");
        } else {
            mailSender.setUsername(cleanUsername);
            log.info("[MailConfig] SMTP username: {}", cleanUsername);
        }

        if (cleanPassword.isBlank()) {
            log.warn("[MailConfig] MAIL_PASSWORD is empty — SMTP authentication will fail.");
        } else {
            mailSender.setPassword(cleanPassword);
            log.info("[MailConfig] SMTP password length: {} chars", cleanPassword.length());
        }

        Properties props = mailSender.getJavaMailProperties();
        props.put("mail.transport.protocol", "smtp");
        props.put("mail.smtp.auth", "true");

        // ── Port 465: SMTPS (SSL from connection start) ──────────────────────
        // Port 587 STARTTLS is commonly blocked by Render's network on the free tier.
        // Port 465 SMTPS (SSL immediately) is allowed on Render free tier.
        props.put("mail.smtp.ssl.enable", "true");
        props.put("mail.smtp.ssl.protocols", "TLSv1.2 TLSv1.3");
        props.put("mail.smtp.ssl.trust", "smtp.gmail.com");
        props.put("mail.smtp.socketFactory.port", String.valueOf(port));
        props.put("mail.smtp.socketFactory.class", "javax.net.ssl.SSLSocketFactory");
        props.put("mail.smtp.socketFactory.fallback", "false");
        // STARTTLS must be disabled when using port 465 SMTPS
        props.put("mail.smtp.starttls.enable", "false");
        props.put("mail.smtp.starttls.required", "false");

        // ── Timeouts (10 s) ─────────────────────────────────────────────────
        props.put("mail.smtp.connectiontimeout", "10000");
        props.put("mail.smtp.timeout", "10000");
        props.put("mail.smtp.writetimeout", "10000");

        log.info("[MailConfig] JavaMailSender configured: {}:{} (SSL=true, STARTTLS=false)", host.trim(), port);

        return mailSender;
    }
}
