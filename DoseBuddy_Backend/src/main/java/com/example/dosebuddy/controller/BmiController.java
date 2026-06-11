package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.BmiCalculationRequest;
import com.example.dosebuddy.dto.BmiResponseDto;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.BmiService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/bmi")
@CrossOrigin(origins = "*")
public class BmiController {

    private final BmiService bmiService;
    private final UserRepository userRepository;

    public BmiController(BmiService bmiService, UserRepository userRepository) {
        this.bmiService = bmiService;
        this.userRepository = userRepository;
    }

    @PostMapping("/calculate")
    public ResponseEntity<?> calculateBmi(@RequestBody BmiCalculationRequest request,
                                          @AuthenticationPrincipal UserPrincipal principal) {
        try {
            request.setUserId(principal.getUserId());
            BmiResponseDto response = bmiService.calculateAndSaveBmi(request);
            return ResponseEntity.ok(response);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to calculate BMI"));
        }
    }

    @GetMapping("/latest/{userId}")
    public ResponseEntity<?> getLatestBmi(@PathVariable Long userId,
                                          @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
        try {
            Optional<BmiResponseDto> bmi = bmiService.getLatestBmi(userId);
            if (bmi.isPresent()) {
                return ResponseEntity.ok(bmi.get());
            } else {
                return ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("message", "No BMI records found"));
            }
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch BMI data"));
        }
    }

    @GetMapping("/history/{userId}")
    public ResponseEntity<?> getBmiHistory(@PathVariable Long userId,
                                           @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
        try {
            List<BmiResponseDto> history = bmiService.getBmiHistory(userId);
            return ResponseEntity.ok(history);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch BMI history"));
        }
    }

    @GetMapping("/recent/{userId}")
    public ResponseEntity<?> getRecentBmiHistory(@PathVariable Long userId, 
                                                  @RequestParam(defaultValue = "10") int limit,
                                                  @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
        try {
            List<BmiResponseDto> history = bmiService.getRecentBmiHistory(userId, limit);
            return ResponseEntity.ok(history);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch recent BMI history"));
        }
    }

    private ResponseEntity<?> denyIfNoAccess(Long userId, UserPrincipal principal) {
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "User not found"));
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("message", "Access denied"));
        }
        return null;
    }

    private boolean canAccessUser(User target, UserPrincipal principal) {
        if (target == null || principal == null) return false;
        if (target.getId().equals(principal.getUserId())) return true;
        User authUser = principal.getUser();
        return "CAREGIVER".equalsIgnoreCase(authUser.getRole())
                && authUser.getPatientEmail() != null
                && authUser.getPatientEmail().equalsIgnoreCase(target.getEmail());
    }
}
