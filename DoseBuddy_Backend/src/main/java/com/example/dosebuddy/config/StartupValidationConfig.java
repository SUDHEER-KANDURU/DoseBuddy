package com.example.dosebuddy.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * Validates that required credentials are present at startup.
 * Gives a clear, actionable error instead of a confusing failure.
 */
@Configuration
public class StartupValidationConfig {

    @Bean
    public String validateCredentials(
            @Value("${spring.datasource.password:}") String dbPassword,
            @Value("${spring.datasource.username:root}") String dbUsername,
            @Value("${spring.datasource.url:}") String dbUrl,
            @Value("${jwt.secret:}") String jwtSecret,
            Environment env) {

        // Skip database password validation for H2 (test profile) and when URL contains h2
        boolean isH2Database = dbUrl.contains(":h2:") || java.util.Arrays.asList(env.getActiveProfiles()).contains("test");
        
        if (!isH2Database && (dbPassword == null || dbPassword.isBlank())) {
            throw new IllegalStateException("""
                    
                    ╔══════════════════════════════════════════════════════════════╗
                    ║           DoseBuddy — STARTUP CONFIGURATION ERROR           ║
                    ╠══════════════════════════════════════════════════════════════╣
                    ║  DB_PASSWORD is not set. Application cannot connect to DB.  ║
                    ║  Fix: add DB_PASSWORD to application-local.properties       ║
                    ╚══════════════════════════════════════════════════════════════╝
                    """);
        }

        if (jwtSecret == null || jwtSecret.isBlank()) {
            throw new IllegalStateException("""
                    
                    ╔══════════════════════════════════════════════════════════════╗
                    ║           DoseBuddy — STARTUP CONFIGURATION ERROR           ║
                    ╠══════════════════════════════════════════════════════════════╣
                    ║  JWT_SECRET is not set. JWT authentication cannot work.     ║
                    ║  Fix: add JWT_SECRET to application-local.properties or     ║
                    ║  as a Railway environment variable (min 32 characters).     ║
                    ╚══════════════════════════════════════════════════════════════╝
                    """);
        }

        if (jwtSecret.length() < 32) {
            throw new IllegalStateException(
                    "[DoseBuddy] JWT_SECRET must be at least 32 characters for HS256.");
        }

        if (isH2Database) {
            System.out.println("[DoseBuddy] Using H2 in-memory database for testing");
        } else {
            System.out.println("[DoseBuddy] DB credentials loaded for user: " + dbUsername);
        }
        System.out.println("[DoseBuddy] JWT secret validated (" + jwtSecret.length() + " chars).");
        return "credentials-validated";
    }
}
