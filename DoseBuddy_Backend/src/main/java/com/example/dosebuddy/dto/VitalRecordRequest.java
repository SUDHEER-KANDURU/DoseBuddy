package com.example.dosebuddy.dto;

public class VitalRecordRequest {

    private Long userId;
    private Integer bpSystolic;
    private Integer bpDiastolic;
    private Double bloodSugar;
    private Double weight;
    private Integer heartRate;
    private Double temperature;
    private String notes;

    public VitalRecordRequest() {}

    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }

    public Integer getBpSystolic() { return bpSystolic; }
    public void setBpSystolic(Integer bpSystolic) { this.bpSystolic = bpSystolic; }

    public Integer getBpDiastolic() { return bpDiastolic; }
    public void setBpDiastolic(Integer bpDiastolic) { this.bpDiastolic = bpDiastolic; }

    public Double getBloodSugar() { return bloodSugar; }
    public void setBloodSugar(Double bloodSugar) { this.bloodSugar = bloodSugar; }

    public Double getWeight() { return weight; }
    public void setWeight(Double weight) { this.weight = weight; }

    public Integer getHeartRate() { return heartRate; }
    public void setHeartRate(Integer heartRate) { this.heartRate = heartRate; }

    public Double getTemperature() { return temperature; }
    public void setTemperature(Double temperature) { this.temperature = temperature; }

    public String getNotes() { return notes; }
    public void setNotes(String notes) { this.notes = notes; }
}
