package com.example.dosebuddy.service;

import com.example.dosebuddy.dto.StreakDto;
import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.model.UserStreak;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.repository.UserStreakRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class StreakService {

    private static final List<BadgeDef> BADGE_DEFS = List.of(
        new BadgeDef("FIRST_DOSE",       "First Step",          "💊",
                     "Took your very first dose",                1,  0,  0),
        new BadgeDef("THREE_DAY",        "3-Day Streak",        "🔥",
                     "3 consecutive perfect days",               0,  3,  0),
        new BadgeDef("WEEK_WARRIOR",     "Week Warrior",        "⚡",
                     "7-day streak — perfect week",              0,  7,  0),
        new BadgeDef("PERFECT_WEEK",     "Perfect Week",        "🌟",
                     "All doses taken for 7 days straight",      0,  7,  0),
        new BadgeDef("FORTNIGHT",        "Fortnight Champion",  "🏅",
                     "14-day streak — two perfect weeks",        0, 14,  0),
        new BadgeDef("MONTH_MASTER",     "Month Master",        "🏆",
                     "30-day streak — incredible consistency",   0, 30,  0),
        new BadgeDef("ADHERENCE_MASTER", "Adherence Master",    "👑",
                     "90% adherence over 30 days",               0,  0, 90),
        new BadgeDef("CENTURY",          "Century Club",        "💯",
                     "100 total doses taken",                   100,  0,  0),
        new BadgeDef("CONSISTENCY",      "Consistency Champ",   "🎯",
                     "30 days of tracking — never gave up",      0,  0,  0)
    );

    private final UserStreakRepository streakRepo;
    private final IntakeLogRepository  logRepo;
    private final UserRepository       userRepo;

    public StreakService(UserStreakRepository streakRepo,
                         IntakeLogRepository logRepo,
                         UserRepository userRepo) {
        this.streakRepo = streakRepo;
        this.logRepo    = logRepo;
        this.userRepo   = userRepo;
    }

    public StreakDto getStreak(Long userId) {
        UserStreak streak = streakRepo.findByUserId(userId)
                .orElseGet(() -> createEmpty(userId));
        return toDto(streak, userId, null);
    }

    @Transactional
    public StreakDto recalculate(Long userId) {
        UserStreak streak = streakRepo.findByUserId(userId)
                .orElseGet(() -> createEmpty(userId));

        Set<String> previousBadges = parseBadges(streak.getUnlockedBadges());

        User user = userRepo.findById(userId).orElse(null);
        if (user == null) {
            return toDto(streak, userId, null);
        }
        List<IntakeLog> allLogs = logRepo.findByMarker(user);

        if (allLogs.isEmpty()) {
            streak.setCurrentStreak(0);
            streak.setLongestStreak(0);
            streak.setLastPerfectDate(null);
            streak.setStreakStartDate(null);
            streakRepo.save(streak);
            return toDto(streak, userId, null);
        }

        LocalDate today = LocalDate.now();
        Map<LocalDate, List<IntakeLog>> byDate = allLogs.stream()
                .collect(Collectors.groupingBy(IntakeLog::getDate));

        Set<LocalDate> perfectDays = byDate.entrySet().stream()
                .filter(e -> e.getValue().stream()
                        .allMatch(l -> "TAKEN".equalsIgnoreCase(l.getStatus())))
                .map(Map.Entry::getKey)
                .collect(Collectors.toSet());

        int currentStreak = 0;
        LocalDate cursor = today;

        if (!perfectDays.contains(today)) {
            cursor = today.minusDays(1);
        }

        while (perfectDays.contains(cursor)) {
            currentStreak++;
            cursor = cursor.minusDays(1);
        }

        int longestStreak = Math.max(streak.getLongestStreak(), currentStreak);

        if (!perfectDays.isEmpty()) {
            List<LocalDate> sorted = perfectDays.stream().sorted().collect(Collectors.toList());
            int run = 1, maxRun = 1;
            for (int i = 1; i < sorted.size(); i++) {
                if (sorted.get(i).equals(sorted.get(i - 1).plusDays(1))) {
                    run++;
                    maxRun = Math.max(maxRun, run);
                } else {
                    run = 1;
                }
            }
            longestStreak = Math.max(longestStreak, maxRun);
        }

        LocalDate streakStart = currentStreak > 0
                ? (perfectDays.contains(today) ? today : today.minusDays(1))
                        .minusDays(currentStreak - 1)
                : null;

        LocalDate lastPerfect = perfectDays.stream()
                .filter(d -> !d.isAfter(today))
                .max(Comparator.naturalOrder())
                .orElse(null);

        int perfectThisWeek  = (int) perfectDays.stream()
                .filter(d -> !d.isBefore(today.minusDays(6)) && !d.isAfter(today))
                .count();
        int perfectThisMonth = (int) perfectDays.stream()
                .filter(d -> !d.isBefore(today.minusDays(29)) && !d.isAfter(today))
                .count();

        long totalTaken = allLogs.stream()
                .filter(l -> "TAKEN".equalsIgnoreCase(l.getStatus()))
                .count();

        List<IntakeLog> last30 = allLogs.stream()
                .filter(l -> !l.getDate().isBefore(today.minusDays(29)))
                .collect(Collectors.toList());
        double adherence30 = last30.isEmpty() ? 0.0
                : (last30.stream().filter(l -> "TAKEN".equalsIgnoreCase(l.getStatus())).count()
                   * 100.0 / last30.size());

        Set<String> newBadges = new HashSet<>(previousBadges);

        for (BadgeDef def : BADGE_DEFS) {
            if (newBadges.contains(def.key)) continue;

            boolean unlock = false;
            switch (def.key) {
                case "FIRST_DOSE"       -> unlock = totalTaken >= 1;
                case "THREE_DAY"        -> unlock = currentStreak >= 3 || longestStreak >= 3;
                case "WEEK_WARRIOR"     -> unlock = currentStreak >= 7 || longestStreak >= 7;
                case "PERFECT_WEEK"     -> unlock = perfectThisWeek >= 7;
                case "FORTNIGHT"        -> unlock = currentStreak >= 14 || longestStreak >= 14;
                case "MONTH_MASTER"     -> unlock = currentStreak >= 30 || longestStreak >= 30;
                case "ADHERENCE_MASTER" -> unlock = adherence30 >= 90.0 && last30.size() >= 10;
                case "CENTURY"          -> unlock = totalTaken >= 100;
                case "CONSISTENCY"      -> unlock = !byDate.isEmpty() && byDate.size() >= 30;
                default                 -> {}
            }
            if (unlock) newBadges.add(def.key);
        }

        Set<String> justUnlocked = new HashSet<>(newBadges);
        justUnlocked.removeAll(previousBadges);
        String newlyUnlocked = justUnlocked.isEmpty() ? null : justUnlocked.iterator().next();

        streak.setCurrentStreak(currentStreak);
        streak.setLongestStreak(longestStreak);
        streak.setLastPerfectDate(lastPerfect);
        streak.setStreakStartDate(streakStart);
        streak.setUnlockedBadges(String.join(",", newBadges));
        streakRepo.save(streak);

        StreakDto dto = toDto(streak, userId, newlyUnlocked);
        dto.setPerfectDaysThisWeek(perfectThisWeek);
        dto.setPerfectDaysThisMonth(perfectThisMonth);
        return dto;
    }


    private UserStreak createEmpty(Long userId) {
        UserStreak s = new UserStreak(userId);
        return streakRepo.save(s);
    }

    private Set<String> parseBadges(String raw) {
        if (raw == null || raw.isBlank()) return new HashSet<>();
        return new HashSet<>(Arrays.asList(raw.split(",")));
    }

    private StreakDto toDto(UserStreak streak, Long userId, String newlyUnlocked) {
        StreakDto dto = new StreakDto();
        dto.setUserId(userId);
        dto.setCurrentStreak(streak.getCurrentStreak() != null ? streak.getCurrentStreak() : 0);
        dto.setLongestStreak(streak.getLongestStreak() != null ? streak.getLongestStreak() : 0);
        dto.setLastPerfectDate(streak.getLastPerfectDate());
        dto.setStreakStartDate(streak.getStreakStartDate());
        dto.setNewlyUnlockedBadge(newlyUnlocked);

        Set<String> unlocked = parseBadges(streak.getUnlockedBadges());
        dto.setUnlockedBadges(new ArrayList<>(unlocked));

        List<StreakDto.BadgeDto> allBadges = BADGE_DEFS.stream()
                .map(def -> new StreakDto.BadgeDto(
                        def.key, def.title, def.icon, def.description,
                        unlocked.contains(def.key)))
                .collect(Collectors.toList());
        dto.setAllBadges(allBadges);

        dto.setPerfectDaysThisWeek(0);
        dto.setPerfectDaysThisMonth(0);

        return dto;
    }

    private record BadgeDef(
            String key,
            String title,
            String icon,
            String description,
            int totalDosesRequired,
            int streakRequired,
            double adherenceRequired
    ) {}
}
