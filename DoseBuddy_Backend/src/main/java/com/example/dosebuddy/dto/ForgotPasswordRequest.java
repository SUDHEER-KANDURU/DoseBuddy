package com.example.dosebuddy.dto;

/**
 * Request body for initiating a forgot-password flow (sends OTP to user's email).
 */
public class ForgotPasswordRequest {
    private String email;

    public ForgotPasswordRequest() {}

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
}
