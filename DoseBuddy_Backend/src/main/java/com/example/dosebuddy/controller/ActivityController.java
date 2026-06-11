package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.ActivityDto;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.ActivityService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/activities")
@CrossOrigin("*")
public class ActivityController {

    private final ActivityService activityService;
    private final UserRepository userRepository;

    public ActivityController(ActivityService activityService, UserRepository userRepository) {
        this.activityService = activityService;
        this.userRepository = userRepository;
    }

    @GetMapping("/recent/{userId}")
    public ResponseEntity<?> getRecentActivities(
            @PathVariable Long userId,
            @RequestParam(defaultValue = "10") int limit,
            @AuthenticationPrincipal UserPrincipal principal) {
        
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        List<ActivityDto> activities = activityService.getRecentActivities(user, limit);
        return ResponseEntity.ok(activities);
    }

    @GetMapping("/all/{userId}")
    public ResponseEntity<?> getAllActivities(@PathVariable Long userId,
                                              @AuthenticationPrincipal UserPrincipal principal) {
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        List<ActivityDto> activities = activityService.getAllActivities(user);
        return ResponseEntity.ok(activities);
    }


    @GetMapping("/type/{userId}/{type}")
    public ResponseEntity<?> getActivitiesByType(
            @PathVariable Long userId,
            @PathVariable String type,
            @AuthenticationPrincipal UserPrincipal principal) {
        
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        List<ActivityDto> activities = activityService.getActivitiesByType(user, type);
        return ResponseEntity.ok(activities);
    }


    @GetMapping("/since/{userId}")
    public ResponseEntity<?> getActivitiesSince(
            @PathVariable Long userId,
            @RequestParam String since,
            @AuthenticationPrincipal UserPrincipal principal) {
        
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        try {
            LocalDateTime sinceDate = LocalDateTime.parse(since);
            List<ActivityDto> activities = activityService.getActivitiesSince(user, sinceDate);
            return ResponseEntity.ok(activities);
        } catch (Exception e) {
            return ResponseEntity.badRequest().body("Invalid date format. Use ISO format: yyyy-MM-ddTHH:mm:ss");
        }
    }

    @GetMapping("/count/{userId}")
    public ResponseEntity<?> getActivityCount(@PathVariable Long userId,
                                              @AuthenticationPrincipal UserPrincipal principal) {
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        long count = activityService.getActivityCount(user);
        return ResponseEntity.ok(Map.of("count", count));
    }

    @PostMapping("/log")
    public ResponseEntity<?> logActivity(@RequestBody Map<String, Object> request,
                                         @AuthenticationPrincipal UserPrincipal principal) {
        Object userIdObj = request.get("userId");
        Object typeObj   = request.get("type");
        Object msgObj    = request.get("message");

        if (userIdObj == null || typeObj == null || msgObj == null) {
            return ResponseEntity.badRequest().body("userId, type, and message are required");
        }

        Long userId;
        try {
            userId = Long.valueOf(userIdObj.toString());
        } catch (NumberFormatException e) {
            return ResponseEntity.badRequest().body("Invalid userId");
        }

        String type    = typeObj.toString();
        String message = msgObj.toString();

        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        String relatedEntityType = request.containsKey("relatedEntityType")
            ? request.get("relatedEntityType").toString()
            : null;

        Long relatedEntityId = null;
        if (request.containsKey("relatedEntityId") && request.get("relatedEntityId") != null) {
            try {
                relatedEntityId = Long.valueOf(request.get("relatedEntityId").toString());
            } catch (NumberFormatException ignored) {}
        }

        String metadata = request.containsKey("metadata") && request.get("metadata") != null
            ? request.get("metadata").toString()
            : null;

        if (relatedEntityType != null && relatedEntityId != null && metadata != null) {
            activityService.logActivity(user, type, message, relatedEntityType, relatedEntityId, metadata);
        } else if (relatedEntityType != null && relatedEntityId != null) {
            activityService.logActivity(user, type, message, relatedEntityType, relatedEntityId);
        } else {
            activityService.logActivity(user, type, message);
        }

        return ResponseEntity.ok("Activity logged successfully");
    }

    @DeleteMapping("/clear/{userId}")
    public ResponseEntity<?> clearActivities(@PathVariable Long userId,
                                             @AuthenticationPrincipal UserPrincipal principal) {
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        activityService.deleteAllActivities(user);
        return ResponseEntity.ok("All activities cleared");
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
