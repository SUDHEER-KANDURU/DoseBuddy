package com.example.dosebuddy.controller;

import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.service.ActivityService;
import com.example.dosebuddy.service.MedicineAiService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/medicine")
@CrossOrigin("*")
public class MedicineAiController {

    private final MedicineAiService aiService;
    private final ActivityService activityService;
    private final UserRepository userRepository;

    public MedicineAiController(MedicineAiService aiService, ActivityService activityService, UserRepository userRepository) {
        this.aiService = aiService;
        this.activityService = activityService;
        this.userRepository = userRepository;
    }

    @GetMapping("/ai-info")
    public ResponseEntity<String> getAiInfo(@RequestParam("name") String name, 
                                            @RequestParam(value = "userId", required = false) Long userId) {
        String info = aiService.getSafeMedicineInfo(name);
        
        if (userId != null) {
            User user = userRepository.findById(userId).orElse(null);
            if (user != null) {
                String activityMessage = String.format("Searched medicine information: %s", name);
                activityService.logActivity(user, "AI_MEDICINE_INFO", activityMessage);
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
}
