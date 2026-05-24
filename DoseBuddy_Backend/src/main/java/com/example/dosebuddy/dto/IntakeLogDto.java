package com.example.dosebuddy.dto;

public class IntakeLogDto {

    private Long id;
    private String date;
    private String time;
    private Long medId;
    private String medicineName;
    private String dosage;
    private String status;

    public IntakeLogDto() {}

    public IntakeLogDto(Long id, String date, String time,
                        Long medId, String medicineName,
                        String dosage, String status) {
        this.id = id;
        this.date = date;
        this.time = time;
        this.medId = medId;
        this.medicineName = medicineName;
        this.dosage = dosage;
        this.status = status;
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getDate() { return date; }
    public void setDate(String date) { this.date = date; }

    public String getTime() { return time; }
    public void setTime(String time) { this.time = time; }

    public Long getMedId() { return medId; }
    public void setMedId(Long medId) { this.medId = medId; }

    public String getMedicineName() { return medicineName; }
    public void setMedicineName(String medicineName) { this.medicineName = medicineName; }

    public String getDosage() { return dosage; }
    public void setDosage(String dosage) { this.dosage = dosage; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
}

