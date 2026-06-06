package com.example.dosebuddy.security;

import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.MalformedJwtException;
import io.jsonwebtoken.security.SignatureException;
import jakarta.validation.ConstraintViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;

import java.util.Map;
import java.util.stream.Collectors;

/**
 * Centralised exception handler — turns all unhandled exceptions into
 * clean JSON responses with appropriate HTTP status codes.
 *
 * Spring Security exceptions (401/403) are handled by JwtAuthEntryPoint and
 * JwtAccessDeniedHandler respectively; this class covers application-level errors.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    // ── 400 Bad Request: Bean Validation failures ──────────────────────────

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(
            MethodArgumentNotValidException ex) {
        String errors = ex.getBindingResult().getFieldErrors().stream()
                .map(e -> e.getField() + ": " + e.getDefaultMessage())
                .collect(Collectors.joining(", "));
        return ResponseEntity.badRequest()
                .body(Map.of("status", 400, "error", "Validation Error", "message", errors));
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<Map<String, Object>> handleConstraint(
            ConstraintViolationException ex) {
        return ResponseEntity.badRequest()
                .body(Map.of("status", 400, "error", "Validation Error",
                             "message", ex.getMessage()));
    }

    // ── 401 Unauthorized: JWT / auth exceptions ────────────────────────────

    @ExceptionHandler({ExpiredJwtException.class})
    public ResponseEntity<Map<String, Object>> handleExpiredJwt(ExpiredJwtException ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("status", 401, "error", "Token Expired",
                             "message", "Your session has expired. Please log in again."));
    }

    @ExceptionHandler({MalformedJwtException.class, SignatureException.class})
    public ResponseEntity<Map<String, Object>> handleInvalidJwt(Exception ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("status", 401, "error", "Invalid Token",
                             "message", "The provided token is invalid."));
    }

    @ExceptionHandler(BadCredentialsException.class)
    public ResponseEntity<Map<String, Object>> handleBadCredentials(BadCredentialsException ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("status", 401, "error", "Unauthorized",
                             "message", "Invalid email or password."));
    }

    @ExceptionHandler(AuthenticationException.class)
    public ResponseEntity<Map<String, Object>> handleAuth(AuthenticationException ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("status", 401, "error", "Unauthorized",
                             "message", ex.getMessage()));
    }

    // ── 403 Forbidden ──────────────────────────────────────────────────────

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<Map<String, Object>> handleForbidden(AccessDeniedException ex) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("status", 403, "error", "Forbidden",
                             "message", "You do not have permission to access this resource."));
    }

    // ── 500 Internal Server Error ──────────────────────────────────────────

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneral(Exception ex, WebRequest request) {
        // Log the real error server-side; return a sanitised message to the client
        System.err.println("[DoseBuddy] Unhandled exception at "
                + request.getDescription(false) + ": " + ex.getMessage());
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("status", 500, "error", "Internal Server Error",
                             "message", "An unexpected error occurred. Please try again."));
    }
}
