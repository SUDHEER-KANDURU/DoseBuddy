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
import com.example.dosebuddy.service.ActivityService;
import org.springframework.http.ResponseEntity;
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

    public IntakeLogController(IntakeLogRepository logRepo,
                               UserRepository userRepo,
                               MedicationRepository medRepo,
                               ActivityService activityService) {
        this.logRepo = logRepo;
        this.userRepo = userRepo;
        this.medRepo = medRepo;
        this.activityService = activityService;
    }

    @PostMapping("/mark")
    public ResponseEntity<?> markDose(@RequestBody MarkDoseRequest req) {
        if (req.getUserId() == null || req.getMedicationId() == null ||
                req.getDate() == null || req.getTime() == null) {
            return ResponseEntity.badRequest().body("Missing required fields");
        }

        User marker = userRepo.findById(req.getUserId()).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }

        Medication med = medRepo.findById(req.getMedicationId()).orElse(null);
        if (med == null) {
            return ResponseEntity.badRequest().body("Medication not found");
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

        IntakeLog log = new IntakeLog();
        log.setMarker(marker);
        log.setMedication(med);
        log.setDate(date);
        log.setTime(time);
        log.setStatus(status.toUpperCase());
        log.setScheduledTime(LocalDateTime.of(date, time));

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

        return ResponseEntity.ok().build();
    }

    @GetMapping("/history/{userId}")
    public ResponseEntity<?> getHistory(@PathVariable Long userId) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }

        List<IntakeLog> logs = logRepo.findByMarkerOrderByDateDescTimeDesc(marker);

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
    public ResponseEntity<?> getTodayLogs(@PathVariable Long userId) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }

        LocalDate today = LocalDate.now();
        List<IntakeLog> logs = logRepo.findByMarkerAndDate(marker, today);

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

    @GetMapping("/summary/week/{userId}")
    public ResponseEntity<?> getWeeklySummary(@PathVariable Long userId) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }

        LocalDate today = LocalDate.now();
        LocalDate start = today.minusDays(6);

        List<IntakeLog> logs = logRepo.findByMarkerAndDateBetween(marker, start, today);

        Map<LocalDate, Long> takenPerDay = logs.stream()
                .filter(l -> "TAKEN".equalsIgnoreCase(l.getStatus()))
                .collect(Collectors.groupingBy(
                        IntakeLog::getDate,
                        Collectors.counting()
                ));

        Map<LocalDate, Long> missedPerDay = logs.stream()
                .filter(l -> "MISSED".equalsIgnoreCase(l.getStatus()))
                .collect(Collectors.groupingBy(
                        IntakeLog::getDate,
                        Collectors.counting()
                ));

        List<DailySummaryDto> result = new ArrayList<>();
        for (int i = 0; i < 7; i++) {
            LocalDate d = start.plusDays(i);
            int taken  = takenPerDay.getOrDefault(d, 0L).intValue();
            int missed = missedPerDay.getOrDefault(d, 0L).intValue();
            result.add(new DailySummaryDto(d.toString(), taken, missed));
        }

        return ResponseEntity.ok(result);
    }

    @PostMapping("/mark-missed-batch")
    public ResponseEntity<?> markMissedBatch(@RequestBody List<MarkDoseRequest> requests) {
        if (requests == null || requests.isEmpty()) {
            return ResponseEntity.ok("No entries to process");
        }

        int created = 0;
        for (MarkDoseRequest req : requests) {
            if (req.getUserId() == null || req.getMedicationId() == null
                    || req.getDate() == null || req.getTime() == null) {
                continue;
            }

            User marker = userRepo.findById(req.getUserId()).orElse(null);
            if (marker == null) continue;

            Medication med = medRepo.findById(req.getMedicationId()).orElse(null);
            if (med == null) continue;

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

    @GetMapping("/adherence/stats/{userId}")
    public ResponseEntity<?> getAdherenceStats(@PathVariable Long userId) {
        User marker = userRepo.findById(userId).orElse(null);
        if (marker == null) {
            return ResponseEntity.badRequest().body("User not found");
        }

        LocalDate today      = LocalDate.now();
        LocalDate weekStart  = today.minusDays(6);
        LocalDate monthStart = today.minusDays(29);

        LocalDate statsStart = today.minusDays(89);
        List<IntakeLog> allLogs   = logRepo.findByMarkerAndDateBetween(marker, statsStart, today);
        List<IntakeLog> todayLogs = logRepo.findByMarkerAndDate(marker, today);
        List<IntakeLog> weekLogs  = logRepo.findByMarkerAndDateBetween(marker, weekStart, today);
        List<IntakeLog> monthLogs = logRepo.findByMarkerAndDateBetween(marker, monthStart, today);

        int totalDoses = allLogs.size();
        int takenDoses = (int) allLogs.stream().filter(l -> "TAKEN".equalsIgnoreCase(l.getStatus())).count();
        int missedDoses = (int) allLogs.stream().filter(l -> "MISSED".equalsIgnoreCase(l.getStatus())).count();
        int pendingDoses = (int) allLogs.stream().filter(l -> "PENDING".equalsIgnoreCase(l.getStatus())).count();

        double adherencePercentage = 0.0;
        if (totalDoses > 0) {
            adherencePercentage = Math.round((takenDoses * 100.0 / totalDoses) * 10.0) / 10.0;
        }

        int missedToday = (int) todayLogs.stream().filter(l -> "MISSED".equalsIgnoreCase(l.getStatus())).count();
        int missedThisWeek = (int) weekLogs.stream().filter(l -> "MISSED".equalsIgnoreCase(l.getStatus())).count();
        int missedThisMonth = (int) monthLogs.stream().filter(l -> "MISSED".equalsIgnoreCase(l.getStatus())).count();

        Map<String, Long> missedByMedicine = allLogs.stream()
                .filter(l -> "MISSED".equalsIgnoreCase(l.getStatus()))
                .collect(Collectors.groupingBy(
                        l -> l.getMedication().getName(),
                        Collectors.counting()
                ));

        String mostMissedMedicine = "-";
        int mostMissedCount = 0;
        if (!missedByMedicine.isEmpty()) {
            Map.Entry<String, Long> maxEntry = missedByMedicine.entrySet().stream()
                    .max(Map.Entry.comparingByValue())
                    .orElse(null);
            if (maxEntry != null) {
                mostMissedMedicine = maxEntry.getKey();
                mostMissedCount = maxEntry.getValue().intValue();
            }
        }

        AdherenceStatsDto stats = new AdherenceStatsDto(
                totalDoses, takenDoses, missedDoses, pendingDoses,
                adherencePercentage, missedToday, missedThisWeek, missedThisMonth,
                mostMissedMedicine, mostMissedCount
        );

        return ResponseEntity.ok(stats);
    }
}
