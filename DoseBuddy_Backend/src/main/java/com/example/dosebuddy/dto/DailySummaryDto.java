package com.example.dosebuddy.dto;

public class DailySummaryDto {
    private String date;
    private int takenCount;
    private int missedCount;

    public DailySummaryDto() {}

    public DailySummaryDto(String date, int takenCount, int missedCount) {
        this.date = date;
        this.takenCount = takenCount;
        this.missedCount = missedCount;
    }

    public String getDate() { return date; }
    public void setDate(String date) { this.date = date; }

    public int getTakenCount() { return takenCount; }
    public void setTakenCount(int takenCount) { this.takenCount = takenCount; }

    public int getMissedCount() { return missedCount; }
    public void setMissedCount(int missedCount) { this.missedCount = missedCount; }
}
