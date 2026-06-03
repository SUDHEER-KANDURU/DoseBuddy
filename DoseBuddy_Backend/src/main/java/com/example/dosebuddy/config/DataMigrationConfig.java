package com.example.dosebuddy.config;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class DataMigrationConfig implements ApplicationRunner {

    private final JdbcTemplate jdbcTemplate;

    public DataMigrationConfig(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public void run(ApplicationArguments args) {
        jdbcTemplate.update(
            "UPDATE users SET accepted_terms = FALSE WHERE accepted_terms IS NULL"
        );
    }
}
