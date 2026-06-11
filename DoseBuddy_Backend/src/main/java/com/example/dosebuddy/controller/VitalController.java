package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.VitalRecordDto;
import com.example.dosebuddy.dto.VitalRecordRequest;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.VitalService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/vitals")
@CrossOrigin(origins = "*")
public class VitalController {

    private final VitalService vitalService;
    private final UserRepository userRepository;

    public VitalController(VitalService vitalService, UserRepository userRepository) {
        this.vitalService = vitalService;
        this.userRepository = userRepository;
    }

    @PostMapping("/add")
    public ResponseEntity<?> addVital(@RequestBody VitalRecordRequest req,
                                      @AuthenticationPrincipal UserPrincipal principal) {
        try {
            req.setUserId(principal.getUserId());
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
    public ResponseEntity<?> getLatest(@PathVariable Long userId,
                                       @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
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
    public ResponseEntity<?> getHistory(@PathVariable Long userId,
                                        @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
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
                                       @RequestParam(defaultValue = "10") int limit,
                                       @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
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
                                      @RequestParam(defaultValue = "week") String period,
                                      @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
        try {
            List<VitalRecordDto> trend = vitalService.getTrend(userId, period);
            return ResponseEntity.ok(trend);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to fetch vitals trend"));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteVital(@PathVariable Long id,
                                         @AuthenticationPrincipal UserPrincipal principal) {
        try {
            boolean deleted = vitalService.deleteVital(id, principal.getUserId());
            if (deleted) return ResponseEntity.noContent().build();
            return ResponseEntity.notFound().build();
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("message", "Failed to delete vital record"));
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
