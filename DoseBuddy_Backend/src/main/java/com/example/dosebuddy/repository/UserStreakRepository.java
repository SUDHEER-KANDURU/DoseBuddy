package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.UserStreak;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface UserStreakRepository extends JpaRepository<UserStreak, Long> {

    Optional<UserStreak> findByUserId(Long userId);
}
