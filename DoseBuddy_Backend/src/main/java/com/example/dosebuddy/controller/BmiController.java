package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.BmiCalculationRequest;
import com.example.dosebuddy.dto.BmiResponseDto;
import com.example.dosebuddy.service.BmiService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/bmi")
@CrossOrigin(origins = "*")
public class BmiController {

    private final BmiService bmiService;

    public BmiController(BmiService bmiService) {
        this.bmiService = bmiService;
    }

    @PostMapping("/calculate")
    public ResponseEntity<?> calculateBmi(@RequestBody BmiCalculationRequest request) {
        try {
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
    public ResponseEntity<?> getLatestBmi(@PathVariable Long userId) {
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
    public ResponseEntity<?> getBmiHistory(@PathVariable Long userId) {
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
                                                  @RequestParam(defaultValue = "10") int limit) {
        try {
            List<BmiResponseDto> history = bmiService.getRecentBmiHistory(userId, limit);
            return ResponseEntity.ok(history);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch recent BMI history"));
        }
    }
}
