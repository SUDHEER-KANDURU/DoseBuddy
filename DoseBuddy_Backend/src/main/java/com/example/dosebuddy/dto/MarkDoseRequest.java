package com.example.dosebuddy.dto;

public class MarkDoseRequest {
    private Long userId;
    private Long medicationId;
    private String date;
    private String time;
    private String status;

    public MarkDoseRequest() {}

    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }

    public Long getMedicationId() { return medicationId; }
    public void setMedicationId(Long medicationId) { this.medicationId = medicationId; }

    public String getDate() { return date; }
    public void setDate(String date) { this.date = date; }

    public String getTime() { return time; }
    public void setTime(String time) { this.time = time; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
}
