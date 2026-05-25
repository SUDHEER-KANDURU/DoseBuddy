package com.example.dosebuddy.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Handles ALL Gemini API calls — used exclusively for prescription OCR
 * and medicine extraction from uploaded images.
 *
 * Chat / symptom / BMI features are handled by MedicineAiService (Groq).
 */
@Service
public class GeminiOcrService {

    private static final String GEMINI_BASE_URL     = "https://generativelanguage.googleapis.com/v1beta/models/";
    private static final int    MAX_RETRIES         = 2;
    private static final long   RETRY_DELAY_MS      = 2000L;
    private static final int    REQUEST_TIMEOUT_SEC = 45;

    private final String apiKey;
    private final String geminiEndpoint;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    public GeminiOcrService(
            @Value("${gemini.model:gemini-2.0-flash}") String geminiModel,
            @Value("${GEMINI_API_KEY:}") String geminiApiKey) {

        this.apiKey         = geminiApiKey.isBlank() ? System.getenv("GEMINI_API_KEY") : geminiApiKey;
        this.geminiEndpoint = GEMINI_BASE_URL + geminiModel + ":generateContent";
        this.httpClient     = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(REQUEST_TIMEOUT_SEC))
                .build();
        this.objectMapper   = new ObjectMapper();

        System.out.println("[AI] OCR Provider: Gemini");
        System.out.println("[AI] Gemini OCR Model: " + geminiModel);
        System.out.println("[AI] Gemini API key loaded: "
                + (this.apiKey != null && !this.apiKey.isBlank() ? "YES" : "NO — image OCR will use local fallback"));
    }

    public boolean isAvailable() {
        return apiKey != null && !apiKey.isBlank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OCR: extract raw text from a prescription image
    // ─────────────────────────────────────────────────────────────────────────

    public String extractTextFromImage(String base64Image, String mimeType) {
        if (!isAvailable()) return "";

        String textPrompt = """
                Transcribe ALL text from this prescription image exactly as written.
                Preserve the original line structure — one medicine per line.
                Do NOT interpret, translate, or reformat.
                Do NOT add any explanation.
                Just output the raw text lines from the image.
                """;

        String jsonBody = buildVisionBody(textPrompt, mimeType, base64Image);
        try {
            return callGemini(jsonBody);
        } catch (Exception e) {
            System.err.println("[GeminiOcrService] extractTextFromImage failed: " + e.getMessage());
            return "";
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OCR + parse: image → structured JSON medicine array in one shot
    // ─────────────────────────────────────────────────────────────────────────

    public String parsePrescriptionFromImage(String base64Image, String mimeType) {
        if (!isAvailable()) return "[]";

        String textPrompt = """
                You are a prescription parser. Carefully read this prescription image.
                Extract EVERY medicine listed. Prescriptions often use formats like:
                  TAB. MEDICINE NAME | 1 Morning, 1 Night
                  CAP. MEDICINE NAME | 1 Morning, 1 Afternoon, 1 Night (After Food)
                  MEDICINE NAME | 1/2 Morning, 1/2 Night (Before Food)

                Rules:
                - Remove prefixes like TAB., CAP., SYR., INJ. from medicine names
                - Convert time keywords: Morning=08:00, Afternoon/Aft=14:00, Evening/Eve=18:00, Night=21:00
                - Convert quantities: "1" = "1 tablet", "1/2" = "0.5 tablet"
                - Extract instructions from parentheses like (Before Food), (After Food)
                - If instructions not found, use "As directed"

                Return ONLY a valid JSON array, no markdown, no explanation.
                Each element must have EXACTLY these keys (no nulls for medicineName):
                  "medicineName": string (required, cleaned name without prefix),
                  "dosage": string (e.g. "1 tablet", "0.5 tablet"),
                  "instructions": string (e.g. "After food", "As directed"),
                  "times": array of HH:mm strings (e.g. ["08:00","21:00"])
                """;

        String jsonBody = buildVisionBody(textPrompt, mimeType, base64Image);
        try {
            return callGemini(jsonBody);
        } catch (Exception e) {
            System.err.println("[GeminiOcrService] parsePrescriptionFromImage failed: " + e.getMessage());
            return "[]";
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Text parse: extracted text → structured JSON medicine array
    // Used as fallback when vision parse returns empty
    // ─────────────────────────────────────────────────────────────────────────

    public String parsePrescriptionTextToJson(String text) {
        if (!isAvailable()) return "[]";

        String prompt = """
                You are a prescription parser. Extract all medicines from the text below.
                Prescriptions often use formats like:
                  TAB. MEDICINE NAME | 1 Morning, 1 Night
                  CAP. MEDICINE NAME | 1 Morning, 1 Afternoon, 1 Night (After Food)
                  MEDICINE NAME | 1/2 Morning, 1/2 Night (Before Food)

                Rules:
                - Remove prefixes like TAB., CAP., SYR., INJ. from medicine names
                - Convert time keywords: Morning=08:00, Afternoon/Aft=14:00, Evening/Eve=18:00, Night=21:00
                - Convert quantities: "1" = "1 tablet", "1/2" = "0.5 tablet"
                - Extract instructions from parentheses like (Before Food), (After Food)
                - If instructions not found, use "As directed"

                Return ONLY a valid JSON array, no markdown, no explanation.
                Each element must have EXACTLY these keys:
                  "medicineName": string (required, cleaned name without prefix),
                  "dosage": string (e.g. "1 tablet", "0.5 tablet"),
                  "instructions": string (e.g. "After food", "As directed"),
                  "times": array of HH:mm strings (e.g. ["08:00","21:00"])

                Prescription text:
                """ + text;

        String jsonBody = buildTextBody(prompt);
        try {
            return callGemini(jsonBody);
        } catch (Exception e) {
            System.err.println("[GeminiOcrService] parsePrescriptionTextToJson failed: " + e.getMessage());
            return "[]";
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    private String buildVisionBody(String textPrompt, String mimeType, String base64Image) {
        return """
                {
                  "contents": [{
                    "parts": [
                      { "text": "%s" },
                      { "inlineData": { "mimeType": "%s", "data": "%s" } }
                    ]
                  }]
                }
                """.formatted(escapeJson(textPrompt), mimeType, base64Image);
    }

    private String buildTextBody(String prompt) {
        return """
                {
                  "contents": [{ "parts": [{ "text": "%s" }] }]
                }
                """.formatted(escapeJson(prompt));
    }

    private String escapeJson(String s) {
        return s
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }

    /**
     * Calls Gemini with exponential-backoff retry on 429 / quota errors.
     */
    private String callGemini(String jsonBody) throws Exception {
        Exception lastException = null;

        for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(geminiEndpoint + "?key=" + apiKey))
                        .header("Content-Type", "application/json")
                        .timeout(Duration.ofSeconds(REQUEST_TIMEOUT_SEC))
                        .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8))
                        .build();

                HttpResponse<String> response =
                        httpClient.send(request, HttpResponse.BodyHandlers.ofString());

                int statusCode = response.statusCode();

                if (statusCode == 429 || statusCode == 503) {
                    long delay = RETRY_DELAY_MS * attempt;
                    System.err.println("[GeminiOcrService] HTTP " + statusCode
                            + " on attempt " + attempt + "/" + MAX_RETRIES
                            + " — retrying in " + delay + "ms");
                    if (attempt < MAX_RETRIES) {
                        Thread.sleep(delay);
                        continue;
                    }
                    throw new RuntimeException("Gemini OCR rate limit exceeded. Please try again in a moment.");
                }

                JsonNode root = objectMapper.readTree(response.body());

                if (root.has("error")) {
                    String errMsg  = root.path("error").path("message").asText("unknown error");
                    int    errCode = root.path("error").path("code").asInt(0);
                    System.err.println("[GeminiOcrService] Gemini error " + errCode + ": " + errMsg);

                    if (errCode == 429 || errMsg.toLowerCase().contains("quota")
                            || errMsg.toLowerCase().contains("resource exhausted")) {
                        long delay = RETRY_DELAY_MS * attempt;
                        if (attempt < MAX_RETRIES) {
                            Thread.sleep(delay);
                            continue;
                        }
                        throw new RuntimeException("Gemini OCR quota exceeded. Please try again later.");
                    }
                    throw new RuntimeException("Gemini OCR error: " + errMsg);
                }

                JsonNode candidates = root.path("candidates");
                if (candidates.isMissingNode() || candidates.isEmpty()) {
                    System.err.println("[GeminiOcrService] Empty candidates in Gemini response");
                    return "";
                }

                return candidates.get(0)
                        .path("content")
                        .path("parts")
                        .get(0)
                        .path("text")
                        .asText();

            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                lastException = e;
                System.err.println("[GeminiOcrService] Attempt " + attempt + " failed: " + e.getMessage());
                if (attempt < MAX_RETRIES) {
                    Thread.sleep(RETRY_DELAY_MS * attempt);
                }
            }
        }

        throw new RuntimeException("Gemini OCR failed after " + MAX_RETRIES + " attempts", lastException);
    }
}
