package com.example.dosebuddy.dto;

/**
 * Request body for verifying a 6-digit OTP during signup email verification.
 */
public class OtpVerifyRequest {
    private String email;
    private String otp;

    public OtpVerifyRequest() {}

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getOtp() { return otp; }
    public void setOtp(String otp) { this.otp = otp; }
}
