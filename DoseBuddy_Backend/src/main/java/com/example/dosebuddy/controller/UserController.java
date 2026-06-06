package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.ChangePasswordRequest;
import com.example.dosebuddy.dto.ProfileUpdateRequest;
import com.example.dosebuddy.dto.UserProfileResponse;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.ActivityService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/user")
@CrossOrigin(origins = "*")
public class UserController {

    private final UserRepository  userRepository;
    private final ActivityService activityService;
    private final PasswordEncoder passwordEncoder;

    public UserController(UserRepository  userRepository,
                          ActivityService activityService,
                          PasswordEncoder passwordEncoder) {
        this.userRepository  = userRepository;
        this.activityService = activityService;
        this.passwordEncoder = passwordEncoder;
    }

    @GetMapping("/profile/{userId}")
    public ResponseEntity<?> getProfile(@PathVariable Long userId,
                                        @AuthenticationPrincipal UserPrincipal principal) {
        if (!principal.getUserId().equals(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("message", "Access denied"));
        }
        Optional<User> userOpt = userRepository.findById(userId);
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "User not found"));
        }
        return ResponseEntity.ok(buildProfileResponse(userOpt.get()));
    }

    @PutMapping("/profile/{userId}")
    public ResponseEntity<?> updateProfile(@PathVariable Long userId,
                                           @RequestBody ProfileUpdateRequest request,
                                           @AuthenticationPrincipal UserPrincipal principal) {
        if (!principal.getUserId().equals(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("message", "Access denied"));
        }
        Optional<User> userOpt = userRepository.findById(userId);
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "User not found"));
        }

        User user = userOpt.get();

        if (request.getName() != null && !request.getName().isBlank()) {
            user.setName(request.getName().trim());
        }
        if (request.getPhone() != null) {
            String phone = request.getPhone().trim();
            user.setPhone(phone.isEmpty() ? null : phone);
        }
        if (request.getDob() != null && !request.getDob().isBlank()) {
            try {
                user.setDob(LocalDate.parse(request.getDob()));
            } catch (DateTimeParseException e) {
                return ResponseEntity.badRequest()
                        .body(Map.of("message", "Invalid date format. Use YYYY-MM-DD"));
            }
        }
        if (request.getGender() != null) {
            String gender = request.getGender().trim();
            user.setGender(gender.isEmpty() ? null : gender);
        }
        if (request.getEmergencyContact() != null) {
            String ec = request.getEmergencyContact().trim();
            user.setEmergencyContact(ec.isEmpty() ? null : ec);
        }

        user = userRepository.save(user);
        activityService.logActivity(user, "PROFILE_UPDATED", "Profile information updated", "USER", user.getId());
        return ResponseEntity.ok(buildProfileResponse(user));
    }

    @PostMapping("/change-password/{userId}")
    public ResponseEntity<?> changePassword(@PathVariable Long userId,
                                            @RequestBody ChangePasswordRequest request,
                                            @AuthenticationPrincipal UserPrincipal principal) {
        if (!principal.getUserId().equals(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("message", "Access denied"));
        }
        Optional<User> userOpt = userRepository.findById(userId);
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "User not found"));
        }

        User user = userOpt.get();

        // Verify current password (BCrypt-aware; handles legacy plaintext)
        boolean currentMatches = passwordEncoder.matches(request.getCurrentPassword(), user.getPasswordHash());
        if (!currentMatches) {
            // Legacy plaintext fallback for accounts not yet migrated
            if (!user.getPasswordHash().equals(request.getCurrentPassword())) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                        .body(Map.of("message", "Current password is incorrect"));
            }
        }
        if (request.getNewPassword() == null || request.getNewPassword().length() < 8) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "New password must be at least 8 characters"));
        }

        user.setPasswordHash(passwordEncoder.encode(request.getNewPassword()));
        userRepository.save(user);
        activityService.logActivity(user, "PASSWORD_CHANGED", "Password changed successfully", "USER", user.getId());
        return ResponseEntity.ok(Map.of("message", "Password changed successfully"));
    }

    private UserProfileResponse buildProfileResponse(User user) {
        String dobStr = user.getDob() != null ? user.getDob().toString() : null;
        return new UserProfileResponse(
                user.getId(),
                user.getName(),
                user.getEmail(),
                user.getRole(),
                user.getPatientEmail(),
                user.getPhone(),
                dobStr,
                user.getGender(),
                user.getEmergencyContact(),
                user.isAcceptedTerms()
        );
    }
}
