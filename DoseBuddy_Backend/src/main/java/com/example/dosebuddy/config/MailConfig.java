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
 * Custom JavaMailSender configuration.
 * Handles automatic formatting of Google App Passwords (stripping spaces),
 * enabling SSL socket factory for Port 465, setting TLS 1.2/1.3 protocols,
 * and configuring robust connection timeouts for cloud environments like Render.
 */
@Configuration
public class MailConfig {

    private static final Logger log = LoggerFactory.getLogger(MailConfig.class);

    @Value("${spring.mail.host:smtp.gmail.com}")
    private String host;

    @Value("${spring.mail.port:465}")
    private int port;

    @Value("${spring.mail.username:}")
    private String username;

    @Value("${spring.mail.password:}")
    private String password;

    @Value("${spring.mail.properties.mail.smtp.ssl.enable:true}")
    private boolean sslEnable;

    @Value("${spring.mail.properties.mail.smtp.starttls.enable:false}")
    private boolean starttlsEnable;

    @Bean
    public JavaMailSender javaMailSender() {
        JavaMailSenderImpl mailSender = new JavaMailSenderImpl();
        mailSender.setHost(host);
        mailSender.setPort(port);

        if (username != null && !username.isBlank()) {
            mailSender.setUsername(username.trim());
            log.info("[MailConfig] Configured SMTP username: {}", username.trim());
        } else {
            log.warn("[MailConfig] MAIL_USERNAME is empty or not set.");
        }

        if (password != null && !password.isBlank()) {
            // Remove any space characters from Google App Password (e.g., "abcd efgh ijkl mnop" -> "abcdefghijklmnop")
            String cleanPassword = password.replaceAll("\\s+", "");
            mailSender.setPassword(cleanPassword);
            log.info("[MailConfig] Configured SMTP password (length: {}).", cleanPassword.length());
        } else {
            log.warn("[MailConfig] MAIL_PASSWORD is empty or not set.");
        }

        Properties props = mailSender.getJavaMailProperties();
        props.put("mail.transport.protocol", "smtp");
        props.put("mail.smtp.auth", "true");

        if (port == 465 || sslEnable) {
            props.put("mail.smtp.ssl.enable", "true");
            props.put("mail.smtp.ssl.trust", "*");
            props.put("mail.smtp.ssl.protocols", "TLSv1.2 TLSv1.3");
            props.put("mail.smtp.socketFactory.port", String.valueOf(port));
            props.put("mail.smtp.socketFactory.class", "javax.net.ssl.SSLSocketFactory");
            props.put("mail.smtp.socketFactory.fallback", "false");
        } else {
            props.put("mail.smtp.starttls.enable", String.valueOf(starttlsEnable));
            props.put("mail.smtp.starttls.required", String.valueOf(starttlsEnable));
            props.put("mail.smtp.ssl.protocols", "TLSv1.2 TLSv1.3");
        }

        props.put("mail.smtp.connectiontimeout", "10000");
        props.put("mail.smtp.timeout", "10000");
        props.put("mail.smtp.writetimeout", "10000");

        return mailSender;
    }
}
