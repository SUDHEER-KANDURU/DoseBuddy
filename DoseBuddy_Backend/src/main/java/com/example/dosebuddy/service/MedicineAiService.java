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
import java.util.List;
import java.util.Map;

/**
 * Handles ALL Groq API calls — AI assistant, symptom checker,
 * BMI suggestions, health tips, and text-based prescription parsing.
 *
 * Image OCR is handled exclusively by GeminiOcrService.
 */
@Service
public class MedicineAiService {

    private static final String GROQ_URL            = "https://api.groq.com/openai/v1/chat/completions";
    private static final int    MAX_RETRIES         = 2;
    private static final long   RETRY_DELAY_MS      = 1500L;
    private static final int    REQUEST_TIMEOUT_SEC = 30;

    private final String apiKey;
    private final String model;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    public MedicineAiService(
            @Value("${groq.model:llama-3.3-70b-versatile}") String groqModel,
            @Value("${GROQ_API_KEY:}") String groqApiKey) {

        this.apiKey       = groqApiKey.isBlank() ? System.getenv("GROQ_API_KEY") : groqApiKey;
        this.model        = groqModel;
        this.httpClient   = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(REQUEST_TIMEOUT_SEC))
                .build();
        this.objectMapper = new ObjectMapper();

        System.out.println("[AI] Chat Provider: Groq");
        System.out.println("[AI] Groq Model: " + this.model);
        System.out.println("[AI] Groq API key loaded: "
                + (this.apiKey != null && !this.apiKey.isBlank() ? "YES" : "NO — chat AI features will be disabled"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API — all conversational / chat features
    // ─────────────────────────────────────────────────────────────────────────

    public String getSafeMedicineInfo(String rawName) {
        if (rawName == null || rawName.isBlank()) return "Please provide a valid medicine name.";
        if (isApiKeyMissing()) return "AI lookup failed: Groq API key is not configured.";

        String prompt = """
                You are a professional medical information assistant. Provide structured, safe information about: %s

                Use EXACTLY these section headings in this order (include the colon):
                MEDICINE OVERVIEW:
                DOSAGE INFORMATION:
                COMMON USES:
                WARNINGS & PRECAUTIONS:
                SIDE EFFECTS:
                WHEN TO CONSULT A DOCTOR:

                Rules:
                - Use each heading exactly as written above
                - Under each heading, write 1-3 concise sentences or a short bullet list
                - Do NOT use markdown symbols like **, ##, or *
                - Keep the total response brief and easy to read
                - End with: "Always consult a qualified healthcare provider before starting or changing any medication."
                """.formatted(rawName);
        try {
            return callGroq(prompt);
        } catch (Exception e) {
            return "Error: " + e.getMessage();
        }
    }

    public String checkSymptoms(String symptoms) {
        if (symptoms == null || symptoms.isBlank()) return "Please describe your symptoms.";
        if (isApiKeyMissing()) return "AI lookup failed: Groq API key is not configured.";

        String prompt = """
                A patient reports these symptoms: %s
                List possible causes and what they can do. Keep it brief and safe.
                End with: "Please consult a doctor for proper diagnosis."
                Use these section headings exactly:
                Possible Causes:
                What the Person Can Do:
                When to See a Doctor:
                """.formatted(symptoms);

        try {
            return callGroq(prompt);
        } catch (Exception e) {
            return "Error: " + e.getMessage();
        }
    }

    /**
     * Text-based prescription parsing — used for PDF / DOCX / TXT uploads.
     * Image-based parsing is handled by GeminiOcrService.
     */
    public String parsePrescriptionToJson(String text) {
        if (isApiKeyMissing()) return "[]";

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

        try {
            return callGroq(prompt);
        } catch (Exception e) {
            System.err.println("[MedicineAiService] parsePrescriptionToJson failed: " + e.getMessage());
            return "[]";
        }
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> parseMedicines(String json) {
        try {
            return objectMapper.readValue(json, List.class);
        } catch (Exception e) {
            System.err.println("[MedicineAiService] parseMedicines failed: " + e.getMessage());
            return List.of();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    private boolean isApiKeyMissing() {
        return apiKey == null || apiKey.isBlank();
    }

    /**
     * Calls Groq (OpenAI-compatible) with exponential-backoff retry on 429 / 503.
     */
    private String callGroq(String userMessage) throws Exception {
        Exception lastException = null;

        for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                String jsonBody = buildRequestBody(userMessage);

                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(GROQ_URL))
                        .header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + apiKey)
                        .timeout(Duration.ofSeconds(REQUEST_TIMEOUT_SEC))
                        .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8))
                        .build();

                HttpResponse<String> response =
                        httpClient.send(request, HttpResponse.BodyHandlers.ofString());

                int statusCode = response.statusCode();

                if (statusCode == 429 || statusCode == 503) {
                    long delay = RETRY_DELAY_MS * attempt;
                    System.err.println("[MedicineAiService] Groq HTTP " + statusCode
                            + " on attempt " + attempt + "/" + MAX_RETRIES
                            + " — retrying in " + delay + "ms");
                    if (attempt < MAX_RETRIES) {
                        Thread.sleep(delay);
                        continue;
                    }
                    throw new RuntimeException("AI service is busy. Please try again in a moment.");
                }

                JsonNode root = objectMapper.readTree(response.body());

                if (root.has("error")) {
                    String errMsg  = root.path("error").path("message").asText("unknown error");
                    int    errCode = root.path("error").path("code").asInt(0);
                    System.err.println("[MedicineAiService] Groq error " + errCode + ": " + errMsg);

                    String lower = errMsg.toLowerCase();
                    if (errCode == 429 || lower.contains("rate limit")
                            || lower.contains("quota") || lower.contains("resource exhausted")) {
                        long delay = RETRY_DELAY_MS * attempt;
                        if (attempt < MAX_RETRIES) {
                            System.err.println("[MedicineAiService] Rate limit — retrying in " + delay + "ms");
                            Thread.sleep(delay);
                            continue;
                        }
                        throw new RuntimeException("AI service quota exceeded. Please try again later.");
                    }
                    throw new RuntimeException("AI error: " + errMsg);
                }

                JsonNode choices = root.path("choices");
                if (choices.isMissingNode() || choices.isEmpty()) {
                    System.err.println("[MedicineAiService] Empty choices in Groq response");
                    return "";
                }

                return choices.get(0)
                        .path("message")
                        .path("content")
                        .asText();

            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                lastException = e;
                System.err.println("[MedicineAiService] Attempt " + attempt + " failed: " + e.getMessage());
                if (attempt < MAX_RETRIES) {
                    Thread.sleep(RETRY_DELAY_MS * attempt);
                }
            }
        }

        throw new RuntimeException("Groq API call failed after " + MAX_RETRIES + " attempts", lastException);
    }

    private String buildRequestBody(String userMessage) throws Exception {
        Map<String, Object> message = Map.of("role", "user", "content", userMessage);
        Map<String, Object> body    = Map.of("model", model, "messages", List.of(message));
        return objectMapper.writeValueAsString(body);
    }
}
