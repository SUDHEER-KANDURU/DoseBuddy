package com.example.dosebuddy.dto;

import java.time.LocalDateTime;

public class EmailAnalyticsDto {

    private long totalEmailsSent;
    private long successfulEmails;
    private long failedEmails;
    private long retryExhaustedEmails;
    private LocalDateTime lastReminderSent;

    public EmailAnalyticsDto() {}

    public EmailAnalyticsDto(long totalEmailsSent, long successfulEmails,
                             long failedEmails, long retryExhaustedEmails,
                             LocalDateTime lastReminderSent) {
        this.totalEmailsSent       = totalEmailsSent;
        this.successfulEmails      = successfulEmails;
        this.failedEmails          = failedEmails;
        this.retryExhaustedEmails  = retryExhaustedEmails;
        this.lastReminderSent      = lastReminderSent;
    }

    public long getTotalEmailsSent() { return totalEmailsSent; }
    public void setTotalEmailsSent(long v) { totalEmailsSent = v; }

    public long getSuccessfulEmails() { return successfulEmails; }
    public void setSuccessfulEmails(long v) { successfulEmails = v; }

    public long getFailedEmails() { return failedEmails; }
    public void setFailedEmails(long v) { failedEmails = v; }

    public long getRetryExhaustedEmails() { return retryExhaustedEmails; }
    public void setRetryExhaustedEmails(long v) { retryExhaustedEmails = v; }

    public LocalDateTime getLastReminderSent() { return lastReminderSent; }
    public void setLastReminderSent(LocalDateTime v) { lastReminderSent = v; }
}
