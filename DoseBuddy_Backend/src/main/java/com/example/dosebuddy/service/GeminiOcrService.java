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
            @Value("${gemini.model:${GEMINI_MODEL:gemini-3.6-flash}}") String geminiModel,
            @Value("${gemini.api.key:${GEMINI_API_KEY:}}") String geminiApiKey) {

        // Resolve API key: Spring property first, then raw env var fallback
        String key = (geminiApiKey != null && !geminiApiKey.isBlank())
                ? geminiApiKey
                : (System.getenv("GEMINI_API_KEY") != null ? System.getenv("GEMINI_API_KEY") : "");

        String model = (geminiModel != null && !geminiModel.isBlank()) ? geminiModel.trim() : "gemini-3.6-flash";

        this.apiKey         = key.trim();
        this.geminiEndpoint = GEMINI_BASE_URL + model + ":generateContent";
        this.httpClient     = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(REQUEST_TIMEOUT_SEC))
                .build();
        this.objectMapper   = new ObjectMapper();

        System.out.println("[AI] OCR Provider  : Gemini");
        System.out.println("[AI] Gemini Model  : " + geminiModel);
        System.out.println("[AI] Gemini API key: " + (this.apiKey.isBlank() ? "NOT SET — prescription image OCR disabled" : "loaded (" + this.apiKey.substring(0, Math.min(6, this.apiKey.length())) + "***)"));
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
                You are an expert prescription parser for Indian hospital prescriptions.
                Carefully read this prescription image and extract EVERY medicine listed.

                Indian prescriptions commonly appear in these formats:
                  1. ESOMAC 40MG TAB 15's  |  Oral, 1 Tablet(s), Morning & Night, Before meal, from 21-Aug-2026 (FRI) For 2 Month(s)
                  2. ACOGUT 300 ER TAB 10'S  |  Oral, 1 Tablet(s), Morning, Before Breakfast, from date
                  3. PANLIPASE CAP  |  Oral, 1 Capsule(s), Morning, Afternoon & Night, After meal
                  4. MENOCTYL 40MG TAB (OTILONIUM BROMIDE)  |  Oral, 1 Capsule(s), Morning & Night, Before meal
                  OR a table with columns: Medicine | Morning | Afternoon | Evening | Night | Instructions

                Rules:
                - Extract the CLEAN medicine name without quantity suffixes like "15's", "10'S", "TAB", "CAP"
                - Keep the dosage strength in the name if present (e.g. "ESOMAC 40MG", "PANLIPASE 300MG")
                - Remove prefixes: TAB., CAP., SYR., INJ., TAB, CAP, ORAL, Oral
                - Map timing keywords: Morning=08:00, Afternoon=14:00, Evening=18:00, Night=21:00, Breakfast=08:00
                - dosage = quantity taken each time (e.g. "1 tablet", "1 capsule", "0.5 tablet")
                - instructions = food timing (e.g. "Before meal", "After meal", "Before Breakfast", "As directed")
                - If a column has "–" or "-" or "0", that time slot is NOT taken — skip it
                - If a column has "1" or any number, that time IS taken — include that time

                Return ONLY a valid JSON array with NO markdown, NO explanation, NO code fences.
                Each element must have EXACTLY these keys:
                  "medicineName": string (clean name + strength, e.g. "ESOMAC 40MG"),
                  "dosage": string (e.g. "1 tablet", "1 capsule"),
                  "instructions": string (e.g. "Before meal", "After meal", "As directed"),
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
                You are an expert prescription parser for Indian hospital prescriptions.
                Extract ALL medicines from the text below.

                Indian prescriptions use formats like:
                  1. ESOMAC 40MG TAB 15's  |  Oral, 1 Tablet(s), Morning & Night, Before meal
                  2. ACOGUT 300 ER TAB 10'S  |  Oral, 1 Tablet(s), Morning, Before Breakfast
                  3. PANLIPASE CAP 300MG  |  Oral, 1 Capsule(s), Morning, Afternoon & Night, After meal
                  TAB. MEDICINE NAME | 1 Morning, 1 Night
                  MEDICINE NAME | 1/2 Morning, 1/2 Night (Before Food)

                Rules:
                - Extract CLEAN medicine name — strip "TAB", "CAP", "SYR", "INJ", quantity suffixes like "15's", "10'S"
                - Keep the dosage strength in the name (e.g. "ESOMAC 40MG", "ACOGUT 300 ER")
                - Map timing: Morning=08:00, Afternoon=14:00, Evening=18:00, Night=21:00, Breakfast=08:00
                - dosage = amount per dose (e.g. "1 tablet", "1 capsule")
                - instructions = food instruction (e.g. "Before meal", "After meal", "As directed")
                - Columns showing "–" or "-" mean that slot is NOT taken

                Return ONLY a valid JSON array, NO markdown, NO explanation, NO code fences.
                Each element must have EXACTLY these keys:
                  "medicineName": string,
                  "dosage": string (e.g. "1 tablet"),
                  "instructions": string (e.g. "Before meal"),
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
