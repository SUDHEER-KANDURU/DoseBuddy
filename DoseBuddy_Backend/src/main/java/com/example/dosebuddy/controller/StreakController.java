package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.StreakDto;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.StreakService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/streaks")
@CrossOrigin("*")
public class StreakController {

    private final StreakService streakService;
    private final UserRepository userRepository;

    public StreakController(StreakService streakService, UserRepository userRepository) {
        this.streakService = streakService;
        this.userRepository = userRepository;
    }


    @GetMapping("/{userId}")
    public ResponseEntity<?> getStreak(@PathVariable Long userId,
                                       @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
        StreakDto dto = streakService.getStreak(userId);
        return ResponseEntity.ok(dto);
    }

    @PostMapping("/recalculate/{userId}")
    public ResponseEntity<?> recalculate(@PathVariable Long userId,
                                         @AuthenticationPrincipal UserPrincipal principal) {
        ResponseEntity<?> denied = denyIfNoAccess(userId, principal);
        if (denied != null) return denied;
        StreakDto dto = streakService.recalculate(userId);
        return ResponseEntity.ok(dto);
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
