package com.example.dosebuddy.model;

import jakarta.persistence.*;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Entity
@Table(name = "user_streaks")
public class UserStreak {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private Long userId;

    @Column(nullable = false)
    private Integer currentStreak = 0;

    @Column(nullable = false)
    private Integer longestStreak = 0;

    @Column(name = "last_perfect_date")
    private LocalDate lastPerfectDate;

    @Column(name = "streak_start_date")
    private LocalDate streakStartDate;

    @Column(name = "unlocked_badges", length = 1000)
    private String unlockedBadges = "";

    @Column(name = "updated_at")
    private LocalDateTime updatedAt;

    @PrePersist
    @PreUpdate
    protected void onUpdate() {
        updatedAt = LocalDateTime.now();
    }

    public UserStreak() {}

    public UserStreak(Long userId) {
        this.userId = userId;
        this.currentStreak = 0;
        this.longestStreak = 0;
        this.unlockedBadges = "";
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }

    public Integer getCurrentStreak() { return currentStreak; }
    public void setCurrentStreak(Integer currentStreak) { this.currentStreak = currentStreak; }

    public Integer getLongestStreak() { return longestStreak; }
    public void setLongestStreak(Integer longestStreak) { this.longestStreak = longestStreak; }

    public LocalDate getLastPerfectDate() { return lastPerfectDate; }
    public void setLastPerfectDate(LocalDate lastPerfectDate) { this.lastPerfectDate = lastPerfectDate; }

    public LocalDate getStreakStartDate() { return streakStartDate; }
    public void setStreakStartDate(LocalDate streakStartDate) { this.streakStartDate = streakStartDate; }

    public String getUnlockedBadges() { return unlockedBadges; }
    public void setUnlockedBadges(String unlockedBadges) { this.unlockedBadges = unlockedBadges != null ? unlockedBadges : ""; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
