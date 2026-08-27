package com.example.dosebuddy.service;

import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

/**
 * Scheduler that sends email reminders to patient and their linked caregivers
 * when a dose has been missed for more than 1 hour.
 *
 * Runs every 10 minutes. Picks up any IntakeLog with:
 *   - status = MISSED
 *   - emailReminderSent = false
 *   - scheduledTime is at least 1 hour ago
 */
@Service
public class MissedDoseEmailScheduler {

    private static final Logger log = LoggerFactory.getLogger(MissedDoseEmailScheduler.class);

    private final IntakeLogRepository logRepo;
    private final UserRepository      userRepo;
    private final EmailService        emailService;

    public MissedDoseEmailScheduler(IntakeLogRepository logRepo,
                                    UserRepository userRepo,
                                    EmailService emailService) {
        this.logRepo      = logRepo;
        this.userRepo     = userRepo;
        this.emailService = emailService;
    }

    @Scheduled(fixedDelay = 600_000) // every 10 minutes
    @Transactional
    public void sendMissedDoseEmails() {
        LocalDate today = LocalDate.now();
        // Only send email for doses missed more than 1 hour ago
        LocalDateTime oneHourAgo = LocalDateTime.now().minusHours(1);

        List<IntakeLog> missedLogs = logRepo.findMissedDosesNeedingEmailReminder(today, oneHourAgo);

        if (missedLogs.isEmpty()) return;

        log.info("Found {} missed dose(s) needing email reminder", missedLogs.size());

        for (IntakeLog intakeLog : missedLogs) {
            try {
                sendReminderForLog(intakeLog);
                intakeLog.setEmailReminderSent(true);
                logRepo.save(intakeLog);
            } catch (Exception e) {
                log.error("Failed to send missed dose email for log id={}: {}",
                        intakeLog.getId(), e.getMessage(), e);
            }
        }
    }

    private void sendReminderForLog(IntakeLog intakeLog) {
        Medication med = intakeLog.getMedication();
        if (med == null) return;

        User patient = intakeLog.getMarker();
        if (patient == null) return;

        String medicineName = med.getName();
        String dosage = med.getDosage() != null ? med.getDosage() : "";
        String scheduledTime = intakeLog.getTime() != null
                ? intakeLog.getTime().toString().substring(0, 5)
                : "Unknown";

        // 1. Send email to the patient
        if (patient.getEmail() != null && !patient.getEmail().isBlank()) {
            emailService.sendMissedDoseReminder(
                    patient.getEmail(),
                    patient.getName(),
                    patient.getName(),
                    medicineName,
                    dosage,
                    scheduledTime
            );
            log.info("Sent missed dose reminder to patient: {}", patient.getEmail());
        }

        // 2. Send email to all linked caregivers
        List<User> caregivers = userRepo.findByPatientEmail(patient.getEmail());
        for (User caregiver : caregivers) {
            if (caregiver.getEmail() != null && !caregiver.getEmail().isBlank()) {
                emailService.sendMissedDoseReminder(
                        caregiver.getEmail(),
                        caregiver.getName(),
                        patient.getName(),
                        medicineName,
                        dosage,
                        scheduledTime
                );
                log.info("Sent missed dose reminder to caregiver: {}", caregiver.getEmail());
            }
        }
    }
}
