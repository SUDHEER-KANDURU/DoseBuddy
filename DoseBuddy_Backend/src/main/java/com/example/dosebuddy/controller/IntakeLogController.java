package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.AdherenceStatsDto;
import com.example.dosebuddy.dto.DailySummaryDto;
import com.example.dosebuddy.dto.IntakeLogDto;
import com.example.dosebuddy.dto.MarkDoseRequest;
import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.ActivityService;
import com.example.dosebuddy.service.ScheduledDoseService;
import com.example.dosebuddy.service.StreakService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.data.domain.PageRequest;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.*;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/logs")
@CrossOrigin("*")
public class IntakeLogController {

    private final IntakeLogRepository logRepo;
    private final UserRepository userRepo;
    private final MedicationRepository medRepo;
    private final ActivityService activityService;
    private final ScheduledDoseService scheduledDoseService;
    private final StreakService streakService;

    public IntakeLogController(IntakeLogRepository logRepo,
                               UserRepository userRepo,
                               MedicationRepository medRepo,
                               ActivityService activityService,
                               ScheduledDoseService scheduledDoseService,
                               StreakService streakService) {
        this.logRepo = logRepo;
        this.userRepo = userRepo;
        this.medRepo = medRepo;
        this.activityService = activityService;
        this.scheduledDoseService = scheduledDoseService;
        this.streakService = streakService;
    }

    @PostMapping("/mark")
    public ResponseEntity<?> markDose(@RequestBody MarkDoseRequest req,
                                      @AuthenticationPrincipal UserPrincipal principal) {
        if (req.getMedicationId() == null ||
                req.getDate() == null || req.getTime() == null) {
            return ResponseEntity.badRequest().body("Missing required fields");
        }

        Medication med = medRepo.findById(req.getMedicationId()).orElse(null);
        if (med == null) {
            return ResponseEntity.badRequest().body("Medication not found");
        }
        User marker = med.getUser();
        if (marker == null || !canAccessUser(marker, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        LocalDate date;
        LocalTime time;
        try {
            date = LocalDate.parse(req.getDate());
            time = LocalTime.parse(req.getTime());
        } catch (Exception e) {
            return ResponseEntity.badRequest().body("Invalid date or time format");
        }

        String status = req.getStatus();
        if (status == null || status.isBlank()) {
            status = "TAKEN";
        }

        IntakeLog log = logRepo.findByMarkerAndMedicationAndDateAndTime(marker, med, date, time)
                .orElseGet(IntakeLog::new);
        log.setMarker(marker);
        log.setMedication(med);
        log.setDate(date);
        log.setTime(time);
        log.setStatus(status.toUpperCase());
        log.setScheduledTime(LocalDateTime.of(date, time));
        log.setTakenTime(null);
        log.setMissedTime(null);

        if ("TAKEN".equalsIgnoreCase(status)) {
            log.setTakenTime(LocalDateTime.now());
        } else if ("MISSED".equalsIgnoreCase(status)) {
            log.setMissedTime(LocalDateTime.now());
        }

        logRepo.save(log);

        String activityMessage;
        String activityType;
        if ("TAKEN".equalsIgnoreCase(status)) {
            activityMessage = String.format("Took %s (%s) at %s", med.getName(), med.getDosage(), time.toString().substring(0, 5));
            activityType = "DOSE_TAKEN";
        } else if ("MISSED".equalsIgnoreCase(status)) {
            activityMessage = String.format("Missed %s (%s) scheduled for %s", med.getName(), med.getDosage(), time.toString().substring(0, 5));
            activityType = "DOSE_MISSED";
        } else {
            activityMessage = String.format("Scheduled %s (%s) for %s", med.getName(), med.getDosage(), time.toString().substring(0, 5));
            activityType = "DOSE_SCHEDULED";
        }
        
        activityService.logActivity(marker, activityType, activityMessage, "INTAKE_LOG", log.getId());

        streakService.recalculate(marker.getId());

        return ResponseEntity.ok().build();
    }

    @GetMapping("/history/{userId}")
    public ResponseEntity<?> getHistory(@PathVariable Long userId,
                                        @RequestParam(defaultValue = "0") int page,
                                        @RequestParam(defaultValue = "100") int size,
                                        @AuthenticationPrincipal UserPrincipal principal) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(marker, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        int safePage = Math.max(0, page);
        int safeSize = Math.min(500, Math.max(1, size));
        List<IntakeLog> logs = logRepo.findByMarkerOrderByDateDescTimeDesc(
                marker, PageRequest.of(safePage, safeSize)).getContent();

        List<IntakeLogDto> dtoList = logs.stream()
                .map(l -> new IntakeLogDto(
                        l.getId(),
                        l.getDate().toString(),
                        l.getTime().toString().substring(0, 5),
                        l.getMedication().getId(),
                        l.getMedication().getName(),
                        l.getMedication().getDosage(),
                        l.getStatus()
                ))
                .collect(Collectors.toList());

        return ResponseEntity.ok(dtoList);
    }

    @GetMapping("/today/{userId}")
    public ResponseEntity<?> getTodayLogs(@PathVariable Long userId,
                                          @AuthenticationPrincipal UserPrincipal principal) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(marker, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        LocalDate today = LocalDate.now();
        ScheduledDoseService.Summary summary = scheduledDoseService.summarize(
                marker, today, today, LocalDateTime.now());

        List<IntakeLogDto> dtoList = summary.doses().stream()
                .map(d -> new IntakeLogDto(
                        d.logId(),
                        d.date().toString(),
                        d.time().toString().substring(0, 5),
                        d.medicationId(),
                        d.medicationName(),
                        d.dosage(),
                        d.status()
                ))
                .collect(Collectors.toList());

        return ResponseEntity.ok(dtoList);
    }

    @GetMapping("/summary/week/{userId}")
    public ResponseEntity<?> getWeeklySummary(@PathVariable Long userId,
                                              @AuthenticationPrincipal UserPrincipal principal) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(marker, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        LocalDate today = LocalDate.now();
        LocalDate start = today.minusDays(6);

        ScheduledDoseService.Summary summary = scheduledDoseService.summarize(
                marker, start, today, LocalDateTime.now());

        List<DailySummaryDto> result = new ArrayList<>();
        for (int i = 0; i < 7; i++) {
            LocalDate d = start.plusDays(i);
            ScheduledDoseService.DailyCounts counts = summary.daily().get(d);
            int taken = counts == null ? 0 : counts.taken();
            int missed = counts == null ? 0 : counts.missed();
            result.add(new DailySummaryDto(d.toString(), taken, missed));
        }

        return ResponseEntity.ok(result);
    }

    @GetMapping("/summary/{userId}")
    public ResponseEntity<?> getSummary(@PathVariable Long userId,
                                        @RequestParam(defaultValue = "7") int days,
                                        @AuthenticationPrincipal UserPrincipal principal) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(marker, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        LocalDate today = LocalDate.now();
        int safeDays = Math.min(3650, Math.max(1, days));
        LocalDate start = today.minusDays(safeDays - 1L);
        ScheduledDoseService.Summary summary = scheduledDoseService.summarize(
                marker, start, today, LocalDateTime.now());

        List<DailySummaryDto> result = new ArrayList<>(safeDays);
        for (int i = 0; i < safeDays; i++) {
            LocalDate date = start.plusDays(i);
            ScheduledDoseService.DailyCounts counts = summary.daily().get(date);
            result.add(new DailySummaryDto(date.toString(),
                    counts == null ? 0 : counts.taken(),
                    counts == null ? 0 : counts.missed()));
        }
        return ResponseEntity.ok(result);
    }

    @PostMapping("/mark-missed-batch")
    public ResponseEntity<?> markMissedBatch(@RequestBody List<MarkDoseRequest> requests,
                                             @AuthenticationPrincipal UserPrincipal principal) {
        if (requests == null || requests.isEmpty()) {
            return ResponseEntity.ok("No entries to process");
        }

        int created = 0;
        for (MarkDoseRequest req : requests) {
            if (req.getMedicationId() == null || req.getDate() == null || req.getTime() == null) {
                continue;
            }

            Medication med = medRepo.findById(req.getMedicationId()).orElse(null);
            if (med == null) continue;
            User marker = med.getUser();
            if (marker == null || !canAccessUser(marker, principal)) continue;

            LocalDate date;
            LocalTime time;
            try {
                date = LocalDate.parse(req.getDate());
                time = LocalTime.parse(req.getTime());
            } catch (Exception e) {
                continue;
            }

            boolean exists = logRepo.findByMarkerAndMedicationAndDateAndTime(marker, med, date, time).isPresent();
            if (exists) continue;

            IntakeLog log = new IntakeLog();
            log.setMarker(marker);
            log.setMedication(med);
            log.setDate(date);
            log.setTime(time);
            log.setStatus("MISSED");
            log.setScheduledTime(LocalDateTime.of(date, time));
            log.setMissedTime(LocalDateTime.now());
            logRepo.save(log);

            String msg = String.format("Missed %s (%s) scheduled for %s",
                    med.getName(), med.getDosage(), time.toString().substring(0, 5));
            activityService.logActivity(marker, "DOSE_MISSED", msg, "INTAKE_LOG", log.getId());

            created++;
        }

        return ResponseEntity.ok(Map.of("created", created));
    }

    /**
     * Returns adherence statistics for a user over the requested period.
     *
     * @param userId  the user whose stats are calculated
     * @param days    number of days to look back (7, 30, 90, …).
     *                Pass 0 or omit to get all-time stats (bounded to
     *                a 3650-day window to keep queries sane).
     */
    @GetMapping("/adherence/stats/{userId}")
    public ResponseEntity<?> getAdherenceStats(
            @PathVariable Long userId,
            @RequestParam(name = "days", defaultValue = "0") int days,
            @AuthenticationPrincipal UserPrincipal principal) {

        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(marker, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        LocalDate today      = LocalDate.now();
        LocalDate weekStart  = today.minusDays(6);
        LocalDate monthStart = today.minusDays(29);

        // Determine the stats window.
        // days == 0  → "All Time"  (use a large but bounded window)
        // days > 0   → exactly that many calendar days back from today
        LocalDate statsStart = (days > 0)
                ? today.minusDays(days - 1)   // inclusive: e.g. days=7 → last 7 days
                : scheduledDoseService.earliestScheduledDate(marker, today);

        ScheduledDoseService.Summary summary = scheduledDoseService.summarize(
                marker, statsStart, today, LocalDateTime.now());
        ScheduledDoseService.Summary recentSummary = statsStart.isAfter(monthStart)
                ? scheduledDoseService.summarize(marker, monthStart, today, LocalDateTime.now())
                : summary;

        int missedToday = Optional.ofNullable(recentSummary.daily().get(today))
                .map(ScheduledDoseService.DailyCounts::missed).orElse(0);
        int missedThisWeek = recentSummary.daily().entrySet().stream()
                .filter(e -> !e.getKey().isBefore(weekStart))
                .mapToInt(e -> e.getValue().missed()).sum();
        int missedThisMonth = recentSummary.daily().values().stream()
                .mapToInt(ScheduledDoseService.DailyCounts::missed).sum();

        AdherenceStatsDto stats = new AdherenceStatsDto(
                summary.total(), summary.taken(), summary.missed(), summary.pending(),
                summary.adherencePercentage(), missedToday, missedThisWeek, missedThisMonth,
                summary.mostMissedMedicine(), summary.mostMissedCount()
        );

        return ResponseEntity.ok(stats);
    }

    private boolean canAccessUser(User target, UserPrincipal principal) {
        if (target == null || principal == null) return false;
        if (target.getId().equals(principal.getUserId())) return true;
        User authUser = principal.getUser();
        return "CAREGIVER".equalsIgnoreCase(authUser.getRole())
                && authUser.getPatientEmail() != null
                && authUser.getPatientEmail().equalsIgnoreCase(target.getEmail());
    }
}
