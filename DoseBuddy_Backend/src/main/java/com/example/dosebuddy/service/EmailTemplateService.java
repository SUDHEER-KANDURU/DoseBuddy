package com.example.dosebuddy.service;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import org.springframework.stereotype.Service;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

/**
 * Builds HTML email bodies for all DoseBuddy email types.
 *
 * <p>The reminder template now accepts both the actual <em>medicine time</em>
 * (the time the dose is scheduled) and the <em>fire time</em> (when the email
 * is actually sent, = medicine time minus offset). This gives the user clear
 * context in every email.</p>
 */
@Service
public class EmailTemplateService {

    private static final DateTimeFormatter TIME_FMT = DateTimeFormatter.ofPattern("hh:mm a");

    // Brand colours
    private static final String PRIMARY = "#2563eb";
    private static final String BG      = "#f0f4ff";
    private static final String CARD_BG = "#ffffff";
    private static final String TEXT    = "#1e293b";
    private static final String MUTED   = "#64748b";
    private static final String SUCCESS = "#22c55e";
    private static final String WARNING = "#f59e0b";
    private static final String BORDER  = "#e2e8f0";

    // ── Subject ───────────────────────────────────────────────────────────────

    /**
     * Builds the email subject line.
     *
     * <ul>
     *   <li>offset = 0  → "💊 Medicine Reminder: Metformin at 08:30 AM — DoseBuddy"</li>
     *   <li>offset > 0  → "💊 Medicine Reminder: Metformin due in 10 min (08:30 AM) — DoseBuddy"</li>
     * </ul>
     */
    public String buildReminderSubject(String medName, LocalTime doseTime,
                                       LocalTime fireTime, int offsetMinutes) {
        String doseStr = doseTime.format(TIME_FMT);
        if (offsetMinutes <= 0) {
            return "💊 Medicine Reminder: " + medName + " at " + doseStr + " — DoseBuddy";
        }
        return "💊 Medicine Reminder: " + medName + " due in " + offsetMinutes
                + " min (" + doseStr + ") — DoseBuddy";
    }

    /** Backward-compatible overload (offset = 0). */
    public String buildReminderSubject(String medName, LocalTime time) {
        return buildReminderSubject(medName, time, time, 0);
    }

    // ── Reminder body ─────────────────────────────────────────────────────────

    /**
     * Builds the full HTML reminder email.
     *
     * @param doseTime      the actual scheduled medicine dose time
     * @param fireTime      the time the email is sent (doseTime - offsetMinutes)
     * @param offsetMinutes 0, 5, 10, 15, or 30
     */
    public String buildReminderBody(User user, Medication med,
                                    LocalTime doseTime, LocalTime fireTime,
                                    int offsetMinutes) {
        String firstName    = firstName(user.getName());
        String doseStr      = doseTime.format(TIME_FMT);
        String fireStr      = fireTime.format(TIME_FMT);
        String medName      = med.getName();
        String dosage       = med.getDosage() != null ? med.getDosage() : "as prescribed";
        String instructions = (med.getInstructions() != null && !med.getInstructions().isBlank())
                ? med.getInstructions() : "Follow your doctor's guidance.";

        // Headline banner text differs by offset
        String reminderBanner;
        if (offsetMinutes <= 0) {
            reminderBanner = "⏰ Time to take <strong>" + escape(medName) + "</strong> now (" + doseStr + ")";
        } else {
            reminderBanner = "⏰ <strong>" + escape(medName) + "</strong> is due in "
                    + offsetMinutes + " minutes at <strong>" + doseStr + "</strong>";
        }

        // Offset badge shown in the timing block
        String offsetLabel = offsetMinutes <= 0
                ? "At exact medicine time"
                : offsetMinutes + " minutes before";

        return "<!DOCTYPE html>"
            + "<html lang='en'><head><meta charset='UTF-8'>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<title>Medicine Reminder – DoseBuddy</title></head>"
            + "<body style='margin:0;padding:0;background:" + BG + ";font-family:Inter,Segoe UI,Arial,sans-serif;'>"

            // Outer wrapper
            + "<table width='100%' cellpadding='0' cellspacing='0' border='0' style='background:" + BG + ";'>"
            + "<tr><td align='center' style='padding:40px 16px;'>"

            // Card
            + "<table width='100%' style='max-width:600px;background:" + CARD_BG + ";border-radius:16px;"
            + "box-shadow:0 4px 24px rgba(37,99,235,.10);overflow:hidden;'>"

            // Header
            + "<tr><td style='background:" + PRIMARY + ";padding:32px 40px;text-align:center;'>"
            + "<p style='margin:0 0 8px 0;font-size:32px;'>💊</p>"
            + "<h1 style='margin:0;color:#fff;font-size:24px;font-weight:700;letter-spacing:-.5px;'>DoseBuddy</h1>"
            + "<p style='margin:6px 0 0 0;color:rgba(255,255,255,.80);font-size:13px;'>Your Personal Medicine Reminder</p>"
            + "</td></tr>"

            // Greeting
            + "<tr><td style='padding:36px 40px 0 40px;'>"
            + "<h2 style='margin:0 0 8px 0;color:" + TEXT + ";font-size:20px;font-weight:600;'>Hi " + escape(firstName) + "! 👋</h2>"
            + "<p style='margin:0;color:" + MUTED + ";font-size:15px;line-height:1.6;'>"
            + "This is your medication reminder. Staying consistent is key to your health!</p>"
            + "</td></tr>"

            // ── Timing block — shows both reminder time and actual dose time ──
            + "<tr><td style='padding:20px 40px 0 40px;'>"
            + "<table width='100%' cellpadding='0' cellspacing='0' border='0'>"
            + "<tr>"

            // Fire time card
            + "<td style='width:48%;background:rgba(37,99,235,.06);border:1px solid rgba(37,99,235,.18);"
            + "border-radius:10px;padding:16px 18px;vertical-align:top;'>"
            + "<p style='margin:0 0 4px 0;color:" + MUTED + ";font-size:11px;font-weight:600;"
            + "text-transform:uppercase;letter-spacing:.08em;'>📧 Reminder Sent</p>"
            + "<p style='margin:0;color:" + PRIMARY + ";font-size:22px;font-weight:700;'>" + fireStr + "</p>"
            + "<p style='margin:4px 0 0 0;color:" + MUTED + ";font-size:11px;'>" + escape(offsetLabel) + "</p>"
            + "</td>"

            + "<td style='width:4%;'></td>"  // spacer

            // Dose time card
            + "<td style='width:48%;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.25);"
            + "border-radius:10px;padding:16px 18px;vertical-align:top;'>"
            + "<p style='margin:0 0 4px 0;color:" + MUTED + ";font-size:11px;font-weight:600;"
            + "text-transform:uppercase;letter-spacing:.08em;'>💊 Take Medicine At</p>"
            + "<p style='margin:0;color:#16a34a;font-size:22px;font-weight:700;'>" + doseStr + "</p>"
            + "<p style='margin:4px 0 0 0;color:" + MUTED + ";font-size:11px;'>Scheduled dose time</p>"
            + "</td>"

            + "</tr></table>"
            + "</td></tr>"

            // Medication details
            + "<tr><td style='padding:20px 40px 0 40px;'>"
            + "<div style='background:" + BG + ";border:1px solid " + BORDER + ";border-radius:12px;padding:20px;'>"
            + "<p style='margin:0 0 14px 0;color:" + MUTED + ";font-size:11px;font-weight:600;"
            + "text-transform:uppercase;letter-spacing:.08em;'>Medication Details</p>"
            + detailRow("💊", "Medicine",     escape(medName))
            + detailRow("📏", "Dosage",       escape(dosage))
            + detailRow("📋", "Instructions", escape(instructions))
            + "</div></td></tr>"

            // CTA banner
            + "<tr><td style='padding:20px 40px 0 40px;text-align:center;'>"
            + "<div style='background:" + SUCCESS + "18;border:1px solid " + SUCCESS + "44;"
            + "border-radius:10px;padding:14px 20px;'>"
            + "<p style='margin:0;color:#15803d;font-size:15px;font-weight:600;'>"
            + reminderBanner + "</p>"
            + "</div></td></tr>"

            // Health tip
            + "<tr><td style='padding:20px 40px 0 40px;'>"
            + "<p style='margin:0;color:" + MUTED + ";font-size:14px;line-height:1.7;'>"
            + "<strong style='color:" + TEXT + ";'>💡 Health Tip:</strong> "
            + "Taking your medicine at the same time every day maintains consistent levels in your body. "
            + "If you experience any side effects, contact your healthcare provider immediately.</p>"
            + "</td></tr>"

            // Disclaimer
            + "<tr><td style='padding:20px 40px;'>"
            + "<p style='margin:0;color:" + MUTED + ";font-size:12px;line-height:1.6;"
            + "border-top:1px solid " + BORDER + ";padding-top:16px;'>"
            + "⚠️ <strong>Disclaimer:</strong> DoseBuddy is a reminder service only. "
            + "Always follow your doctor's instructions. In a medical emergency call 911 or your local emergency number."
            + "</p></td></tr>"

            // Footer
            + "<tr><td style='background:#f8fafc;border-top:1px solid " + BORDER + ";padding:20px 40px;text-align:center;'>"
            + "<p style='margin:0 0 4px 0;color:" + TEXT + ";font-size:14px;font-weight:600;'>DoseBuddy 💊</p>"
            + "<p style='margin:0;color:" + MUTED + ";font-size:12px;'>Your personal medicine reminder &amp; health companion</p>"
            + "<p style='margin:10px 0 0 0;color:" + MUTED + ";font-size:11px;'>"
            + "To change reminder timing, log in to DoseBuddy → Notifications → Email Reminders.</p>"
            + "</td></tr>"

            + "</table>"
            + "</td></tr></table>"
            + "</body></html>";
    }

    /** Backward-compatible overload (offset = 0, fire time = dose time). */
    public String buildReminderBody(User user, Medication med, LocalTime reminderTime) {
        return buildReminderBody(user, med, reminderTime, reminderTime, 0);
    }

    // ── Test email ────────────────────────────────────────────────────────────

    public String buildTestSubject() {
        return "✅ DoseBuddy Email Reminders — Test Successful!";
    }

    public String buildTestBody(User user) {
        String firstName = firstName(user.getName());
        return "<!DOCTYPE html>"
            + "<html lang='en'><head><meta charset='UTF-8'>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<title>Test Email – DoseBuddy</title></head>"
            + "<body style='margin:0;padding:0;background:" + BG + ";font-family:Inter,Segoe UI,Arial,sans-serif;'>"
            + "<table width='100%' cellpadding='0' cellspacing='0' border='0' style='background:" + BG + ";'>"
            + "<tr><td align='center' style='padding:40px 16px;'>"
            + "<table width='100%' style='max-width:600px;background:" + CARD_BG + ";border-radius:16px;"
            + "box-shadow:0 4px 24px rgba(37,99,235,.10);overflow:hidden;'>"
            + "<tr><td style='background:" + PRIMARY + ";padding:32px 40px;text-align:center;'>"
            + "<p style='margin:0 0 8px 0;font-size:36px;'>✅</p>"
            + "<h1 style='margin:0;color:#fff;font-size:24px;font-weight:700;'>Email Reminders Active!</h1>"
            + "<p style='margin:6px 0 0 0;color:rgba(255,255,255,.80);font-size:13px;'>DoseBuddy — Your Personal Medicine Reminder</p>"
            + "</td></tr>"
            + "<tr><td style='padding:36px 40px;'>"
            + "<h2 style='margin:0 0 16px 0;color:" + TEXT + ";font-size:20px;'>Hi " + escape(firstName) + "! 🎉</h2>"
            + "<p style='margin:0 0 16px 0;color:" + MUTED + ";font-size:15px;line-height:1.7;'>"
            + "Your email reminders are set up and working perfectly. "
            + "You'll receive a reminder email before every scheduled dose.</p>"
            + "<div style='background:" + SUCCESS + "18;border:1px solid " + SUCCESS + "44;"
            + "border-radius:10px;padding:20px 24px;margin:24px 0;'>"
            + "<p style='margin:0;color:#15803d;font-size:15px;font-weight:600;text-align:center;'>"
            + "✅ Your DoseBuddy email reminders are now active!</p>"
            + "</div>"
            + "<p style='margin:0;color:" + MUTED + ";font-size:14px;line-height:1.7;'>"
            + "📌 Each reminder shows your medicine name, dosage, the reminder time, "
            + "and the exact time you should take the medicine.</p>"
            + "</td></tr>"
            + "<tr><td style='background:#f8fafc;border-top:1px solid " + BORDER + ";padding:24px 40px;text-align:center;'>"
            + "<p style='margin:0 0 4px 0;color:" + TEXT + ";font-size:14px;font-weight:600;'>DoseBuddy 💊</p>"
            + "<p style='margin:0;color:" + MUTED + ";font-size:12px;'>Your personal medicine reminder &amp; health companion</p>"
            + "</td></tr>"
            + "</table></td></tr></table></body></html>";
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String detailRow(String icon, String label, String value) {
        return "<div style='display:flex;align-items:flex-start;margin-bottom:10px;'>"
             + "<span style='font-size:16px;margin-right:10px;flex-shrink:0;'>" + icon + "</span>"
             + "<div>"
             + "<p style='margin:0;color:" + MUTED + ";font-size:11px;font-weight:600;"
             + "text-transform:uppercase;letter-spacing:.06em;'>" + label + "</p>"
             + "<p style='margin:2px 0 0 0;color:" + TEXT + ";font-size:14px;font-weight:500;'>" + value + "</p>"
             + "</div></div>";
    }

    private static String firstName(String fullName) {
        if (fullName == null || fullName.isBlank()) return "there";
        return fullName.trim().split("\\s+")[0];
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
