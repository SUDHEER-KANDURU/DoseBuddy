package com.example.dosebuddy.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;

@Entity
@Table(name = "intake_logs")
public class IntakeLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    // who marked it (patient or caregiver)
    @ManyToOne
    @JoinColumn(name = "marker_user_id")
    @JsonIgnore
    private User marker;

    // which medicine
    @ManyToOne
    @JoinColumn(name = "medication_id")
    @JsonIgnore
    private Medication medication;

    private LocalDate date;
    private LocalTime time;

    private String status;

    @Column(name = "scheduled_time")
    private LocalDateTime scheduledTime;

    @Column(name = "taken_time")
    private LocalDateTime takenTime;

    @Column(name = "missed_time")
    private LocalDateTime missedTime;

    @Column(name = "created_at", updatable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at")
    private LocalDateTime updatedAt;

    @PrePersist
    protected void onCreate() {
        createdAt = LocalDateTime.now();
        updatedAt = LocalDateTime.now();
        

        if (scheduledTime == null && date != null && time != null) {
            scheduledTime = LocalDateTime.of(date, time);
        }
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = LocalDateTime.now();
    }

    public IntakeLog() {}


    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public User getMarker() { return marker; }
    public void setMarker(User marker) { this.marker = marker; }

    public Medication getMedication() { return medication; }
    public void setMedication(Medication medication) { this.medication = medication; }

    public LocalDate getDate() { return date; }
    public void setDate(LocalDate date) { this.date = date; }

    public LocalTime getTime() { return time; }
    public void setTime(LocalTime time) { this.time = time; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public LocalDateTime getScheduledTime() { return scheduledTime; }
    public void setScheduledTime(LocalDateTime scheduledTime) { this.scheduledTime = scheduledTime; }

    public LocalDateTime getTakenTime() { return takenTime; }
    public void setTakenTime(LocalDateTime takenTime) { this.takenTime = takenTime; }

    public LocalDateTime getMissedTime() { return missedTime; }
    public void setMissedTime(LocalDateTime missedTime) { this.missedTime = missedTime; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}

