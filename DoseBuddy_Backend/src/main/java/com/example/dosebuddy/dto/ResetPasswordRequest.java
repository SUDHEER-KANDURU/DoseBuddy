package com.example.dosebuddy.dto;

/**
 * Request body for resetting the password after OTP verification.
 */
public class ResetPasswordRequest {
    private String email;
    private String otp;
    private String newPassword;

    public ResetPasswordRequest() {}

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getOtp() { return otp; }
    public void setOtp(String otp) { this.otp = otp; }

    public String getNewPassword() { return newPassword; }
    public void setNewPassword(String newPassword) { this.newPassword = newPassword; }
}
