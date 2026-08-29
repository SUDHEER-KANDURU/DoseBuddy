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
import java.util.regex.Pattern;

/**
 * Handles AI chat features — AI assistant, symptom checker,
 * and text-based prescription parsing.
 *
 * Uses Groq (defaulting to openai/gpt-oss-20b) with automatic fallback
 * to alternative active Groq models (openai/gpt-oss-120b, qwen/qwen3.8-27b)
 * and Google Gemini (gemini-3.6-flash).
 */
@Service
public class MedicineAiService {

    private static final String GROQ_URL            = "https://api.groq.com/openai/v1/chat/completions";
    private static final String GEMINI_BASE_URL     = "https://generativelanguage.googleapis.com/v1beta/models/";
    private static final int    MAX_RETRIES         = 2;
    private static final long   RETRY_DELAY_MS      = 1500L;
    private static final int    REQUEST_TIMEOUT_SEC = 30;

    private static final List<String> FALLBACK_GROQ_MODELS = List.of(
            "openai/gpt-oss-20b",
            "openai/gpt-oss-120b",
            "qwen/qwen3.8-27b",
            "qwen/qwen3.6-27b"
    );

    private static final Pattern THINK_TAG_PATTERN = Pattern.compile("(?s)<think>.*?</think>");

    private final String groqApiKey;
    private final String groqModel;
    private final String geminiApiKey;
    private final String geminiModel;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    public MedicineAiService(
            @Value("${groq.model:${GROQ_MODEL:openai/gpt-oss-20b}}") String groqModel,
            @Value("${groq.api.key:${GROQ_API_KEY:}}") String groqApiKey,
            @Value("${gemini.model:${GEMINI_MODEL:gemini-3.6-flash}}") String geminiModel,
            @Value("${gemini.api.key:${GEMINI_API_KEY:}}") String geminiApiKey) {

        String gKey = (groqApiKey != null && !groqApiKey.isBlank())
                ? groqApiKey
                : (System.getenv("GROQ_API_KEY") != null ? System.getenv("GROQ_API_KEY") : "");

        String gemKey = (geminiApiKey != null && !geminiApiKey.isBlank())
                ? geminiApiKey
                : (System.getenv("GEMINI_API_KEY") != null ? System.getenv("GEMINI_API_KEY") : "");

        this.groqApiKey   = gKey.trim();
        this.groqModel    = (groqModel != null && !groqModel.isBlank()) ? groqModel.trim() : "openai/gpt-oss-20b";
        this.geminiApiKey = gemKey.trim();
        this.geminiModel  = (geminiModel != null && !geminiModel.isBlank()) ? geminiModel.trim() : "gemini-3.6-flash";

        this.httpClient   = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(REQUEST_TIMEOUT_SEC))
                .build();
        this.objectMapper = new ObjectMapper();

        System.out.println("[AI] Chat Primary  : Groq (" + this.groqModel + ")");
        System.out.println("[AI] Groq Key      : " + (this.groqApiKey.isBlank() ? "NOT SET" : "loaded (" + this.groqApiKey.substring(0, Math.min(6, this.groqApiKey.length())) + "***)"));
        System.out.println("[AI] Chat Fallback : Gemini (" + this.geminiModel + ")");
        System.out.println("[AI] Gemini Key    : " + (this.geminiApiKey.isBlank() ? "NOT SET" : "loaded (" + this.geminiApiKey.substring(0, Math.min(6, this.geminiApiKey.length())) + "***)"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API — all conversational / chat features
    // ─────────────────────────────────────────────────────────────────────────

    public String getSafeMedicineInfo(String rawName) {
        if (rawName == null || rawName.isBlank()) return "Please provide a valid medicine name.";
        if (isAllApiKeysMissing()) return "AI lookup failed: No AI API keys configured.";

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
            String rawResponse = generateAiResponse(prompt);
            return cleanOutput(rawResponse);
        } catch (Exception e) {
            return "Error: " + e.getMessage();
        }
    }

    public String checkSymptoms(String symptoms) {
        if (symptoms == null || symptoms.isBlank()) return "Please describe your symptoms.";
        if (isAllApiKeysMissing()) return "AI lookup failed: No AI API keys configured.";

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
            String rawResponse = generateAiResponse(prompt);
            return cleanOutput(rawResponse);
        } catch (Exception e) {
            return "Error: " + e.getMessage();
        }
    }

    /**
     * Text-based prescription parsing — used for PDF / DOCX / TXT uploads.
     * Image-based parsing is handled by GeminiOcrService.
     */
    public String parsePrescriptionToJson(String text) {
        if (isAllApiKeysMissing()) return "[]";

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
            String rawResponse = generateAiResponse(prompt);
            return cleanOutput(rawResponse);
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
    // Internal multi-provider AI caller (Groq -> Fallback Groq Models -> Gemini)
    // ─────────────────────────────────────────────────────────────────────────

    private boolean isAllApiKeysMissing() {
        return (groqApiKey == null || groqApiKey.isBlank()) && (geminiApiKey == null || geminiApiKey.isBlank());
    }

    private String generateAiResponse(String prompt) throws Exception {
        // Step 1: Try Groq with primary model
        if (groqApiKey != null && !groqApiKey.isBlank()) {
            try {
                return callGroq(prompt, this.groqModel);
            } catch (Exception e) {
                System.err.println("[MedicineAiService] Groq (" + this.groqModel + ") failed: " + e.getMessage());
                
                // Step 2: Try fallback Groq models
                for (String fallbackModel : FALLBACK_GROQ_MODELS) {
                    if (fallbackModel.equalsIgnoreCase(this.groqModel)) continue;
                    try {
                        System.out.println("[MedicineAiService] Retrying Groq with fallback model: " + fallbackModel);
                        return callGroq(prompt, fallbackModel);
                    } catch (Exception ex) {
                        System.err.println("[MedicineAiService] Groq (" + fallbackModel + ") failed: " + ex.getMessage());
                    }
                }
            }
        }

        // Step 3: Fallback to Gemini
        if (geminiApiKey != null && !geminiApiKey.isBlank()) {
            try {
                System.out.println("[MedicineAiService] Falling back to Gemini (" + geminiModel + ")");
                return callGemini(prompt);
            } catch (Exception geminiEx) {
                System.err.println("[MedicineAiService] Gemini fallback failed: " + geminiEx.getMessage());
                throw geminiEx;
            }
        }

        throw new RuntimeException("All AI services failed or are unconfigured.");
    }

    /**
     * Calls Groq (OpenAI-compatible) with exponential-backoff retry on 429 / 503.
     */
    private String callGroq(String userMessage, String targetModel) throws Exception {
        Exception lastException = null;

        for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                String jsonBody = buildGroqRequestBody(userMessage, targetModel);

                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(GROQ_URL))
                        .header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + groqApiKey)
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
                            Thread.sleep(delay);
                            continue;
                        }
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

    private String buildGroqRequestBody(String userMessage, String targetModel) throws Exception {
        Map<String, Object> message = Map.of("role", "user", "content", userMessage);
        Map<String, Object> body    = Map.of("model", targetModel, "messages", List.of(message));
        return objectMapper.writeValueAsString(body);
    }

    /**
     * Calls Gemini text generation as a seamless fallback.
     */
    private String callGemini(String prompt) throws Exception {
        String endpoint = GEMINI_BASE_URL + geminiModel + ":generateContent?key=" + geminiApiKey;
        String jsonBody = """
                {
                  "contents": [{ "parts": [{ "text": "%s" }] }]
                }
                """.formatted(escapeJson(prompt));

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(REQUEST_TIMEOUT_SEC))
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response =
                httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        JsonNode root = objectMapper.readTree(response.body());

        if (root.has("error")) {
            String errMsg = root.path("error").path("message").asText("unknown error");
            throw new RuntimeException("Gemini error: " + errMsg);
        }

        JsonNode candidates = root.path("candidates");
        if (candidates.isMissingNode() || candidates.isEmpty()) {
            return "";
        }

        return candidates.get(0)
                .path("content")
                .path("parts")
                .get(0)
                .path("text")
                .asText();
    }

    private String cleanOutput(String text) {
        if (text == null) return "";
        // Strip reasoning think tags if present
        String cleaned = THINK_TAG_PATTERN.matcher(text).replaceAll("").trim();
        return cleaned;
    }

    private String escapeJson(String s) {
        return s
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }
}
