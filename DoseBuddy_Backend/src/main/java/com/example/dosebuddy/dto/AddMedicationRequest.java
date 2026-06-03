package com.example.dosebuddy.dto;

import java.util.List;

public class AddMedicationRequest {
    private Long userId;
    private String name;
    private String dosage;
    private String instructions;
    private String startDate;
    private String endDate;
    private List<String> times;

    public AddMedicationRequest() {}

    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDosage() { return dosage; }
    public void setDosage(String dosage) { this.dosage = dosage; }

    public String getInstructions() { return instructions; }
    public void setInstructions(String instructions) { this.instructions = instructions; }

    public String getStartDate() { return startDate; }
    public void setStartDate(String startDate) { this.startDate = startDate; }

    public String getEndDate() { return endDate; }
    public void setEndDate(String endDate) { this.endDate = endDate; }

    public List<String> getTimes() { return times; }
    public void setTimes(List<String> times) { this.times = times; }
}
