package com.example.dosebuddy.dto;

import java.util.List;

public class PrescriptionResultDto {

    private String medicineName;
    private String dosage;
    private String instructions;
    private List<String> times;
    private String rawText;

    public PrescriptionResultDto() {}

    public String getMedicineName() { return medicineName; }
    public void setMedicineName(String medicineName) { this.medicineName = medicineName; }

    public String getDosage() { return dosage; }
    public void setDosage(String dosage) { this.dosage = dosage; }

    public String getInstructions() { return instructions; }
    public void setInstructions(String instructions) { this.instructions = instructions; }

    public List<String> getTimes() { return times; }
    public void setTimes(List<String> times) { this.times = times; }

    public String getRawText() { return rawText; }
    public void setRawText(String rawText) { this.rawText = rawText; }
}
