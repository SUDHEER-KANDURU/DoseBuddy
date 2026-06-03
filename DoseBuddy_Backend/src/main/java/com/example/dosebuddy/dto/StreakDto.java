package com.example.dosebuddy.dto;

import java.time.LocalDate;
import java.util.List;

public class StreakDto {

    private Long userId;
    private Integer currentStreak;
    private Integer longestStreak;
    private LocalDate lastPerfectDate;
    private LocalDate streakStartDate;
    private List<String> unlockedBadges;
    private List<BadgeDto> allBadges;

    private Integer perfectDaysThisWeek;
    private Integer perfectDaysThisMonth;

    private String newlyUnlockedBadge;

    public StreakDto() {}

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

    public List<String> getUnlockedBadges() { return unlockedBadges; }
    public void setUnlockedBadges(List<String> unlockedBadges) { this.unlockedBadges = unlockedBadges; }

    public List<BadgeDto> getAllBadges() { return allBadges; }
    public void setAllBadges(List<BadgeDto> allBadges) { this.allBadges = allBadges; }

    public Integer getPerfectDaysThisWeek() { return perfectDaysThisWeek; }
    public void setPerfectDaysThisWeek(Integer perfectDaysThisWeek) { this.perfectDaysThisWeek = perfectDaysThisWeek; }

    public Integer getPerfectDaysThisMonth() { return perfectDaysThisMonth; }
    public void setPerfectDaysThisMonth(Integer perfectDaysThisMonth) { this.perfectDaysThisMonth = perfectDaysThisMonth; }

    public String getNewlyUnlockedBadge() { return newlyUnlockedBadge; }
    public void setNewlyUnlockedBadge(String newlyUnlockedBadge) { this.newlyUnlockedBadge = newlyUnlockedBadge; }

    public static class BadgeDto {
        private String key;
        private String title;
        private String icon;
        private String description;
        private boolean unlocked;

        public BadgeDto() {}

        public BadgeDto(String key, String title, String icon, String description, boolean unlocked) {
            this.key = key;
            this.title = title;
            this.icon = icon;
            this.description = description;
            this.unlocked = unlocked;
        }

        public String getKey() { return key; }
        public void setKey(String key) { this.key = key; }

        public String getTitle() { return title; }
        public void setTitle(String title) { this.title = title; }

        public String getIcon() { return icon; }
        public void setIcon(String icon) { this.icon = icon; }

        public String getDescription() { return description; }
        public void setDescription(String description) { this.description = description; }

        public boolean isUnlocked() { return unlocked; }
        public void setUnlocked(boolean unlocked) { this.unlocked = unlocked; }
    }
}
