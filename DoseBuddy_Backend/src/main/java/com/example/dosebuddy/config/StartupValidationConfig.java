package com.example.dosebuddy.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Validates that required credentials are present at startup.
 * Gives a clear, actionable error instead of a confusing Hibernate/MySQL failure.
 */
@Configuration
public class StartupValidationConfig {

    /**
     * Fails fast with a readable message if DB_PASSWORD is missing,
     * before Hibernate attempts to connect and produces a cryptic error.
     */
    @Bean
    public String validateCredentials(
            @Value("${spring.datasource.password:}") String dbPassword,
            @Value("${spring.datasource.username:root}") String dbUsername) {

        if (dbPassword == null || dbPassword.isBlank()) {
            String message = """
                    
                    ╔══════════════════════════════════════════════════════════════╗
                    ║           DoseBuddy — STARTUP CONFIGURATION ERROR           ║
                    ╠══════════════════════════════════════════════════════════════╣
                    ║  DB_PASSWORD is not set. The application cannot connect     ║
                    ║  to MySQL without a database password.                      ║
                    ║                                                             ║
                    ║  Fix: open this file and add your credentials:              ║
                    ║    src/main/resources/application-local.properties          ║
                    ║                                                             ║
                    ║    DB_USERNAME=root                                         ║
                    ║    DB_PASSWORD=your-mysql-password                          ║
                    ║    GROQ_API_KEY=your-groq-key      (chat / symptoms)        ║
                    ║    GEMINI_API_KEY=your-gemini-key  (prescription OCR)       ║
                    ║                                                             ║
                    ║  That file is git-ignored and safe to store credentials in. ║
                    ╚══════════════════════════════════════════════════════════════╝
                    """;
            throw new IllegalStateException(message);
        }

        System.out.println("[DoseBuddy] DB credentials loaded for user: " + dbUsername);
        return "credentials-validated";
    }
}
