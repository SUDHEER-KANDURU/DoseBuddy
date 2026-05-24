package com.example.dosebuddy.dto;

public class AdherenceStatsDto {
    private int totalDoses;
    private int takenDoses;
    private int missedDoses;
    private int pendingDoses;
    private double adherencePercentage;
    
    private int missedToday;
    private int missedThisWeek;
    private int missedThisMonth;
    
    private String mostMissedMedicine;
    private int mostMissedCount;

    public AdherenceStatsDto() {}

    public AdherenceStatsDto(int totalDoses, int takenDoses, int missedDoses, int pendingDoses,
                            double adherencePercentage, int missedToday, int missedThisWeek,
                            int missedThisMonth, String mostMissedMedicine, int mostMissedCount) {
        this.totalDoses = totalDoses;
        this.takenDoses = takenDoses;
        this.missedDoses = missedDoses;
        this.pendingDoses = pendingDoses;
        this.adherencePercentage = adherencePercentage;
        this.missedToday = missedToday;
        this.missedThisWeek = missedThisWeek;
        this.missedThisMonth = missedThisMonth;
        this.mostMissedMedicine = mostMissedMedicine;
        this.mostMissedCount = mostMissedCount;
    }

    public int getTotalDoses() { return totalDoses; }
    public void setTotalDoses(int totalDoses) { this.totalDoses = totalDoses; }

    public int getTakenDoses() { return takenDoses; }
    public void setTakenDoses(int takenDoses) { this.takenDoses = takenDoses; }

    public int getMissedDoses() { return missedDoses; }
    public void setMissedDoses(int missedDoses) { this.missedDoses = missedDoses; }

    public int getPendingDoses() { return pendingDoses; }
    public void setPendingDoses(int pendingDoses) { this.pendingDoses = pendingDoses; }

    public double getAdherencePercentage() { return adherencePercentage; }
    public void setAdherencePercentage(double adherencePercentage) { this.adherencePercentage = adherencePercentage; }

    public int getMissedToday() { return missedToday; }
    public void setMissedToday(int missedToday) { this.missedToday = missedToday; }

    public int getMissedThisWeek() { return missedThisWeek; }
    public void setMissedThisWeek(int missedThisWeek) { this.missedThisWeek = missedThisWeek; }

    public int getMissedThisMonth() { return missedThisMonth; }
    public void setMissedThisMonth(int missedThisMonth) { this.missedThisMonth = missedThisMonth; }

    public String getMostMissedMedicine() { return mostMissedMedicine; }
    public void setMostMissedMedicine(String mostMissedMedicine) { this.mostMissedMedicine = mostMissedMedicine; }

    public int getMostMissedCount() { return mostMissedCount; }
    public void setMostMissedCount(int mostMissedCount) { this.mostMissedCount = mostMissedCount; }
}
