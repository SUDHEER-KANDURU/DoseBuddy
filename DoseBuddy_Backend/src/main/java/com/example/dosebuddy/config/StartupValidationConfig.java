package com.example.dosebuddy.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

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
            @Value("${jwt.secret:}") String jwtSecret) {

        if (dbPassword == null || dbPassword.isBlank()) {
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

        System.out.println("[DoseBuddy] DB credentials loaded for user: " + dbUsername);
        System.out.println("[DoseBuddy] JWT secret validated (" + jwtSecret.length() + " chars).");
        return "credentials-validated";
    }
}
