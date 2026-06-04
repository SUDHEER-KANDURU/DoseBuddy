package com.example.dosebuddy.service;

import com.example.dosebuddy.dto.EmailAnalyticsDto;
import com.example.dosebuddy.dto.EmailReminderLogDto;
import com.example.dosebuddy.model.EmailReminderLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.MedicationTime;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.EmailReminderLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import com.example.dosebuddy.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Email reminder service.  All email sending is delegated to
 * {@link ResendEmailService} (Resend REST API over HTTPS).
 *
 * <h3>How offsets work</h3>
 * <pre>
 * User sets offset = 10 min.  Medicine is scheduled at 08:30.
 * → fireTime = 08:20.  Email is sent at 08:20.
 * → Email shows: "Reminder time: 08:20 AM | Medicine time: 08:30 AM"
 * → Dedup key is always (medId, 08:30) — changing the offset never
 *   creates duplicates against existing records.
 * </pre>
 *
 * <h3>Production safeguards</h3>
 * <ul>
 *   <li>DB UNIQUE on (medication_id, scheduled_date_time)</li>
 *   <li>35-min lookback window for restart resilience</li>
 *   <li>Exponential back-off retry (up to 3 attempts)</li>
 *   <li>Per-address rate limiting (10 emails / 60 min)</li>
 *   <li>TX-isolated send calls — no DB connection held during HTTP I/O</li>
 *   <li>Daily log cleanup (90-day retention)</li>
 * </ul>
 */
@Service
public class EmailReminderService {

    private static final Logger log = LoggerFactory.getLogger(EmailReminderService.class);

    // ── Allowed offset values (minutes before dose time) ─────────────────────
    public static final int[] ALLOWED_OFFSETS = {0, 5, 10, 15, 30};

    // ── Tuneable constants ────────────────────────────────────────────────────
    private static final int LOOKBACK_MINUTES          = 35;
    private static final int RATE_LIMIT_MAX_PER_WINDOW = 10;
    private static final int RATE_LIMIT_WINDOW_MINUTES = 60;
    private static final int LOG_RETENTION_DAYS        = 90;
    private static final int MAX_ATTEMPTS              = 3;

    // ── Dependencies ──────────────────────────────────────────────────────────
    private final ResendEmailService         resendService;
    private final EmailTemplateService       templateService;
    private final EmailReminderLogRepository logRepo;
    private final MedicationRepository       medRepo;
    private final UserRepository             userRepo;

    @Value("${app.timezone:UTC}")
    private String appTimezone;

    public EmailReminderService(ResendEmailService resendService,
                                EmailTemplateService templateService,
                                EmailReminderLogRepository logRepo,
                                MedicationRepository medRepo,
                                UserRepository userRepo) {
        this.resendService   = resendService;
        this.templateService = templateService;
        this.logRepo         = logRepo;
        this.medRepo         = medRepo;
        this.userRepo        = userRepo;
    }

    // ── Zone helpers ──────────────────────────────────────────────────────────

    private ZoneId zone()             { return ZoneId.of(appTimezone); }
    private LocalDate todayInZone()   { return ZonedDateTime.now(zone()).toLocalDate(); }
    private LocalTime nowSlot()       { return ZonedDateTime.now(zone()).toLocalTime().withSecond(0).withNano(0); }
    private LocalDateTime nowInZone() { return ZonedDateTime.now(zone()).toLocalDateTime(); }

    // ── Primary scheduler ─────────────────────────────────────────────────────

    @Scheduled(fixedDelayString = "${app.email.scheduler.interval-ms:60000}")
    public void processScheduledReminders() {
        try {
            int sent    = processNewSlots();
            int retried = processRetryQueue();
            if (sent > 0 || retried > 0) {
                log.info("[EmailReminder] cycle done — newSent={}, retried={}", sent, retried);
            }
        } catch (Exception ex) {
            log.error("[EmailReminder] Unexpected error in scheduler cycle", ex);
        }
    }

    // ── Daily log cleanup ─────────────────────────────────────────────────────

    @Scheduled(cron = "${app.email.cleanup.cron:0 0 2 * * *}")
    @Transactional
    public void cleanupOldLogs() {
        LocalDateTime cutoff = nowInZone().minusDays(LOG_RETENTION_DAYS);
        int deleted = logRepo.deleteOlderThan(cutoff);
        if (deleted > 0) {
            log.info("[EmailReminder] Cleaned {} log entries older than {} days", deleted, LOG_RETENTION_DAYS);
        }
    }

    // ── Phase 1: new slots ────────────────────────────────────────────────────

    /**
     * Uses {@code findActiveWithTimesAndUser} (JOIN FETCH) so that {@code times}
     * and {@code user} are loaded eagerly.  This avoids LazyInitializationException
     * on the scheduler thread which has no surrounding JPA session.
     */
    private int processNewSlots() {
        LocalDate today       = todayInZone();
        LocalTime nowSlot     = nowSlot();
        LocalTime windowStart = nowSlot.minusMinutes(LOOKBACK_MINUTES);

        List<Medication> activeMeds = medRepo.findActiveWithTimesAndUser(today);

        int sent = 0;

        for (Medication med : activeMeds) {
            User owner = med.getUser();
            if (owner == null || !owner.isEmailRemindersEnabled()) continue;
            if (owner.getEmail() == null || owner.getEmail().isBlank()) continue;

            List<MedicationTime> times = med.getTimes();
            if (times == null || times.isEmpty()) continue;

            int offsetMinutes = owner.getEmailReminderOffsetMinutes();

            for (MedicationTime mt : times) {
                LocalTime doseTime = mt.getTimeOfDay();
                if (doseTime == null) continue;

                LocalTime doseSlot = doseTime.withSecond(0).withNano(0);
                LocalTime fireSlot = doseSlot.minusMinutes(offsetMinutes);

                boolean inWindow = !fireSlot.isBefore(windowStart) && !fireSlot.isAfter(nowSlot);
                if (!inWindow) continue;

                LocalDateTime scheduledDt = LocalDateTime.of(today, doseSlot);

                if (isAlreadySucceeded(med.getId(), scheduledDt)) {
                    log.debug("[EmailReminder] Skip (already sent): med={} doseSlot={}", med.getId(), scheduledDt);
                    continue;
                }
                if (hasExistingLog(med.getId(), scheduledDt)) {
                    continue;
                }
                if (isRateLimited(owner.getEmail())) {
                    log.warn("[EmailReminder] Rate-limited: address={} med={}", owner.getEmail(), med.getId());
                    continue;
                }

                if (reserveAndSend(owner, med, doseSlot, fireSlot, scheduledDt, offsetMinutes)) sent++;
            }
        }
        return sent;
    }

    // ── Phase 2: retry queue ──────────────────────────────────────────────────

    private int processRetryQueue() {
        List<EmailReminderLog> retryable = loadRetryQueue();
        int retried = 0;

        for (EmailReminderLog entry : retryable) {
            Optional<User>       userOpt = userRepo.findById(entry.getUserId());
            Optional<Medication> medOpt  = medRepo.findByIdWithTimesAndUser(entry.getMedicationId());

            if (userOpt.isEmpty() || medOpt.isEmpty()) {
                exhaustRetries(entry, "User or medication no longer exists");
                continue;
            }
            User user = userOpt.get();
            Medication med = medOpt.get();

            if (!user.isEmailRemindersEnabled()) {
                exhaustRetries(entry, "User disabled email reminders");
                continue;
            }
            if (isRateLimited(user.getEmail())) {
                log.warn("[EmailReminder] Retry rate-limited: address={} logId={}", user.getEmail(), entry.getId());
                continue;
            }

            LocalTime doseTime = entry.getScheduledDateTime().toLocalTime();
            LocalTime fireTime = (entry.getMedicineTime() != null)
                    ? entry.getMedicineTime().toLocalTime().minusMinutes(entry.getReminderOffsetMinutes())
                    : doseTime;

            String subject = templateService.buildReminderSubject(
                    med.getName(), doseTime, fireTime, entry.getReminderOffsetMinutes());
            String body = templateService.buildReminderBody(
                    user, med, doseTime, fireTime, entry.getReminderOffsetMinutes());

            if (attemptSend(entry, user.getEmail(), subject, body)) retried++;
        }
        return retried;
    }

    // ── Core send + DB ────────────────────────────────────────────────────────

    private boolean reserveAndSend(User user, Medication med,
                                   LocalTime doseSlot, LocalTime fireSlot,
                                   LocalDateTime scheduledDt, int offsetMinutes) {
        EmailReminderLog entry = reserveLogRow(user, med, doseSlot, fireSlot, scheduledDt, offsetMinutes);
        if (entry == null) {
            log.debug("[EmailReminder] Concurrent INSERT guard hit: med={} slot={}", med.getId(), scheduledDt);
            return false;
        }

        String subject = templateService.buildReminderSubject(med.getName(), doseSlot, fireSlot, offsetMinutes);
        String body    = templateService.buildReminderBody(user, med, doseSlot, fireSlot, offsetMinutes);

        return attemptSend(entry, user.getEmail(), subject, body);
    }

    @Transactional
    protected EmailReminderLog reserveLogRow(User user, Medication med,
                                             LocalTime doseSlot, LocalTime fireSlot,
                                             LocalDateTime scheduledDt, int offsetMinutes) {
        if (logRepo.findByMedicationIdAndScheduledDateTime(med.getId(), scheduledDt).isPresent()) {
            return null;
        }
        LocalDateTime medicineDt = LocalDateTime.of(scheduledDt.toLocalDate(), doseSlot);

        EmailReminderLog entry = new EmailReminderLog();
        entry.setUserId(user.getId());
        entry.setMedicationId(med.getId());
        entry.setRecipientEmail(user.getEmail());
        entry.setSubject(templateService.buildReminderSubject(med.getName(), doseSlot, fireSlot, offsetMinutes));
        entry.setScheduledDateTime(scheduledDt);
        entry.setMedicineTime(medicineDt);
        entry.setReminderOffsetMinutes(offsetMinutes);
        entry.setStatus("PENDING");
        entry.setAttemptCount(0);
        entry.setMaxAttempts(MAX_ATTEMPTS);
        try {
            return logRepo.saveAndFlush(entry);
        } catch (Exception ex) {
            log.debug("[EmailReminder] reserveLogRow race ignored: med={} slot={}", med.getId(), scheduledDt);
            return null;
        }
    }

    private boolean attemptSend(EmailReminderLog entry, String toEmail,
                                String subject, String htmlBody) {
        int attempt = entry.getAttemptCount() + 1;
        log.info("[EmailReminder] attempt={}/{} id={} to={} slot={} offset={}min",
                attempt, entry.getMaxAttempts(), entry.getId(), toEmail,
                entry.getScheduledDateTime(), entry.getReminderOffsetMinutes());
        try {
            resendService.sendHtml(toEmail, subject, htmlBody);
            markSuccess(entry, attempt);
            log.info("[EmailReminder] SUCCESS attempt={} id={} to={}", attempt, entry.getId(), toEmail);
            return true;
        } catch (Exception ex) {
            String errMsg = truncate(ex.getMessage(), 950);
            log.warn("[EmailReminder] FAILED attempt={}/{} id={} to={} error={}",
                    attempt, entry.getMaxAttempts(), entry.getId(), toEmail, errMsg);
            if (attempt >= entry.getMaxAttempts()) {
                markExhausted(entry, attempt, errMsg);
                log.error("[EmailReminder] RETRY_EXHAUSTED id={} to={} after {} attempts",
                        entry.getId(), toEmail, attempt);
            } else {
                scheduleRetry(entry, attempt, errMsg);
            }
            return false;
        }
    }

    // ── TX helpers ────────────────────────────────────────────────────────────

    @Transactional
    protected void markSuccess(EmailReminderLog entry, int attempt) {
        entry.setStatus("SUCCESS");
        entry.setAttemptCount(attempt);
        entry.setSentAt(nowInZone());
        entry.setNextRetryAt(null);
        entry.setErrorMessage(null);
        logRepo.save(entry);
    }

    @Transactional
    protected void scheduleRetry(EmailReminderLog entry, int attempt, String errMsg) {
        long backoffMinutes = (long) Math.pow(2, attempt);
        entry.setStatus("FAILED");
        entry.setAttemptCount(attempt);
        entry.setSentAt(nowInZone());
        entry.setErrorMessage(errMsg);
        entry.setNextRetryAt(nowInZone().plusMinutes(backoffMinutes));
        logRepo.save(entry);
        log.info("[EmailReminder] Retry in {}min for id={}", backoffMinutes, entry.getId());
    }

    @Transactional
    protected void markExhausted(EmailReminderLog entry, int attempt, String errMsg) {
        entry.setStatus("RETRY_EXHAUSTED");
        entry.setAttemptCount(attempt);
        entry.setSentAt(nowInZone());
        entry.setErrorMessage(errMsg);
        entry.setNextRetryAt(null);
        logRepo.save(entry);
    }

    @Transactional
    protected void exhaustRetries(EmailReminderLog entry, String reason) {
        entry.setStatus("RETRY_EXHAUSTED");
        entry.setErrorMessage(reason);
        entry.setNextRetryAt(null);
        logRepo.save(entry);
    }

    // ── Read-only TX helpers ──────────────────────────────────────────────────

    @Transactional(readOnly = true)
    protected boolean isAlreadySucceeded(Long medId, LocalDateTime slot) {
        return logRepo.existsByMedicationIdAndScheduledDateTimeAndStatus(medId, slot, "SUCCESS");
    }

    @Transactional(readOnly = true)
    protected boolean hasExistingLog(Long medId, LocalDateTime slot) {
        return logRepo.findByMedicationIdAndScheduledDateTime(medId, slot).isPresent();
    }

    @Transactional(readOnly = true)
    protected boolean isRateLimited(String email) {
        LocalDateTime windowStart = nowInZone().minusMinutes(RATE_LIMIT_WINDOW_MINUTES);
        return logRepo.countSuccessfulSendsToAddressSince(email, windowStart) >= RATE_LIMIT_MAX_PER_WINDOW;
    }

    @Transactional(readOnly = true)
    protected List<EmailReminderLog> loadRetryQueue() {
        return logRepo.findRetryableNow(nowInZone());
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    @Transactional
    public boolean updateEmailReminderSettings(Long userId, boolean enabled, int offsetMinutes) {
        Optional<User> userOpt = userRepo.findById(userId);
        if (userOpt.isEmpty()) return false;
        User user = userOpt.get();
        user.setEmailRemindersEnabled(enabled);
        user.setEmailReminderOffsetMinutes(offsetMinutes);
        userRepo.save(user);
        log.info("[EmailReminder] User {} updated: enabled={}, offset={}min", userId, enabled, offsetMinutes);
        return true;
    }

    @Transactional
    public boolean updateEmailReminderSetting(Long userId, boolean enabled) {
        Optional<User> userOpt = userRepo.findById(userId);
        if (userOpt.isEmpty()) return false;
        User user = userOpt.get();
        user.setEmailRemindersEnabled(enabled);
        userRepo.save(user);
        return true;
    }

    @Transactional(readOnly = true)
    public boolean getEmailReminderSetting(Long userId) {
        return userRepo.findById(userId).map(User::isEmailRemindersEnabled).orElse(false);
    }

    @Transactional(readOnly = true)
    public EmailReminderSettingsSnapshot getSettings(Long userId) {
        return userRepo.findById(userId)
                .map(u -> new EmailReminderSettingsSnapshot(
                        u.isEmailRemindersEnabled(),
                        u.getEmailReminderOffsetMinutes()))
                .orElse(new EmailReminderSettingsSnapshot(false, 0));
    }

    /** Lightweight snapshot returned by the settings endpoint. */
    public record EmailReminderSettingsSnapshot(boolean enabled, int offsetMinutes) {}

    // ── Health / diagnostics ──────────────────────────────────────────────────

    /**
     * Returns email provider health for the {@code /email-provider-health} endpoint.
     * Delegates to {@link ResendEmailService#getProviderHealth()}.
     */
    public Map<String, Object> getEmailProviderHealth() {
        return resendService.getProviderHealth();
    }

    /**
     * Legacy mail-health endpoint — now reports Resend status for backward compat.
     */
    public Map<String, Object> getMailHealth() {
        return resendService.getProviderHealth();
    }

    // ── Analytics ─────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public EmailAnalyticsDto getAnalytics(Long userId) {
        long total     = logRepo.countByUserId(userId);
        long success   = logRepo.countByUserIdAndStatus(userId, "SUCCESS");
        long failed    = logRepo.countByUserIdAndStatus(userId, "FAILED");
        long exhausted = logRepo.countByUserIdAndStatus(userId, "RETRY_EXHAUSTED");
        LocalDateTime lastSent = logRepo
                .findTopByUserIdAndStatusOrderBySentAtDesc(userId, "SUCCESS")
                .map(EmailReminderLog::getSentAt)
                .orElse(null);
        return new EmailAnalyticsDto(total, success, failed, exhausted, lastSent);
    }

    @Transactional(readOnly = true)
    public List<EmailReminderLogDto> getLogsForUser(Long userId) {
        return logRepo.findByUserIdOrderBySentAtDesc(userId)
                .stream().map(this::toDto).collect(Collectors.toList());
    }

    // ── Test / debug ──────────────────────────────────────────────────────────

    public boolean sendTestEmail(Long userId) {
        Optional<User> userOpt = userRepo.findById(userId);
        if (userOpt.isEmpty()) { log.warn("[TestEmail] User {} not found", userId); return false; }
        User user = userOpt.get();
        if (user.getEmail() == null || user.getEmail().isBlank()) {
            log.warn("[TestEmail] User {} has no email", userId); return false;
        }
        try {
            resendService.sendHtml(user.getEmail(),
                    templateService.buildTestSubject(),
                    templateService.buildTestBody(user));
            log.info("[TestEmail] Sent via Resend to userId={} email={}", userId, user.getEmail());
            return true;
        } catch (Exception ex) {
            log.error("[TestEmail] Failed for userId={}: {}", userId, ex.getMessage());
            return false;
        }
    }

    public String triggerReminderDebug(Long userId, Long medId, String timeStr) {
        Optional<User>       userOpt = userRepo.findById(userId);
        Optional<Medication> medOpt  = medRepo.findById(medId);
        if (userOpt.isEmpty()) return "User not found: " + userId;
        if (medOpt.isEmpty())  return "Medication not found: " + medId;
        User user = userOpt.get();
        Medication med = medOpt.get();
        if (user.getEmail() == null || user.getEmail().isBlank()) return "User has no email address";

        LocalTime doseTime;
        try { doseTime = LocalTime.parse(timeStr); }
        catch (Exception ex) { return "Invalid time format — use HH:mm e.g. 08:30"; }

        int offset     = user.getEmailReminderOffsetMinutes();
        LocalTime fireTime = doseTime.withSecond(0).withNano(0).minusMinutes(offset);

        String subject = templateService.buildReminderSubject(med.getName(), doseTime, fireTime, offset);
        String body    = templateService.buildReminderBody(user, med, doseTime, fireTime, offset);
        try {
            resendService.sendHtml(user.getEmail(), subject, body);
            log.info("[DebugTrigger] Sent via Resend userId={} medId={} doseTime={} fireTime={}",
                    userId, medId, doseTime, fireTime);
            return String.format("OK — sent to %s for '%s' | dose: %s | reminder: %s",
                    user.getEmail(), med.getName(), doseTime, fireTime);
        } catch (Exception ex) {
            log.error("[DebugTrigger] Failed: {}", ex.getMessage());
            return "FAILED: " + ex.getMessage();
        }
    }

    // ── Utility ───────────────────────────────────────────────────────────────

    private static String truncate(String s, int max) {
        if (s == null) return "Unknown error";
        return s.length() <= max ? s : s.substring(0, max);
    }

    private EmailReminderLogDto toDto(EmailReminderLog e) {
        EmailReminderLogDto dto = new EmailReminderLogDto();
        dto.setId(e.getId());
        dto.setUserId(e.getUserId());
        dto.setMedicationId(e.getMedicationId());
        dto.setRecipientEmail(e.getRecipientEmail());
        dto.setSubject(e.getSubject());
        dto.setScheduledDateTime(e.getScheduledDateTime());
        dto.setMedicineTime(e.getMedicineTime());
        dto.setReminderOffsetMinutes(e.getReminderOffsetMinutes());
        dto.setSentAt(e.getSentAt());
        dto.setStatus(e.getStatus());
        dto.setErrorMessage(e.getErrorMessage());
        dto.setAttemptCount(e.getAttemptCount());
        dto.setMaxAttempts(e.getMaxAttempts());
        dto.setNextRetryAt(e.getNextRetryAt());
        dto.setCreatedAt(e.getCreatedAt());
        return dto;
    }
}
