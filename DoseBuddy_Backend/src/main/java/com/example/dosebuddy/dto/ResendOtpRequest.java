package com.example.dosebuddy.dto;

/**
 * Request body for resending an OTP to a user's email.
 */
public class ResendOtpRequest {
    private String email;

    public ResendOtpRequest() {}

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
}
