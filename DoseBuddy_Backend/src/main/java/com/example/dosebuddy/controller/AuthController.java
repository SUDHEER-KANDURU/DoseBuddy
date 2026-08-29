package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.*;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.JwtService;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.EmailService;
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
import java.util.Random;

/**
 * Public authentication endpoints — signup (with OTP email verification),
 * login, token refresh, forgot-password, and reset-password.
 * These routes are explicitly permitted in SecurityConfig (no token required).
 */
@RestController
@RequestMapping("/api/auth")
@CrossOrigin(origins = "*")
public class AuthController {

    private final UserRepository  userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService      jwtService;
    private final EmailService    emailService;
    private final Random          random = new Random();

    @Value("${jwt.access-token-expiration}")
    private long accessTokenExpiration;

    public AuthController(UserRepository  userRepository,
                          PasswordEncoder passwordEncoder,
                          JwtService      jwtService,
                          EmailService    emailService) {
        this.userRepository  = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService      = jwtService;
        this.emailService    = emailService;
    }

    // ── Signup (creates account + sends OTP for email verification) ──────────

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

        String email = request.getEmail().toLowerCase();
        Optional<User> existing = userRepository.findByEmail(email);
        if (existing.isPresent()) {
            User existingUser = existing.get();
            // If user exists but hasn't verified email, allow re-signup (resend OTP)
            if (!existingUser.isEmailVerified()) {
                String otp = generateOtp();
                existingUser.setOtp(otp);
                existingUser.setOtpExpiry(LocalDateTime.now().plusMinutes(10));
                existingUser.setName(request.getName());
                existingUser.setPasswordHash(passwordEncoder.encode(request.getPassword()));
                userRepository.save(existingUser);
                emailService.sendSignupOtp(email, request.getName(), otp);
                return ResponseEntity.ok(Map.of(
                        "message", "OTP sent to your email. Please verify to complete signup.",
                        "email", email,
                        "requiresVerification", true
                ));
            }
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
                email,
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
        user.setEmailVerified(false);

        // Generate and set OTP
        String otp = generateOtp();
        user.setOtp(otp);
        user.setOtpExpiry(LocalDateTime.now().plusMinutes(10));

        user = userRepository.save(user);

        // Send OTP email
        emailService.sendSignupOtp(email, request.getName(), otp);

        return ResponseEntity.ok(Map.of(
                "message", "OTP sent to your email. Please verify to complete signup.",
                "email", email,
                "requiresVerification", true
        ));
    }

    // ── Verify Email OTP (completes signup) ─────────────────────────────────

    @PostMapping("/verify-email")
    public ResponseEntity<?> verifyEmail(@RequestBody OtpVerifyRequest request) {
        if (request.getEmail() == null || request.getOtp() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Email and OTP are required"));
        }

        Optional<User> userOpt = userRepository.findByEmail(request.getEmail().toLowerCase());
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "No account found with this email"));
        }

        User user = userOpt.get();

        if (user.isEmailVerified()) {
            return ResponseEntity.ok(Map.of("message", "Email already verified. You can log in."));
        }

        if (user.getOtp() == null || user.getOtpExpiry() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "No OTP was generated. Please sign up again."));
        }

        if (LocalDateTime.now().isAfter(user.getOtpExpiry())) {
            return ResponseEntity.status(HttpStatus.GONE)
                    .body(Map.of("message", "OTP has expired. Please request a new one."));
        }

        if (!user.getOtp().equals(request.getOtp().trim())) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("message", "Invalid OTP. Please try again."));
        }

        // OTP is valid — mark email as verified and clear OTP
        user.setEmailVerified(true);
        user.setOtp(null);
        user.setOtpExpiry(null);
        userRepository.save(user);

        // Return tokens so user is automatically logged in after verification
        return ResponseEntity.ok(buildLoginResponse(user));
    }

    // ── Resend OTP ──────────────────────────────────────────────────────────

    @PostMapping("/resend-otp")
    public ResponseEntity<?> resendOtp(@RequestBody ResendOtpRequest request) {
        if (request.getEmail() == null || request.getEmail().isBlank()) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Email is required"));
        }

        Optional<User> userOpt = userRepository.findByEmail(request.getEmail().toLowerCase());
        if (userOpt.isEmpty()) {
            // Don't reveal whether the email exists
            return ResponseEntity.ok(Map.of("message", "If this email is registered, a new OTP has been sent."));
        }

        User user = userOpt.get();

        if (user.isEmailVerified()) {
            return ResponseEntity.ok(Map.of("message", "Email is already verified. Please log in."));
        }

        String otp = generateOtp();
        user.setOtp(otp);
        user.setOtpExpiry(LocalDateTime.now().plusMinutes(10));
        userRepository.save(user);

        emailService.sendSignupOtp(user.getEmail(), user.getName(), otp);

        return ResponseEntity.ok(Map.of("message", "A new OTP has been sent to your email."));
    }

    // ── Diagnostic Test Email ───────────────────────────────────────────────

    @GetMapping("/test-email")
    public ResponseEntity<?> testEmail(@RequestParam(defaultValue = "") String to) {
        if (to.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Query parameter 'to' is required. Example: /api/auth/test-email?to=your-email@gmail.com"
            ));
        }
        try {
            emailService.sendTestEmail(to);
            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "message", "Test email sent successfully to " + to,
                    "fromEmail", emailService.getFromEmail()
            ));
        } catch (Exception e) {
            String causeMsg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                    "success", false,
                    "message", "Failed to send test email: " + e.getMessage(),
                    "cause", causeMsg != null ? causeMsg : "N/A",
                    "errorType", e.getClass().getName()
            ));
        }
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
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("message", "Invalid email or password"));
        }

        User user = userOpt.get();

        // Check if email is verified
        if (!user.isEmailVerified()) {
            // Resend OTP automatically so user can complete verification
            String otp = generateOtp();
            user.setOtp(otp);
            user.setOtpExpiry(LocalDateTime.now().plusMinutes(10));
            userRepository.save(user);
            emailService.sendSignupOtp(user.getEmail(), user.getName(), otp);

            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of(
                            "message", "Email not verified. A new OTP has been sent to your email.",
                            "email", user.getEmail(),
                            "requiresVerification", true
                    ));
        }

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

    // ── Forgot Password (sends OTP) ─────────────────────────────────────────

    @PostMapping("/forgot-password")
    public ResponseEntity<?> forgotPassword(@RequestBody ForgotPasswordRequest request) {
        if (request.getEmail() == null || request.getEmail().isBlank()) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Email is required"));
        }

        Optional<User> userOpt = userRepository.findByEmail(request.getEmail().toLowerCase());
        // Always return success to prevent email enumeration
        if (userOpt.isEmpty()) {
            return ResponseEntity.ok(Map.of("message", "If this email is registered, an OTP has been sent."));
        }

        User user = userOpt.get();
        String otp = generateOtp();
        user.setOtp(otp);
        user.setOtpExpiry(LocalDateTime.now().plusMinutes(10));
        userRepository.save(user);

        emailService.sendPasswordResetOtp(user.getEmail(), user.getName(), otp);

        return ResponseEntity.ok(Map.of("message", "If this email is registered, an OTP has been sent."));
    }

    // ── Reset Password (verify OTP + set new password) ───────────────────────

    @PostMapping("/reset-password")
    public ResponseEntity<?> resetPassword(@RequestBody ResetPasswordRequest request) {
        if (request.getEmail() == null || request.getOtp() == null || request.getNewPassword() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Email, OTP, and new password are required"));
        }

        if (request.getNewPassword().length() < 8) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "Password must be at least 8 characters"));
        }

        Optional<User> userOpt = userRepository.findByEmail(request.getEmail().toLowerCase());
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("message", "No account found with this email"));
        }

        User user = userOpt.get();

        if (user.getOtp() == null || user.getOtpExpiry() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("message", "No password reset was requested. Please try again."));
        }

        if (LocalDateTime.now().isAfter(user.getOtpExpiry())) {
            return ResponseEntity.status(HttpStatus.GONE)
                    .body(Map.of("message", "OTP has expired. Please request a new one."));
        }

        if (!user.getOtp().equals(request.getOtp().trim())) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("message", "Invalid OTP. Please try again."));
        }

        // OTP valid — update password and clear OTP
        user.setPasswordHash(passwordEncoder.encode(request.getNewPassword()));
        user.setOtp(null);
        user.setOtpExpiry(null);
        userRepository.save(user);

        return ResponseEntity.ok(Map.of("message", "Password reset successfully. You can now log in."));
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

    // ── Helpers ──────────────────────────────────────────────────────────────

    private String generateOtp() {
        int otp = 100000 + random.nextInt(900000); // 6-digit OTP
        return String.valueOf(otp);
    }

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
