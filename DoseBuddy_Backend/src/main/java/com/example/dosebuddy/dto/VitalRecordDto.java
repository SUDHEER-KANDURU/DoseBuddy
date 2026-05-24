package com.example.dosebuddy.dto;

import java.time.LocalDateTime;

public class VitalRecordDto {

    private Long id;
    private Long userId;
    private Integer bpSystolic;
    private Integer bpDiastolic;
    private Double bloodSugar;
    private Double weight;
    private Integer heartRate;
    private Double temperature;
    private String notes;
    private LocalDateTime recordedAt;

    private String bpStatus;
    private String sugarStatus;
    private String heartRateStatus;
    private String tempStatus;

    public VitalRecordDto() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

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

    public LocalDateTime getRecordedAt() { return recordedAt; }
    public void setRecordedAt(LocalDateTime recordedAt) { this.recordedAt = recordedAt; }

    public String getBpStatus() { return bpStatus; }
    public void setBpStatus(String bpStatus) { this.bpStatus = bpStatus; }

    public String getSugarStatus() { return sugarStatus; }
    public void setSugarStatus(String sugarStatus) { this.sugarStatus = sugarStatus; }

    public String getHeartRateStatus() { return heartRateStatus; }
    public void setHeartRateStatus(String heartRateStatus) { this.heartRateStatus = heartRateStatus; }

    public String getTempStatus() { return tempStatus; }
    public void setTempStatus(String tempStatus) { this.tempStatus = tempStatus; }
}
