package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.VitalRecordDto;
import com.example.dosebuddy.dto.VitalRecordRequest;
import com.example.dosebuddy.service.VitalService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/vitals")
@CrossOrigin(origins = "*")
public class VitalController {

    private final VitalService vitalService;

    public VitalController(VitalService vitalService) {
        this.vitalService = vitalService;
    }

    @PostMapping("/add")
    public ResponseEntity<?> addVital(@RequestBody VitalRecordRequest req) {
        try {
            VitalRecordDto saved = vitalService.saveVital(req);
            return ResponseEntity.ok(saved);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to save vitals"));
        }
    }

    @GetMapping("/latest/{userId}")
    public ResponseEntity<?> getLatest(@PathVariable Long userId) {
        try {
            Optional<VitalRecordDto> latest = vitalService.getLatest(userId);
            if (latest.isPresent()) {
                return ResponseEntity.ok(latest.get());
            }
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "No vitals records found"));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch latest vitals"));
        }
    }

    @GetMapping("/history/{userId}")
    public ResponseEntity<?> getHistory(@PathVariable Long userId) {
        try {
            List<VitalRecordDto> history = vitalService.getHistory(userId);
            return ResponseEntity.ok(history);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch vitals history"));
        }
    }

    @GetMapping("/recent/{userId}")
    public ResponseEntity<?> getRecent(@PathVariable Long userId,
                                       @RequestParam(defaultValue = "10") int limit) {
        try {
            List<VitalRecordDto> recent = vitalService.getRecent(userId, limit);
            return ResponseEntity.ok(recent);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch recent vitals"));
        }
    }

    @GetMapping("/trend/{userId}")
    public ResponseEntity<?> getTrend(@PathVariable Long userId,
                                      @RequestParam(defaultValue = "week") String period) {
        try {
            List<VitalRecordDto> trend = vitalService.getTrend(userId, period);
            return ResponseEntity.ok(trend);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch vitals trend"));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteVital(@PathVariable Long id) {
        try {
            boolean deleted = vitalService.deleteVital(id);
            if (deleted) return ResponseEntity.noContent().build();
            return ResponseEntity.notFound().build();
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to delete vital record"));
        }
    }
}
