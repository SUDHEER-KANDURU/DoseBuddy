package com.example.dosebuddy.service;

import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.MedicationTime;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.List;

@Service
public class MissedDoseSchedulerService {

    private final MedicationRepository medRepo;
    private final IntakeLogRepository  logRepo;
    private final ActivityService      activityService;

    public MissedDoseSchedulerService(MedicationRepository medRepo,
                                      IntakeLogRepository logRepo,
                                      ActivityService activityService) {
        this.medRepo         = medRepo;
        this.logRepo         = logRepo;
        this.activityService = activityService;
    }

    @Scheduled(fixedDelay = 300_000)
    @Transactional
    public void markMissedDoses() {
        LocalDate today  = LocalDate.now();
        LocalTime cutoff = LocalTime.now().minusMinutes(5); // 5-minute grace period

        List<Medication> allMeds = medRepo.findByStartDateLessThanEqualAndEndDateGreaterThanEqual(today, today);

        for (Medication med : allMeds) {

            User owner = med.getUser();
            if (owner == null) continue;

            List<MedicationTime> times = med.getTimes();
            if (times == null || times.isEmpty()) continue;

            for (MedicationTime mt : times) {
                LocalTime scheduledTime = mt.getTimeOfDay();
                if (scheduledTime == null) continue;

                if (!scheduledTime.isBefore(cutoff)) continue;

                boolean exists = logRepo
                        .findByMarkerAndMedicationAndDateAndTime(owner, med, today, scheduledTime)
                        .isPresent();
                if (exists) continue;

                IntakeLog log = new IntakeLog();
                log.setMarker(owner);
                log.setMedication(med);
                log.setDate(today);
                log.setTime(scheduledTime);
                log.setStatus("MISSED");
                log.setScheduledTime(LocalDateTime.of(today, scheduledTime));
                log.setMissedTime(LocalDateTime.now());
                logRepo.save(log);

                String timeStr = scheduledTime.toString().substring(0, 5);
                String msg = String.format("Missed %s (%s) scheduled for %s",
                        med.getName(), med.getDosage(), timeStr);
                activityService.logActivity(owner, "DOSE_MISSED", msg, "INTAKE_LOG", log.getId());
            }
        }
    }
}
