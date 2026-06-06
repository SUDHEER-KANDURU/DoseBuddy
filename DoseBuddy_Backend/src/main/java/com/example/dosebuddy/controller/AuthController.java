package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.LoginRequest;
import com.example.dosebuddy.dto.LoginResponse;
import com.example.dosebuddy.dto.RefreshTokenRequest;
import com.example.dosebuddy.dto.SignupRequest;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.JwtService;
import com.example.dosebuddy.security.UserPrincipal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.Optional;

/**
 * Public authentication endpoints — login, signup, and token refresh.
 * These routes are explicitly permitted in SecurityConfig (no token required).
 */
@RestController
@RequestMapping("/api/auth")
@CrossOrigin(origins = "*")
public class AuthController {

    private final UserRepository  userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService      jwtService;

    @Value("${jwt.access-token-expiration}")
    private long accessTokenExpiration;

    public AuthController(UserRepository  userRepository,
                          PasswordEncoder passwordEncoder,
                          JwtService      jwtService) {
        this.userRepository  = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService      = jwtService;
    }

    // ── Signup ──────────────────────────────────────────────────────────────

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

        if (request.getPassword().length() < 8) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Password must be at least 8 characters"));
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

        // Hash password with BCrypt
        String hashedPassword = passwordEncoder.encode(request.getPassword());

        User user = new User(
                request.getName(),
                request.getEmail().toLowerCase(),
                hashedPassword,
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

        return ResponseEntity.ok(buildLoginResponse(user));
    }

    // ── Login ───────────────────────────────────────────────────────────────

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody LoginRequest request) {
        if (request.getEmail() == null || request.getPassword() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Email and password are required"));
        }

        Optional<User> userOpt = userRepository.findByEmail(request.getEmail().toLowerCase());
        if (userOpt.isEmpty()) {
            // Generic message — do not reveal whether the email exists
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("message", "Invalid email or password"));
        }

        User user = userOpt.get();

        // Verify BCrypt hash; fall back to plaintext for legacy accounts (migration path)
        boolean passwordMatches = passwordEncoder.matches(request.getPassword(), user.getPasswordHash());

        if (!passwordMatches) {
            // Legacy plaintext check — migrates the account on first successful login
            if (user.getPasswordHash().equals(request.getPassword())) {
                // Upgrade to BCrypt immediately
                user.setPasswordHash(passwordEncoder.encode(request.getPassword()));
                userRepository.save(user);
            } else {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                        .body(Map.of("message", "Invalid email or password"));
            }
        }

        return ResponseEntity.ok(buildLoginResponse(user));
    }

    // ── Refresh Token ────────────────────────────────────────────────────────

    @PostMapping("/refresh")
    public ResponseEntity<?> refreshToken(@RequestBody RefreshTokenRequest request) {
        final String refreshToken = request.getRefreshToken();
        if (refreshToken == null || refreshToken.isBlank()) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Refresh token is required"));
        }

        try {
            if (!jwtService.isRefreshToken(refreshToken)) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                        .body(Map.of("message", "Invalid token type"));
            }

            String email = jwtService.extractEmail(refreshToken);
            Optional<User> userOpt = userRepository.findByEmail(email);
            if (userOpt.isEmpty()) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                        .body(Map.of("message", "User not found"));
            }

            User user = userOpt.get();
            UserPrincipal principal = new UserPrincipal(user);

            if (!jwtService.isTokenValid(refreshToken, principal)) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                        .body(Map.of("message", "Refresh token expired. Please log in again."));
            }

            String newAccessToken  = jwtService.generateAccessToken(principal);
            String newRefreshToken = jwtService.generateRefreshToken(principal);

            return ResponseEntity.ok(Map.of(
                    "accessToken",  newAccessToken,
                    "refreshToken", newRefreshToken,
                    "expiresIn",    accessTokenExpiration / 1000
            ));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("message", "Invalid or expired refresh token"));
        }
    }

    // ── Helper ───────────────────────────────────────────────────────────────

    private LoginResponse buildLoginResponse(User user) {
        UserPrincipal principal = new UserPrincipal(user);
        String accessToken  = jwtService.generateAccessToken(principal);
        String refreshToken = jwtService.generateRefreshToken(principal);

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
        response.setAccessToken(accessToken);
        response.setRefreshToken(refreshToken);
        response.setExpiresIn(accessTokenExpiration / 1000);
        return response;
    }
}
