package com.example.dosebuddy.service;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.regex.Pattern;

@Service
public class UnifiedAiService {

    @Value("${groq.api.key:}")
    private String groqApiKey;

    @Value("${gemini.api.key:}")
    private String geminiApiKey;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    // Urgent symptom patterns for safety detection
    private static final List<Pattern> URGENT_PATTERNS = Arrays.asList(
            Pattern.compile("\\b(chest pain|difficulty breathing|can't breathe|trouble breathing)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(severe headache|worst headache|sudden headache)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(facial drooping|face drooping|speech slurred|can't speak)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(weakness|numbness|paralysis)\\b.*\\b(one side|left side|right side)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(severe allergic reaction|anaphylaxis|throat swelling)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(overdose|took too much|double dose)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(high fever)\\b.*\\b(stiff neck|confusion|rash)\\b", Pattern.CASE_INSENSITIVE)
    );

    public Map<String, Object> processUnifiedChat(String message, String conversationId, 
                                                 Map<String, Object> conversationState,
                                                 User user, List<Medication> userMedications) throws Exception {
        
        Map<String, Object> response = new HashMap<>();
        
        // Initialize conversation state if not provided
        if (conversationState == null) {
            conversationState = new HashMap<>();
        }
        
        // Safety check for urgent symptoms
        if (containsUrgentSymptoms(message)) {
            return createUrgentWarningResponse(message, conversationId, conversationState);
        }
        
        // Detect intent if not already determined
        String currentIntent = (String) conversationState.get("currentIntent");
        if (currentIntent == null) {
            currentIntent = detectIntent(message, userMedications);
            conversationState.put("currentIntent", currentIntent);
        }
        
        // Process based on intent
        switch (currentIntent) {
            case "MEDICINE_INFO":
                return processMedicineInfoIntent(message, conversationId, conversationState, userMedications);
                
            case "SYMPTOM_CHECK":
                return processSymptomCheckIntent(message, conversationId, conversationState, userMedications);
                
            case "SIDE_EFFECT":
                return processSideEffectIntent(message, conversationId, conversationState, userMedications);
                
            case "INTERACTION":
                return processInteractionIntent(message, conversationId, conversationState, userMedications);
                
            case "SCHEDULE":
                return processScheduleIntent(message, conversationId, conversationState, userMedications);
                
            case "PRESCRIPTION":
                return processPrescriptionIntent(message, conversationId, conversationState);
                
            default:
                return processGeneralHealthIntent(message, conversationId, conversationState);
        }
    }
    private boolean containsUrgentSymptoms(String message) {
        return URGENT_PATTERNS.stream().anyMatch(pattern -> pattern.matcher(message).find());
    }
    
    private Map<String, Object> createUrgentWarningResponse(String message, String conversationId, 
                                                           Map<String, Object> conversationState) {
        Map<String, Object> response = new HashMap<>();
        response.put("type", "URGENT_WARNING");
        response.put("intent", "EMERGENCY");
        response.put("conversationId", conversationId);
        response.put("conversationState", conversationState);
        
        String warningMessage = "⚠️ **URGENT MEDICAL ATTENTION NEEDED**\n\n" +
                "Based on your symptoms, you should seek immediate medical care or contact emergency services.\n\n" +
                "🚨 **If this is a medical emergency:**\n" +
                "• Call your local emergency number (911, 112, etc.)\n" +
                "• Go to the nearest emergency room\n" +
                "• Contact your healthcare provider immediately\n\n" +
                "DoseBuddy cannot provide emergency medical assistance. Please seek professional help right away.";
        
        response.put("message", warningMessage);
        response.put("requiresAction", true);
        response.put("actionType", "EMERGENCY_GUIDANCE");
        
        return response;
    }
    
    private String detectIntent(String message, List<Medication> userMedications) {
        String lowerMessage = message.toLowerCase();
        
        // Check for medication-related queries
        if (lowerMessage.matches(".*\\b(medicine|medication|drug|pill|tablet)\\b.*\\b(info|information|about|what|tell)\\b.*") ||
            lowerMessage.matches(".*\\bwhat.*(is|does)\\b.*\\b(medicine|medication|drug)\\b.*")) {
            return "MEDICINE_INFO";
        }
        
        // Check for symptom reports
        if (lowerMessage.matches(".*\\b(feel|feeling|have|experiencing|symptom)\\b.*(pain|ache|sick|nausea|dizzy|fever|headache|stomach)\\b.*") ||
            lowerMessage.matches(".*\\b(pain|ache|sick|nausea|dizzy|fever|headache|stomach)\\b.*")) {
            return "SYMPTOM_CHECK";
        }
        
        // Check for side effect concerns
        if (lowerMessage.matches(".*\\b(side effect|adverse|reaction)\\b.*") ||
            lowerMessage.matches(".*\\b(cause|caused by|from taking|after taking)\\b.*\\b(medicine|medication|drug)\\b.*")) {
            return "SIDE_EFFECT";
        }
        
        // Check for interaction queries
        if (lowerMessage.matches(".*\\b(interact|interaction|together|combine|mix)\\b.*\\b(medicine|medication|drug)\\b.*") ||
            lowerMessage.matches(".*\\bcan.*take.*(with|together)\\b.*")) {
            return "INTERACTION";
        }
        
        // Check for schedule/dosage questions
        if (lowerMessage.matches(".*\\b(schedule|when|time|dose|dosage|how often|missed|miss)\\b.*\\b(take|taking)\\b.*") ||
            lowerMessage.matches(".*\\b(today|tomorrow|morning|evening)\\b.*\\b(medicine|medication)\\b.*")) {
            return "SCHEDULE";
        }
        
        // Check for prescription questions
        if (lowerMessage.matches(".*\\b(prescription|prescribed|doctor said|instructions)\\b.*")) {
            return "PRESCRIPTION";
        }
        
        return "GENERAL";
    }
    private Map<String, Object> processMedicineInfoIntent(String message, String conversationId,
                                                        Map<String, Object> conversationState,
                                                        List<Medication> userMedications) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "MEDICINE_INFO");
        response.put("conversationId", conversationId);
        
        String medicineName = extractMedicineName(message, userMedications);
        
        if (medicineName == null && !userMedications.isEmpty()) {
            // Ask user to select from their medications
            response.put("type", "QUESTION");
            response.put("message", "I can help you learn about medicines. Which medicine would you like to know about?");
            response.put("questionType", "MEDICINE_SELECTION");
            
            List<Map<String, String>> options = new ArrayList<>();
            for (Medication med : userMedications) {
                Map<String, String> option = new HashMap<>();
                option.put("id", med.getId().toString());
                option.put("text", med.getName() + " (" + med.getDosage() + ")");
                option.put("value", med.getName());
                options.add(option);
            }
            
            Map<String, String> customOption = new HashMap<>();
            customOption.put("id", "custom");
            customOption.put("text", "Other medicine not in my list");
            customOption.put("value", "custom");
            options.add(customOption);
            
            response.put("options", options);
            response.put("conversationState", conversationState);
            return response;
        }
        
        if (medicineName == null) {
            // Ask for medicine name
            response.put("type", "QUESTION");
            response.put("message", "What medicine would you like to learn about?");
            response.put("questionType", "TEXT_INPUT");
            response.put("placeholder", "Enter medicine name...");
            response.put("conversationState", conversationState);
            return response;
        }
        
        // Provide medicine information
        String medicineInfo = getSafeMedicineInfo(medicineName);
        
        response.put("type", "RESPONSE");
        response.put("message", medicineInfo);
        response.put("medicineName", medicineName);
        conversationState.put("completed", true);
        response.put("conversationState", conversationState);
        
        return response;
    }
    
    private Map<String, Object> processSymptomCheckIntent(String message, String conversationId,
                                                         Map<String, Object> conversationState,
                                                         List<Medication> userMedications) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "SYMPTOM_CHECK");
        response.put("conversationId", conversationId);
        
        String currentQuestion = (String) conversationState.get("currentQuestion");
        
        if (currentQuestion == null) {
            // First interaction - ask about symptom severity
            String symptom = extractSymptom(message);
            conversationState.put("reportedSymptom", symptom != null ? symptom : message);
            conversationState.put("currentQuestion", "severity");
            
            response.put("type", "QUESTION");
            response.put("message", "I understand you're experiencing " + 
                (symptom != null ? symptom : "symptoms") + 
                ". How would you describe the severity?");
            response.put("questionType", "SINGLE_SELECT");
            
            List<Map<String, String>> options = Arrays.asList(
                createOption("mild", "Mild", "Noticeable but manageable"),
                createOption("moderate", "Moderate", "Interfering with normal activities"), 
                createOption("severe", "Severe", "Difficult to continue normal activities"),
                createOption("very-severe", "Very severe", "Extremely intense"),
                createOption("custom", "Describe it differently", "")
            );
            
            response.put("options", options);
            response.put("conversationState", conversationState);
            return response;
        }
        
        if ("severity".equals(currentQuestion)) {
            conversationState.put("severity", message);
            conversationState.put("currentQuestion", "duration");
            
            response.put("type", "QUESTION");
            response.put("message", "When did this start?");
            response.put("questionType", "SINGLE_SELECT");
            
            List<Map<String, String>> options = Arrays.asList(
                createOption("today", "Started today", ""),
                createOption("1-2-days", "1-2 days ago", ""),
                createOption("3-7-days", "3-7 days ago", ""),
                createOption("week-plus", "More than a week ago", ""),
                createOption("not-sure", "I'm not sure", ""),
                createOption("custom", "Other timeframe", "")
            );
            
            response.put("options", options);
            response.put("conversationState", conversationState);
            return response;
        }
        
        if ("duration".equals(currentQuestion)) {
            conversationState.put("duration", message);
            
            // Check if user has medications that might be relevant
            if (!userMedications.isEmpty()) {
                conversationState.put("currentQuestion", "medication-timing");
                
                response.put("type", "QUESTION");
                response.put("message", "I see you take medications. Did this symptom start before or after you began taking any medicine?");
                response.put("questionType", "SINGLE_SELECT");
                
                List<Map<String, String>> options = Arrays.asList(
                    createOption("before", "Before I started any medicine", ""),
                    createOption("after-dose", "Soon after taking a dose", ""),
                    createOption("hours-after", "Several hours after taking medicine", ""),
                    createOption("independent", "It happens even when I don't take medicine", ""),
                    createOption("not-sure", "I'm not sure about the timing", ""),
                    createOption("custom", "Let me explain the timing", "")
                );
                
                response.put("options", options);
                response.put("conversationState", conversationState);
                return response;
            }
        }
        
        // Generate final symptom analysis
        return generateSymptomAnalysis(conversationState, conversationId, userMedications);
    }
    private Map<String, String> createOption(String id, String text, String description) {
        Map<String, String> option = new HashMap<>();
        option.put("id", id);
        option.put("text", text);
        if (!description.isEmpty()) {
            option.put("description", description);
        }
        return option;
    }
    
    private Map<String, Object> generateSymptomAnalysis(Map<String, Object> conversationState,
                                                       String conversationId,
                                                       List<Medication> userMedications) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "SYMPTOM_CHECK");
        response.put("conversationId", conversationId);
        response.put("type", "RESPONSE");
        
        String reportedSymptom = (String) conversationState.get("reportedSymptom");
        String severity = (String) conversationState.get("severity");
        String duration = (String) conversationState.get("duration");
        String medicationTiming = (String) conversationState.get("medicationTiming");
        
        // Build context for AI analysis
        StringBuilder contextBuilder = new StringBuilder();
        contextBuilder.append("Patient reports: ").append(reportedSymptom).append("\n");
        if (severity != null) contextBuilder.append("Severity: ").append(severity).append("\n");
        if (duration != null) contextBuilder.append("Duration: ").append(duration).append("\n");
        if (medicationTiming != null) contextBuilder.append("Timing relative to medications: ").append(medicationTiming).append("\n");
        
        if (!userMedications.isEmpty()) {
            contextBuilder.append("Current medications: ");
            for (int i = 0; i < userMedications.size(); i++) {
                Medication med = userMedications.get(i);
                contextBuilder.append(med.getName()).append(" ").append(med.getDosage());
                if (i < userMedications.size() - 1) contextBuilder.append(", ");
            }
            contextBuilder.append("\n");
        }
        
        String analysis = checkSymptoms(contextBuilder.toString());
        
        response.put("message", analysis);
        conversationState.put("completed", true);
        response.put("conversationState", conversationState);
        
        return response;
    }
    
    private Map<String, Object> processSideEffectIntent(String message, String conversationId,
                                                       Map<String, Object> conversationState,
                                                       List<Medication> userMedications) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "SIDE_EFFECT");
        response.put("conversationId", conversationId);
        
        String currentQuestion = (String) conversationState.get("currentQuestion");
        
        if (currentQuestion == null && !userMedications.isEmpty()) {
            conversationState.put("currentQuestion", "which-medicine");
            
            response.put("type", "QUESTION");
            response.put("message", "Which medicine do you think might be causing this?");
            response.put("questionType", "SINGLE_SELECT");
            
            List<Map<String, String>> options = new ArrayList<>();
            for (Medication med : userMedications) {
                options.add(createOption(med.getId().toString(), med.getName() + " (" + med.getDosage() + ")", ""));
            }
            options.add(createOption("not-sure", "I'm not sure which one", ""));
            options.add(createOption("all", "It could be any of them", ""));
            
            response.put("options", options);
            response.put("conversationState", conversationState);
            return response;
        }
        
        // Continue with side effect analysis...
        String analysis = "Based on your description, this could potentially be related to your medication. " +
                         "However, I cannot definitively determine if this is a side effect. " +
                         "Please contact your healthcare provider or pharmacist to discuss this concern. " +
                         "If symptoms are severe or worsening, seek medical attention promptly.";
        
        response.put("type", "RESPONSE");
        response.put("message", analysis);
        conversationState.put("completed", true);
        response.put("conversationState", conversationState);
        
        return response;
    }
    
    private Map<String, Object> processInteractionIntent(String message, String conversationId,
                                                        Map<String, Object> conversationState,
                                                        List<Medication> userMedications) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "INTERACTION");
        response.put("conversationId", conversationId);
        response.put("type", "RESPONSE");
        
        String analysis = "For medication interaction questions, I recommend consulting with your pharmacist " +
                         "or healthcare provider who can check your complete medication list against reliable " +
                         "drug interaction databases. They can provide personalized advice based on your " +
                         "specific medications, dosages, and health conditions.";
        
        if (!userMedications.isEmpty()) {
            analysis = "I see you're currently taking " + userMedications.size() + " medication(s). " + analysis;
        }
        
        response.put("message", analysis);
        conversationState.put("completed", true);
        response.put("conversationState", conversationState);
        
        return response;
    }
    
    private Map<String, Object> processScheduleIntent(String message, String conversationId,
                                                     Map<String, Object> conversationState,
                                                     List<Medication> userMedications) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "SCHEDULE");
        response.put("conversationId", conversationId);
        response.put("type", "RESPONSE");
        
        if (userMedications.isEmpty()) {
            response.put("message", "You don't have any medicines scheduled in DoseBuddy yet. " +
                                   "You can add them using the 'Add Medicine' section to get personalized scheduling help.");
        } else {
            StringBuilder scheduleInfo = new StringBuilder();
            scheduleInfo.append("Here are your current medications in DoseBuddy:\n\n");
            
            for (Medication med : userMedications) {
                scheduleInfo.append("• **").append(med.getName()).append("** (").append(med.getDosage()).append(")\n");
                if (med.getTimes() != null && !med.getTimes().isEmpty()) {
                    scheduleInfo.append("  Times: ");
                    for (int i = 0; i < med.getTimes().size(); i++) {
                        scheduleInfo.append(med.getTimes().get(i).getTimeOfDay());
                        if (i < med.getTimes().size() - 1) scheduleInfo.append(", ");
                    }
                    scheduleInfo.append("\n");
                }
                if (med.getInstructions() != null && !med.getInstructions().isEmpty()) {
                    scheduleInfo.append("  Instructions: ").append(med.getInstructions()).append("\n");
                }
                scheduleInfo.append("\n");
            }
            
            scheduleInfo.append("For questions about missed doses or timing changes, please consult your healthcare provider.");
            response.put("message", scheduleInfo.toString());
        }
        
        conversationState.put("completed", true);
        response.put("conversationState", conversationState);
        return response;
    }
    
    private Map<String, Object> processPrescriptionIntent(String message, String conversationId,
                                                         Map<String, Object> conversationState) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "PRESCRIPTION");
        response.put("conversationId", conversationId);
        response.put("type", "RESPONSE");
        
        String analysis = "For prescription-related questions, I recommend:\n\n" +
                         "• Contact your prescribing healthcare provider for clarification\n" +
                         "• Speak with your pharmacist about dosage or administration questions\n" +
                         "• Use DoseBuddy's prescription upload feature to help organize your medications\n\n" +
                         "Always follow the instructions provided by your healthcare provider and pharmacist.";
        
        response.put("message", analysis);
        conversationState.put("completed", true);
        response.put("conversationState", conversationState);
        
        return response;
    }
    
    private Map<String, Object> processGeneralHealthIntent(String message, String conversationId,
                                                          Map<String, Object> conversationState) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("intent", "GENERAL");
        response.put("conversationId", conversationId);
        response.put("type", "RESPONSE");
        
        String analysis = "I'm here to help with medicine information, symptom questions, and medication management. " +
                         "For general health questions, please consult with qualified healthcare professionals. " +
                         "Is there something specific about your medications or symptoms I can help you with?";
        
        response.put("message", analysis);
        conversationState.put("completed", true);
        response.put("conversationState", conversationState);
        
        return response;
    }
    private String extractMedicineName(String message, List<Medication> userMedications) {
        // First check if message contains any of user's current medications
        for (Medication med : userMedications) {
            if (message.toLowerCase().contains(med.getName().toLowerCase())) {
                return med.getName();
            }
        }
        
        // Extract medicine name from natural language
        String[] commonMedicinePatterns = {
            "\\babout\\s+([\\w\\s]+?)\\s*[.?!]?$",
            "\\bwhat\\s+is\\s+([\\w\\s]+?)\\s*[.?!]?$", 
            "\\btell\\s+me\\s+about\\s+([\\w\\s]+?)\\s*[.?!]?$",
            "\\binformation\\s+on\\s+([\\w\\s]+?)\\s*[.?!]?$"
        };
        
        for (String pattern : commonMedicinePatterns) {
            java.util.regex.Pattern p = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE);
            java.util.regex.Matcher m = p.matcher(message);
            if (m.find()) {
                return m.group(1).trim();
            }
        }
        
        return null;
    }
    
    private String extractSymptom(String message) {
        String[] symptomKeywords = {"headache", "fever", "nausea", "pain", "ache", "dizzy", "sick", "stomach"};
        
        for (String symptom : symptomKeywords) {
            if (message.toLowerCase().contains(symptom)) {
                return symptom;
            }
        }
        
        return null;
    }
    
    // Legacy methods for backward compatibility
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
    private boolean isAllApiKeysMissing() {
        return (groqApiKey == null || groqApiKey.isBlank()) && 
               (geminiApiKey == null || geminiApiKey.isBlank());
    }

    private String generateAiResponse(String prompt) throws Exception {
        if (groqApiKey != null && !groqApiKey.isBlank()) {
            return callGroq(prompt, "llama-3.1-70b-versatile");
        } else if (geminiApiKey != null && !geminiApiKey.isBlank()) {
            return callGemini(prompt);
        } else {
            throw new Exception("No AI API keys configured");
        }
    }

    private String callGroq(String userMessage, String targetModel) throws Exception {
        String requestBody = buildGroqRequestBody(userMessage, targetModel);
        
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://api.groq.com/openai/v1/chat/completions"))
                .header("Authorization", "Bearer " + groqApiKey)
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        
        if (response.statusCode() != 200) {
            throw new RuntimeException("Groq API error: " + response.statusCode() + " - " + response.body());
        }

        Map<String, Object> responseMap = objectMapper.readValue(response.body(), Map.class);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> choices = (List<Map<String, Object>>) responseMap.get("choices");
        
        if (choices == null || choices.isEmpty()) {
            throw new RuntimeException("No response from Groq API");
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> message = (Map<String, Object>) choices.get(0).get("message");
        return (String) message.get("content");
    }

    private String buildGroqRequestBody(String userMessage, String targetModel) throws Exception {
        Map<String, Object> systemMessage = Map.of(
            "role", "system",
            "content", "You are a helpful medical information assistant. Provide accurate, safe information while always recommending consultation with healthcare professionals for medical decisions."
        );
        
        Map<String, Object> userMsg = Map.of(
            "role", "user", 
            "content", userMessage
        );
        
        Map<String, Object> requestBody = Map.of(
            "model", targetModel,
            "messages", Arrays.asList(systemMessage, userMsg),
            "max_tokens", 1000,
            "temperature", 0.3
        );
        
        return objectMapper.writeValueAsString(requestBody);
    }

    private String callGemini(String prompt) throws Exception {
        Map<String, Object> requestBody = Map.of(
            "contents", Arrays.asList(Map.of(
                "parts", Arrays.asList(Map.of("text", prompt))
            )),
            "generationConfig", Map.of(
                "temperature", 0.3,
                "maxOutputTokens", 1000
            )
        );
        
        String jsonBody = objectMapper.writeValueAsString(requestBody);
        
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" + geminiApiKey))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        
        if (response.statusCode() != 200) {
            throw new RuntimeException("Gemini API error: " + response.statusCode() + " - " + response.body());
        }

        Map<String, Object> responseMap = objectMapper.readValue(response.body(), Map.class);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> candidates = (List<Map<String, Object>>) responseMap.get("candidates");
        
        if (candidates == null || candidates.isEmpty()) {
            throw new RuntimeException("No response from Gemini API");
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> content = (Map<String, Object>) candidates.get(0).get("content");
        @SuppressWarnings("unchecked") 
        List<Map<String, Object>> parts = (List<Map<String, Object>>) content.get("parts");
        
        return (String) parts.get(0).get("text");
    }

    private String cleanOutput(String text) {
        if (text == null) return "";
        return text.trim()
                  .replaceAll("\\*\\*", "")  // Remove markdown bold
                  .replaceAll("##\\s*", "")  // Remove markdown headers  
                  .replaceAll("\\*\\s*", "• "); // Convert * to bullet points
    }
}