package com.example.dosebuddy.model;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * Audit record for every email-reminder attempt.
 *
 * Deduplication key  : (medication_id, scheduled_date_time) — enforced at both
 *                      the application layer AND by a DB UNIQUE constraint so that
 *                      even a concurrent scheduler restart cannot fire duplicates.
 *
 * Retry tracking     : attempt_count / max_attempts / next_retry_at let the
 *                      scheduler implement capped exponential-backoff retries for
 *                      transient SMTP failures without re-sending on permanent ones.
 *
 * Status values      : PENDING → SUCCESS | FAILED | RETRY_EXHAUSTED
 */
@Entity
@Table(
    name = "email_reminder_logs",
    indexes = {
        // Fast look-up for the deduplication query
        @Index(name = "idx_erl_med_slot",    columnList = "medication_id, scheduled_date_time", unique = true),
        // Analytics / dashboard queries
        @Index(name = "idx_erl_user_status", columnList = "user_id, status"),
        @Index(name = "idx_erl_sent_at",     columnList = "sent_at"),
        // Retry-queue scan: find FAILED rows that are ready to retry
        @Index(name = "idx_erl_retry",       columnList = "status, next_retry_at")
    }
)
public class EmailReminderLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "medication_id", nullable = false)
    private Long medicationId;

    @Column(name = "recipient_email", nullable = false, length = 320)
    private String recipientEmail;

    @Column(name = "subject", nullable = false, length = 500)
    private String subject;

    /**
     * The truncated-to-minute slot this reminder covers (YYYY-MM-DDTHH:mm:00).
     * Together with medication_id this is the deduplication key.
     * This is ALWAYS the actual medicine dose time — offset does not change it.
     */
    @Column(name = "scheduled_date_time", nullable = false)
    private LocalDateTime scheduledDateTime;

    /**
     * The actual medicine dose time stored separately for easy display.
     * Equals scheduledDateTime.toLocalTime() — kept explicit for the email template.
     */
    @Column(name = "medicine_time")
    private LocalDateTime medicineTime;

    /**
     * How many minutes before medicineTime the email was fired.
     * 0 = sent exactly at dose time. Stored for audit/display in email body.
     */
    @Column(name = "reminder_offset_minutes", nullable = false)
    private int reminderOffsetMinutes = 0;

    /** Wall-clock time the most recent send attempt finished (success or failure). */
    @Column(name = "sent_at")
    private LocalDateTime sentAt;

    /**
     * PENDING       – row reserved; send not yet attempted
     * SUCCESS       – delivered
     * FAILED        – current attempt failed; retries may follow
     * RETRY_EXHAUSTED – gave up after max_attempts
     */
    @Column(name = "status", nullable = false, length = 20)
    private String status = "PENDING";

    @Column(name = "error_message", length = 1000)
    private String errorMessage;

    /** How many send attempts have been made so far (0 = none yet). */
    @Column(name = "attempt_count", nullable = false)
    private int attemptCount = 0;

    /** Hard ceiling on retries (default 3 = 1 original + 2 retries). */
    @Column(name = "max_attempts", nullable = false)
    private int maxAttempts = 3;

    /**
     * Earliest timestamp at which the scheduler is allowed to retry this row.
     * NULL while status = SUCCESS or RETRY_EXHAUSTED.
     */
    @Column(name = "next_retry_at")
    private LocalDateTime nextRetryAt;

    @Column(name = "created_at", updatable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at")
    private LocalDateTime updatedAt;

    @PrePersist
    protected void onCreate() {
        LocalDateTime now = LocalDateTime.now();
        createdAt  = now;
        updatedAt  = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = LocalDateTime.now();
    }

    public EmailReminderLog() {}

    // ── Getters & Setters ────────────────────────────────────────────────────

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }

    public Long getMedicationId() { return medicationId; }
    public void setMedicationId(Long medicationId) { this.medicationId = medicationId; }

    public String getRecipientEmail() { return recipientEmail; }
    public void setRecipientEmail(String recipientEmail) { this.recipientEmail = recipientEmail; }

    public String getSubject() { return subject; }
    public void setSubject(String subject) { this.subject = subject; }

    public LocalDateTime getScheduledDateTime() { return scheduledDateTime; }
    public void setScheduledDateTime(LocalDateTime scheduledDateTime) { this.scheduledDateTime = scheduledDateTime; }

    public LocalDateTime getMedicineTime() { return medicineTime; }
    public void setMedicineTime(LocalDateTime medicineTime) { this.medicineTime = medicineTime; }

    public int getReminderOffsetMinutes() { return reminderOffsetMinutes; }
    public void setReminderOffsetMinutes(int reminderOffsetMinutes) { this.reminderOffsetMinutes = reminderOffsetMinutes; }

    public LocalDateTime getSentAt() { return sentAt; }
    public void setSentAt(LocalDateTime sentAt) { this.sentAt = sentAt; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getErrorMessage() { return errorMessage; }
    public void setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; }

    public int getAttemptCount() { return attemptCount; }
    public void setAttemptCount(int attemptCount) { this.attemptCount = attemptCount; }

    public int getMaxAttempts() { return maxAttempts; }
    public void setMaxAttempts(int maxAttempts) { this.maxAttempts = maxAttempts; }

    public LocalDateTime getNextRetryAt() { return nextRetryAt; }
    public void setNextRetryAt(LocalDateTime nextRetryAt) { this.nextRetryAt = nextRetryAt; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
