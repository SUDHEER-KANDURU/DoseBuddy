package com.example.dosebuddy.security;

import io.jsonwebtoken.*;
import io.jsonwebtoken.io.Decoders;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * Handles JWT access-token and refresh-token generation and validation.
 */
@Service
public class JwtService {

    @Value("${jwt.secret}")
    private String secretKey;

    @Value("${jwt.access-token-expiration}")
    private long accessTokenExpiration;   // ms  (default 15 min)

    @Value("${jwt.refresh-token-expiration}")
    private long refreshTokenExpiration;  // ms  (default 7 days)

    // ── Token generation ────────────────────────────────────────────────────

    public String generateAccessToken(UserDetails userDetails) {
        Map<String, Object> claims = new HashMap<>();
        // Store email as subject; add userId claim if the userDetails is our wrapper
        if (userDetails instanceof UserPrincipal up) {
            claims.put("userId", up.getUserId());
            claims.put("role",   up.getRole());
            claims.put("type",   "access");
        }
        return buildToken(claims, userDetails.getUsername(), accessTokenExpiration);
    }

    public String generateRefreshToken(UserDetails userDetails) {
        Map<String, Object> claims = new HashMap<>();
        if (userDetails instanceof UserPrincipal up) {
            claims.put("userId", up.getUserId());
            claims.put("type",   "refresh");
        }
        return buildToken(claims, userDetails.getUsername(), refreshTokenExpiration);
    }

    private String buildToken(Map<String, Object> extraClaims, String subject, long expiration) {
        return Jwts.builder()
                .claims(extraClaims)
                .subject(subject)
                .issuedAt(new Date(System.currentTimeMillis()))
                .expiration(new Date(System.currentTimeMillis() + expiration))
                .signWith(getSigningKey())
                .compact();
    }

    // ── Token validation ────────────────────────────────────────────────────

    public boolean isTokenValid(String token, UserDetails userDetails) {
        final String email = extractEmail(token);
        return email.equals(userDetails.getUsername()) && !isTokenExpired(token);
    }

    public boolean isRefreshToken(String token) {
        try {
            String type = extractClaim(token, claims -> claims.get("type", String.class));
            return "refresh".equals(type);
        } catch (Exception e) {
            return false;
        }
    }

    // ── Claims extraction ───────────────────────────────────────────────────

    public String extractEmail(String token) {
        return extractClaim(token, Claims::getSubject);
    }

    public Long extractUserId(String token) {
        return extractClaim(token, claims -> {
            Object id = claims.get("userId");
            if (id instanceof Integer i) return i.longValue();
            if (id instanceof Long l)    return l;
            return null;
        });
    }

    public String extractRole(String token) {
        return extractClaim(token, claims -> claims.get("role", String.class));
    }

    public <T> T extractClaim(String token, Function<Claims, T> claimsResolver) {
        final Claims claims = extractAllClaims(token);
        return claimsResolver.apply(claims);
    }

    private boolean isTokenExpired(String token) {
        return extractClaim(token, Claims::getExpiration).before(new Date());
    }

    private Claims extractAllClaims(String token) {
        return Jwts.parser()
                .verifyWith(getSigningKey())
                .build()
                .parseSignedClaims(token)
                .getPayload();
    }

    private SecretKey getSigningKey() {
        // If the configured key is already Base64, decode it; otherwise use raw UTF-8 bytes.
        try {
            byte[] keyBytes = Decoders.BASE64.decode(secretKey);
            return Keys.hmacShaKeyFor(keyBytes);
        } catch (Exception e) {
            // Fallback: treat secret as raw UTF-8 string (must be ≥32 chars for HS256)
            return Keys.hmacShaKeyFor(secretKey.getBytes());
        }
    }
}
