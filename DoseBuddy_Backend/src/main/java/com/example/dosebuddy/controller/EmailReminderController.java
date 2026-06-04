package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.EmailAnalyticsDto;
import com.example.dosebuddy.dto.EmailReminderLogDto;
import com.example.dosebuddy.dto.EmailReminderSettingsDto;
import com.example.dosebuddy.service.EmailReminderService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * REST API for the email-reminder subsystem.
 *
 * <pre>
 * GET  /api/email-reminders/email-provider-health          – Resend provider status
 * GET  /api/email-reminders/mail-health                    – legacy alias
 * GET  /api/email-reminders/test-smtp-connectivity         – TCP probe (legacy)
 * GET  /api/email-reminders/settings/{userId}              – get preference + offset
 * PUT  /api/email-reminders/settings/{userId}              – update preference + offset
 * POST /api/email-reminders/test/{userId}                  – send test email via Resend
 * POST /api/email-reminders/trigger/{userId}/{medId}?time= – debug trigger
 * GET  /api/email-reminders/analytics/{userId}             – stats
 * GET  /api/email-reminders/logs/{userId}                  – full log history
 * GET  /api/email-reminders/offsets                        – list valid offset values
 * </pre>
 */
@RestController
@RequestMapping("/api/email-reminders")
@CrossOrigin(origins = "*")
public class EmailReminderController {

    private final EmailReminderService emailReminderService;

    public EmailReminderController(EmailReminderService emailReminderService) {
        this.emailReminderService = emailReminderService;
    }

    // ── Email provider health ─────────────────────────────────────────────────

    /**
     * GET /api/email-reminders/email-provider-health
     *
     * Returns Resend provider configuration status.
     * The API key value is never included in the response.
     *
     * <pre>
     * { "provider": "resend", "configured": true }
     * </pre>
     */
    @GetMapping("/email-provider-health")
    public ResponseEntity<?> getEmailProviderHealth() {
        return ResponseEntity.ok(emailReminderService.getEmailProviderHealth());
    }

    // ── Mail health (legacy alias) ────────────────────────────────────────────

    /**
     * GET /api/email-reminders/mail-health
     * Legacy endpoint — now returns Resend provider status.
     */
    @GetMapping("/mail-health")
    public ResponseEntity<?> getMailHealth() {
        return ResponseEntity.ok(emailReminderService.getMailHealth());
    }

    // ── Valid offset values ───────────────────────────────────────────────────

    /**
     * GET /api/email-reminders/offsets
     * Returns the list of allowed offset values the frontend can display in a dropdown.
     */
    @GetMapping("/offsets")
    public ResponseEntity<?> getValidOffsets() {
        return ResponseEntity.ok(Map.of(
                "offsets", EmailReminderService.ALLOWED_OFFSETS,
                "labels",  new String[]{
                        "At exact medicine time",
                        "5 minutes before",
                        "10 minutes before",
                        "15 minutes before",
                        "30 minutes before"
                }
        ));
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    /**
     * GET /api/email-reminders/settings/{userId}
     * Returns { emailRemindersEnabled, emailReminderOffsetMinutes }.
     */
    @GetMapping("/settings/{userId}")
    public ResponseEntity<?> getSettings(@PathVariable Long userId) {
        EmailReminderService.EmailReminderSettingsSnapshot snap =
                emailReminderService.getSettings(userId);
        return ResponseEntity.ok(
                new EmailReminderSettingsDto(snap.enabled(), snap.offsetMinutes()));
    }

    /**
     * PUT /api/email-reminders/settings/{userId}
     * Body: { "emailRemindersEnabled": true, "emailReminderOffsetMinutes": 10 }
     */
    @PutMapping("/settings/{userId}")
    public ResponseEntity<?> updateSettings(@PathVariable Long userId,
                                            @RequestBody EmailReminderSettingsDto dto) {
        boolean updated = emailReminderService.updateEmailReminderSettings(
                userId, dto.isEmailRemindersEnabled(), dto.getEmailReminderOffsetMinutes());
        if (!updated) return ResponseEntity.notFound().build();

        return ResponseEntity.ok(Map.of(
                "message", "Email reminder settings updated successfully",
                "emailRemindersEnabled", dto.isEmailRemindersEnabled(),
                "emailReminderOffsetMinutes", dto.getEmailReminderOffsetMinutes()
        ));
    }

    // ── Test send ─────────────────────────────────────────────────────────────

    /**
     * POST /api/email-reminders/test/{userId}
     */
    @PostMapping("/test/{userId}")
    public ResponseEntity<?> sendTestEmail(@PathVariable Long userId) {
        boolean success = emailReminderService.sendTestEmail(userId);
        if (success) {
            return ResponseEntity.ok(Map.of(
                    "message", "Test email sent successfully! Check your inbox.",
                    "success", true));
        }
        return ResponseEntity.status(500).body(Map.of(
                "message", "Failed to send test email. Check the server logs for details.",
                "success", false));
    }

    // ── Debug trigger ─────────────────────────────────────────────────────────

    /**
     * POST /api/email-reminders/trigger/{userId}/{medId}?time=HH:mm
     * Fires a reminder immediately using the user's current offset setting.
     */
    @PostMapping("/trigger/{userId}/{medId}")
    public ResponseEntity<?> triggerDebug(@PathVariable Long userId,
                                          @PathVariable Long medId,
                                          @RequestParam(defaultValue = "08:00") String time) {
        String result  = emailReminderService.triggerReminderDebug(userId, medId, time);
        boolean success = result.startsWith("OK");
        return success
                ? ResponseEntity.ok(Map.of("message", result, "success", true))
                : ResponseEntity.status(500).body(Map.of("message", result, "success", false));
    }

    // ── Analytics ─────────────────────────────────────────────────────────────

    @GetMapping("/analytics/{userId}")
    public ResponseEntity<EmailAnalyticsDto> getAnalytics(@PathVariable Long userId) {
        return ResponseEntity.ok(emailReminderService.getAnalytics(userId));
    }

    @GetMapping("/logs/{userId}")
    public ResponseEntity<List<EmailReminderLogDto>> getLogs(@PathVariable Long userId) {
        return ResponseEntity.ok(emailReminderService.getLogsForUser(userId));
    }
}
