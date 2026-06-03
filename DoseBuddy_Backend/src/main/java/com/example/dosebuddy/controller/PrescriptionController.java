package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.PrescriptionResponseDto;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.service.ActivityService;
import com.example.dosebuddy.service.PrescriptionService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@RestController
@RequestMapping("/api/prescription")
@CrossOrigin("*")
public class PrescriptionController {

    private final PrescriptionService service;
    private final ActivityService activityService;
    private final UserRepository userRepository;

    public PrescriptionController(PrescriptionService service, ActivityService activityService, UserRepository userRepository) {
        this.service = service;
        this.activityService = activityService;
        this.userRepository = userRepository;
    }

    @PostMapping("/upload")
    public ResponseEntity<?> uploadPrescription(@RequestParam("file") MultipartFile file,
                                               @RequestParam(value = "userId", required = false) Long userId) {
        if (file == null || file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("message", "No file uploaded."));
        }
        try {
            PrescriptionResponseDto response = service.processPrescription(file);
            
            if (userId != null) {
                User user = userRepository.findById(userId).orElse(null);
                if (user != null) {
                    int medicineCount = response.getMedicines() != null ? response.getMedicines().size() : 0;
                    String activityMessage = String.format("Uploaded prescription - %d medicine%s detected", 
                        medicineCount, medicineCount != 1 ? "s" : "");
                    activityService.logActivity(user, "PRESCRIPTION_UPLOADED", activityMessage);
                }
            }
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.status(500)
                    .body(Map.of("message", "Error processing prescription: " + e.getMessage()));
        }
    }
}
