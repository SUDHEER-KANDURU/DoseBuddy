package com.example.dosebuddy.dto;

import java.time.LocalDateTime;

public class EmailReminderLogDto {

    private Long id;
    private Long userId;
    private Long medicationId;
    private String recipientEmail;
    private String subject;
    private LocalDateTime scheduledDateTime;
    private LocalDateTime sentAt;
    private String status;
    private String errorMessage;
    private int attemptCount;
    private int maxAttempts;
    private LocalDateTime nextRetryAt;
    private LocalDateTime medicineTime;
    private int reminderOffsetMinutes;
    private LocalDateTime createdAt;

    public EmailReminderLogDto() {}

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

    public LocalDateTime getMedicineTime() { return medicineTime; }
    public void setMedicineTime(LocalDateTime medicineTime) { this.medicineTime = medicineTime; }

    public int getReminderOffsetMinutes() { return reminderOffsetMinutes; }
    public void setReminderOffsetMinutes(int reminderOffsetMinutes) { this.reminderOffsetMinutes = reminderOffsetMinutes; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
