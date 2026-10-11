package com.example.dosebuddy.controller;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.MedicationRepository;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.service.ActivityService;
import com.example.dosebuddy.service.UnifiedAiService;
import com.example.dosebuddy.security.UserPrincipal;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.HashMap;

@RestController
@RequestMapping("/api/ai")
@CrossOrigin("*")
public class UnifiedAiController {

    private final UnifiedAiService aiService;
    private final ActivityService activityService;
    private final UserRepository userRepository;
    private final MedicationRepository medicationRepository;

    public UnifiedAiController(UnifiedAiService aiService, 
                              ActivityService activityService, 
                              UserRepository userRepository,
                              MedicationRepository medicationRepository) {
        this.aiService = aiService;
        this.activityService = activityService;
        this.userRepository = userRepository;
        this.medicationRepository = medicationRepository;
    }

    @PostMapping("/chat")
    public ResponseEntity<Map<String, Object>> processChat(@RequestBody Map<String, Object> request,
                                                          @AuthenticationPrincipal UserPrincipal principal) {
        Map<String, Object> response = new HashMap<>();
        
        try {
            String message = (String) request.get("message");
            String conversationId = (String) request.get("conversationId");
            @SuppressWarnings("unchecked")
            Map<String, Object> conversationState = (Map<String, Object>) request.get("conversationState");
            
            if (message == null || message.isBlank()) {
                response.put("success", false);
                response.put("error", "Message is required");
                return ResponseEntity.badRequest().body(response);
            }

            User user = userRepository.findById(principal.getUserId()).orElse(null);
            if (user == null) {
                response.put("success", false);
                response.put("error", "User not found");
                return ResponseEntity.badRequest().body(response);
            }

            // Get user's current medications for context
            LocalDate today = LocalDate.now();
            List<Medication> userMedications = medicationRepository
                .findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(user, today, today);

            Map<String, Object> chatResponse = aiService.processUnifiedChat(
                message, conversationId, conversationState, user, userMedications);
            
            // Log activity based on intent
            String intent = (String) chatResponse.get("intent");
            logAiActivity(user, intent, message);
            
            response.put("success", true);
            response.putAll(chatResponse);
            
        } catch (Exception e) {
            System.err.println("[UnifiedAiController] Chat processing error: " + e.getMessage());
            e.printStackTrace();
            response.put("success", false);
            response.put("error", "AI service temporarily unavailable. Please try again later.");
        }
        
        return ResponseEntity.ok(response);
    }

    @GetMapping("/ai-info")
    public ResponseEntity<String> getAiInfo(@RequestParam("name") String name,
                                            @RequestParam(value = "userId", required = false) Long userId) {
        // Wrap the entire handler in a try/catch so any AI service exception
        // returns a 200 with an error-message string instead of a 500.
        // The frontend already handles non-JSON / error responses gracefully.
        String info;
        try {
            info = aiService.getSafeMedicineInfo(name);
        } catch (Exception e) {
            System.err.println("[UnifiedAiController] getSafeMedicineInfo threw: " + e.getMessage());
            info = "AI service temporarily unavailable. Please try again later.";
        }

        if (userId != null) {
            try {
                User user = userRepository.findById(userId).orElse(null);
                if (user != null) {
                    String activityMessage = String.format("Searched medicine information: %s", name);
                    activityService.logActivity(user, "AI_MEDICINE_INFO", activityMessage);
                }
            } catch (Exception e) {
                // Activity logging failure must never affect the response
                System.err.println("[UnifiedAiController] Activity log failed: " + e.getMessage());
            }
        }

        return ResponseEntity.ok(info);
    }

    @PostMapping("/symptom-check")
    public ResponseEntity<String> symptomCheck(@RequestBody Map<String, String> body) {
        String symptoms = body.getOrDefault("symptoms", "");
        String result = aiService.checkSymptoms(symptoms);
        
        String userIdStr = body.get("userId");
        if (userIdStr != null) {
            try {
                Long userId = Long.parseLong(userIdStr);
                User user = userRepository.findById(userId).orElse(null);
                if (user != null) {
                    String activityMessage = String.format("Performed symptom check: %s", 
                        symptoms.length() > 50 ? symptoms.substring(0, 50) + "..." : symptoms);
                    activityService.logActivity(user, "SYMPTOM_CHECK", activityMessage);
                }
            } catch (NumberFormatException e) {
            }
        }
        
        return ResponseEntity.ok(result);
    }

    private void logAiActivity(User user, String intent, String message) {
        try {
            String activityType = switch (intent != null ? intent : "GENERAL") {
                case "MEDICINE_INFO" -> "AI_MEDICINE_INFO";
                case "SYMPTOM_CHECK" -> "SYMPTOM_CHECK";
                case "SIDE_EFFECT" -> "AI_SIDE_EFFECT_CHECK";
                case "INTERACTION" -> "AI_INTERACTION_CHECK";
                case "PRESCRIPTION" -> "AI_PRESCRIPTION_HELP";
                case "SCHEDULE" -> "AI_SCHEDULE_INQUIRY";
                default -> "AI_HEALTH_ASSISTANCE";
            };
            
            String activityMessage = message.length() > 100 
                ? message.substring(0, 100) + "..."
                : message;
            
            activityService.logActivity(user, activityType, "AI Chat: " + activityMessage);
        } catch (Exception e) {
            System.err.println("[UnifiedAiController] Activity log failed: " + e.getMessage());
        }
    }
}
