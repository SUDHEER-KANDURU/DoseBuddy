package com.example.dosebuddy.dto;

/**
 * Payload for GET/PUT /api/email-reminders/settings/{userId}.
 *
 * emailReminderOffsetMinutes: 0 = at dose time, 5 / 10 / 15 / 30 = N minutes before.
 */
public class EmailReminderSettingsDto {

    private boolean emailRemindersEnabled;
    private int emailReminderOffsetMinutes;

    public EmailReminderSettingsDto() {}

    public EmailReminderSettingsDto(boolean emailRemindersEnabled, int emailReminderOffsetMinutes) {
        this.emailRemindersEnabled       = emailRemindersEnabled;
        this.emailReminderOffsetMinutes  = emailReminderOffsetMinutes;
    }

    public boolean isEmailRemindersEnabled() { return emailRemindersEnabled; }
    public void setEmailRemindersEnabled(boolean emailRemindersEnabled) {
        this.emailRemindersEnabled = emailRemindersEnabled;
    }

    public int getEmailReminderOffsetMinutes() { return emailReminderOffsetMinutes; }
    public void setEmailReminderOffsetMinutes(int emailReminderOffsetMinutes) {
        this.emailReminderOffsetMinutes = emailReminderOffsetMinutes;
    }
}
