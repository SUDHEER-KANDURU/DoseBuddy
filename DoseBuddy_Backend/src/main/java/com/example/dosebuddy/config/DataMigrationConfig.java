package com.example.dosebuddy.config;

import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Runs once at startup to:
 *   1. Fix NULL accepted_terms rows.
 *   2. Migrate any plaintext passwords to BCrypt hashes.
 *      A BCrypt hash always starts with "$2a$", "$2b$", or "$2y$".
 *      Anything else is treated as plaintext and re-hashed.
 */
@Component
public class DataMigrationConfig implements ApplicationRunner {

    private final JdbcTemplate    jdbcTemplate;
    private final UserRepository  userRepository;
    private final PasswordEncoder passwordEncoder;

    public DataMigrationConfig(JdbcTemplate    jdbcTemplate,
                               UserRepository  userRepository,
                               PasswordEncoder passwordEncoder) {
        this.jdbcTemplate    = jdbcTemplate;
        this.userRepository  = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public void run(ApplicationArguments args) {
        // Fix null accepted_terms
        jdbcTemplate.update(
            "UPDATE users SET accepted_terms = FALSE WHERE accepted_terms IS NULL"
        );

        // Migrate plaintext passwords to BCrypt
        List<User> allUsers = userRepository.findAll();
        int migrated = 0;
        for (User user : allUsers) {
            String hash = user.getPasswordHash();
            if (hash != null && !hash.startsWith("$2a$") && !hash.startsWith("$2b$") && !hash.startsWith("$2y$")) {
                user.setPasswordHash(passwordEncoder.encode(hash));
                userRepository.save(user);
                migrated++;
            }
        }
        if (migrated > 0) {
            System.out.printf("[DoseBuddy] Migrated %d plaintext password(s) to BCrypt.%n", migrated);
        } else {
            System.out.println("[DoseBuddy] All passwords are already BCrypt-hashed.");
        }
    }
}
