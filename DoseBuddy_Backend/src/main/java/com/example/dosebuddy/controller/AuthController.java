package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.LoginRequest;
import com.example.dosebuddy.dto.LoginResponse;
import com.example.dosebuddy.dto.SignupRequest;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/auth")
@CrossOrigin(origins = "*")
public class AuthController {

    private final UserRepository userRepository;

    public AuthController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @PostMapping("/signup")
    public ResponseEntity<?> signup(@RequestBody SignupRequest request) {
        if (request.getEmail() == null || request.getPassword() == null || request.getName() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Name, email and password are required"));
        }

        if (!request.isAcceptedTerms()) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "You must accept the Terms & Conditions to create an account"));
        }

        Optional<User> existing = userRepository.findByEmail(request.getEmail().toLowerCase());
        if (existing.isPresent()) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("message", "Email already in use"));
        }

        String role = request.getRole();
        if (role == null || role.isBlank()) {
            role = "PATIENT";
        }

        String patientEmail = null;
        if ("CAREGIVER".equalsIgnoreCase(role)) {
            patientEmail = request.getPatientEmail();
            if (patientEmail == null || patientEmail.isBlank()) {
                return ResponseEntity.badRequest()
                        .body(Map.of("message", "Patient email is required for caregivers"));
            }
            patientEmail = patientEmail.toLowerCase();
        }

        User user = new User(
                request.getName(),
                request.getEmail().toLowerCase(),
                request.getPassword(),
                role.toUpperCase(),
                patientEmail
        );

        if (request.getPhone() != null && !request.getPhone().isBlank()) {
            user.setPhone(request.getPhone().trim());
        }

        if (request.getDob() != null && !request.getDob().isBlank()) {
            try {
                user.setDob(LocalDate.parse(request.getDob()));
            } catch (DateTimeParseException e) {
                return ResponseEntity.badRequest()
                        .body(Map.of("message", "Invalid date of birth format. Use YYYY-MM-DD"));
            }
        }

        if (request.getGender() != null && !request.getGender().isBlank()) {
            user.setGender(request.getGender().trim());
        }

        if (request.getEmergencyContact() != null && !request.getEmergencyContact().isBlank()) {
            user.setEmergencyContact(request.getEmergencyContact().trim());
        }

        user.setAcceptedTerms(true);
        user.setAcceptedTermsTimestamp(LocalDateTime.now());

        user = userRepository.save(user);

        String dobStr = user.getDob() != null ? user.getDob().toString() : null;
        LoginResponse response = new LoginResponse(
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
        return ResponseEntity.ok(response);
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody LoginRequest request) {
        if (request.getEmail() == null || request.getPassword() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Email and password are required"));
        }

        Optional<User> userOpt = userRepository.findByEmail(request.getEmail().toLowerCase());
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("message", "Invalid email or password"));
        }

        User user = userOpt.get();

        if (!user.getPasswordHash().equals(request.getPassword())) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("message", "Invalid email or password"));
        }

        String dobStr = user.getDob() != null ? user.getDob().toString() : null;
        LoginResponse response = new LoginResponse(
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
        return ResponseEntity.ok(response);
    }
}
