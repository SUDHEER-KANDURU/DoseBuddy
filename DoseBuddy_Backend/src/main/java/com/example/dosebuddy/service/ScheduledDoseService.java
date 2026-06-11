package com.example.dosebuddy.service;

import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.MedicationTime;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class ScheduledDoseService {

    private final MedicationRepository medicationRepository;
    private final IntakeLogRepository intakeLogRepository;

    public ScheduledDoseService(MedicationRepository medicationRepository,
                                IntakeLogRepository intakeLogRepository) {
        this.medicationRepository = medicationRepository;
        this.intakeLogRepository = intakeLogRepository;
    }

    public LocalDate earliestScheduledDate(User user, LocalDate fallback) {
        LocalDate earliest = medicationRepository.findEarliestStartDate(user);
        return earliest == null || earliest.isAfter(fallback) ? fallback : earliest;
    }

    @Transactional(readOnly = true)
    public Summary summarize(User user, LocalDate start, LocalDate end, LocalDateTime now) {
        if (start.isAfter(end)) {
            return Summary.empty(start, end);
        }

        List<Medication> medications = medicationRepository.findScheduledInRange(user, start, end);
        List<IntakeLog> logs = intakeLogRepository
                .findLogsWithMedication(user, start, end);

        Map<DoseKey, IntakeLog> canonicalLogs = new HashMap<>();
        for (IntakeLog log : logs) {
            if (log.getMedication() == null || log.getDate() == null || log.getTime() == null) continue;
            DoseKey key = new DoseKey(log.getMedication().getId(), log.getDate(), normalize(log.getTime()));
            canonicalLogs.merge(key, log, ScheduledDoseService::preferLog);
        }

        List<Dose> doses = new ArrayList<>();
        Map<LocalDate, MutableDailyCounts> daily = new LinkedHashMap<>();
        Map<String, Integer> missedByMedicine = new HashMap<>();
        int taken = 0;
        int missed = 0;
        int pending = 0;

        for (Medication medication : medications) {
            if (medication.getTimes() == null || medication.getTimes().isEmpty()) continue;
            LocalDate medicationStart = medication.getStartDate() == null ? start : medication.getStartDate();
            LocalDate medicationEnd = medication.getEndDate() == null ? end : medication.getEndDate();
            LocalDate first = medicationStart.isAfter(start) ? medicationStart : start;
            LocalDate last = medicationEnd.isBefore(end) ? medicationEnd : end;

            for (LocalDate date = first; !date.isAfter(last); date = date.plusDays(1)) {
                for (MedicationTime medicationTime : medication.getTimes()) {
                    if (medicationTime.getTimeOfDay() == null) continue;
                    LocalTime time = normalize(medicationTime.getTimeOfDay());
                    DoseKey key = new DoseKey(medication.getId(), date, time);
                    IntakeLog log = canonicalLogs.get(key);
                    String status = resolveStatus(log, date, time, now);
                    Long logId = log == null ? null : log.getId();

                    doses.add(new Dose(logId, medication.getId(), medication.getName(),
                            medication.getDosage(), date, time, status));
                    MutableDailyCounts counts = daily.computeIfAbsent(date, ignored -> new MutableDailyCounts());
                    counts.total++;
                    switch (status) {
                        case "TAKEN" -> { taken++; counts.taken++; }
                        case "MISSED" -> {
                            missed++;
                            counts.missed++;
                            missedByMedicine.merge(medication.getName(), 1, Integer::sum);
                        }
                        default -> { pending++; counts.pending++; }
                    }
                }
            }
        }

        doses.sort(Comparator.comparing(Dose::date).thenComparing(Dose::time));
        Map<LocalDate, DailyCounts> immutableDaily = new LinkedHashMap<>();
        Set<LocalDate> perfectDays = new HashSet<>();
        daily.forEach((date, counts) -> {
            DailyCounts value = new DailyCounts(counts.total, counts.taken, counts.missed, counts.pending);
            immutableDaily.put(date, value);
            if (counts.total > 0 && counts.taken == counts.total) perfectDays.add(date);
        });

        int completed = taken + missed;
        double adherence = completed == 0 ? 0.0
                : Math.round((taken * 1000.0) / completed) / 10.0;
        Map.Entry<String, Integer> mostMissed = missedByMedicine.entrySet().stream()
                .max(Map.Entry.comparingByValue()).orElse(null);

        return new Summary(start, end, doses, immutableDaily, perfectDays,
                doses.size(), taken, missed, pending, adherence,
                mostMissed == null ? "-" : mostMissed.getKey(),
                mostMissed == null ? 0 : mostMissed.getValue());
    }

    private static IntakeLog preferLog(IntakeLog left, IntakeLog right) {
        int statusCompare = Integer.compare(priority(right.getStatus()), priority(left.getStatus()));
        if (statusCompare > 0) return right;
        if (statusCompare < 0) return left;
        if (left.getUpdatedAt() == null) return right;
        if (right.getUpdatedAt() == null) return left;
        return right.getUpdatedAt().isAfter(left.getUpdatedAt()) ? right : left;
    }

    private static int priority(String status) {
        if ("TAKEN".equalsIgnoreCase(status)) return 3;
        if ("MISSED".equalsIgnoreCase(status)) return 2;
        return 1;
    }

    private static String resolveStatus(IntakeLog log, LocalDate date, LocalTime time,
                                        LocalDateTime now) {
        if (log != null && "TAKEN".equalsIgnoreCase(log.getStatus())) return "TAKEN";
        if (log != null && "MISSED".equalsIgnoreCase(log.getStatus())) return "MISSED";
        return LocalDateTime.of(date, time).isAfter(now) ? "PENDING" : "MISSED";
    }

    private static LocalTime normalize(LocalTime time) {
        return time.withSecond(0).withNano(0);
    }

    private record DoseKey(Long medicationId, LocalDate date, LocalTime time) {}

    private static class MutableDailyCounts {
        int total;
        int taken;
        int missed;
        int pending;
    }

    public record Dose(Long logId, Long medicationId, String medicationName, String dosage,
                       LocalDate date, LocalTime time, String status) {}

    public record DailyCounts(int total, int taken, int missed, int pending) {}

    public record Summary(LocalDate start, LocalDate end, List<Dose> doses,
                          Map<LocalDate, DailyCounts> daily, Set<LocalDate> perfectDays,
                          int total, int taken, int missed, int pending,
                          double adherencePercentage, String mostMissedMedicine,
                          int mostMissedCount) {
        static Summary empty(LocalDate start, LocalDate end) {
            return new Summary(start, end, List.of(), Map.of(), Set.of(),
                    0, 0, 0, 0, 0.0, "-", 0);
        }
    }
}
