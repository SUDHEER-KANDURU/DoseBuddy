package com.example.dosebuddy.service;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Sends transactional email via the Resend REST API using Java's built-in
 * {@code java.net.http.HttpClient}.  No additional Maven dependency is needed.
 *
 * <h3>Why Resend instead of Gmail SMTP</h3>
 * Railway's shared networking blocks outbound port 587 (SMTP).  Resend uses
 * HTTPS (port 443) which is always open, making it a drop-in replacement with
 * zero networking changes on Railway.
 *
 * <h3>API contract</h3>
 * <pre>
 * POST https://api.resend.com/emails
 * Authorization: Bearer {RESEND_API_KEY}
 * Content-Type: application/json
 *
 * {
 *   "from": "DoseBuddy &lt;noreply@yourdomain.com&gt;",
 *   "to":   ["recipient@example.com"],
 *   "subject": "...",
 *   "html": "..."
 * }
 * </pre>
 */
@Service
public class ResendEmailService {

    private static final Logger log = LoggerFactory.getLogger(ResendEmailService.class);

    @Value("${resend.api-key}")
    private String apiKey;

    @Value("${resend.from:DoseBuddy <onboarding@resend.dev>}")
    private String fromAddress;

    @Value("${resend.api-url:https://api.resend.com/emails}")
    private String apiUrl;

    /** Shared, thread-safe HTTP client — re-used across all sends. */
    private HttpClient httpClient;

    @PostConstruct
    public void init() {
        httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        boolean configured = apiKey != null && !apiKey.isBlank()
                             && !apiKey.equals("${RESEND_API_KEY}");

        log.info("========================================");
        log.info("[ResendEmail] provider            : Resend REST API");
        log.info("[ResendEmail] api-url             : {}", apiUrl);
        log.info("[ResendEmail] from                : {}", fromAddress);
        log.info("[ResendEmail] RESEND_API_KEY set  : {}", configured);
        log.info("========================================");

        if (!configured) {
            log.warn("[ResendEmail] RESEND_API_KEY is NOT configured — email sending will fail.");
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Sends an HTML email via the Resend API.
     *
     * @param to      recipient email address
     * @param subject email subject line
     * @param html    full HTML body
     * @throws RuntimeException if the API returns a non-2xx status or the
     *                          HTTP call itself fails
     */
    public void sendHtml(String to, String subject, String html) {
        String body = buildJsonPayload(to, subject, html);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(apiUrl))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .timeout(Duration.ofSeconds(30))
                .build();

        try {
            HttpResponse<String> response = httpClient.send(
                    request, HttpResponse.BodyHandlers.ofString());

            int status = response.statusCode();
            if (status >= 200 && status < 300) {
                log.debug("[ResendEmail] Accepted: to={} status={}", to, status);
            } else {
                String errBody = response.body();
                log.error("[ResendEmail] API error: status={} body={}", status, errBody);
                throw new RuntimeException(
                        "Resend API returned HTTP " + status + ": " + truncate(errBody, 400));
            }
        } catch (IOException | InterruptedException ex) {
            if (ex instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            log.error("[ResendEmail] HTTP call failed: {}", ex.getMessage());
            throw new RuntimeException("Resend HTTP call failed: " + ex.getMessage(), ex);
        }
    }

    // ── Health / diagnostics ──────────────────────────────────────────────────

    /**
     * Returns provider health info for the {@code /email-provider-health} endpoint.
     * The API key value is never included.
     */
    public Map<String, Object> getProviderHealth() {
        boolean configured = apiKey != null && !apiKey.isBlank()
                             && !apiKey.equals("${RESEND_API_KEY}");
        Map<String, Object> health = new LinkedHashMap<>();
        health.put("provider",    "resend");
        health.put("configured",  configured);
        return health;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Builds a minimal Resend-compatible JSON payload without any JSON library.
     * Uses simple string escaping — sufficient because subject and HTML are
     * generated internally and never contain unescaped double-quotes or backslashes
     * from user input at the call sites.
     */
    private String buildJsonPayload(String to, String subject, String html) {
        return "{"
             + "\"from\":"    + jsonString(fromAddress) + ","
             + "\"to\":"      + "[" + jsonString(to) + "],"
             + "\"subject\":" + jsonString(subject)  + ","
             + "\"html\":"    + jsonString(html)
             + "}";
    }

    /**
     * Wraps a string in JSON double-quotes and escapes the characters that must
     * be escaped inside a JSON string value.
     */
    private static String jsonString(String value) {
        if (value == null) return "\"\"";
        // Escape backslash first, then double-quote, then control characters
        String escaped = value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n")
                .replace("\t", "\\t");
        return "\"" + escaped + "\"";
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
