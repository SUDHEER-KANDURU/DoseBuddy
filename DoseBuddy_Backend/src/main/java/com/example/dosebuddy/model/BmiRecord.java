package com.example.dosebuddy.model;

import jakarta.persistence.*;
import java.time.LocalDateTime;

@Entity
@Table(name = "bmi_records")
public class BmiRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private Long userId;

    @Column(nullable = false)
    private Double height;

    @Column(nullable = false)
    private Double weight;

    @Column(nullable = false)
    private Double bmiValue;

    @Column(nullable = false)
    private String bmiCategory;

    @Column(nullable = false)
    private LocalDateTime createdAt;

    public BmiRecord() {
        this.createdAt = LocalDateTime.now();
    }

    public BmiRecord(Long userId, Double height, Double weight, Double bmiValue, String bmiCategory) {
        this.userId = userId;
        this.height = height;
        this.weight = weight;
        this.bmiValue = bmiValue;
        this.bmiCategory = bmiCategory;
        this.createdAt = LocalDateTime.now();
    }

    // Getters and Setters
    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getUserId() {
        return userId;
    }

    public void setUserId(Long userId) {
        this.userId = userId;
    }

    public Double getHeight() {
        return height;
    }

    public void setHeight(Double height) {
        this.height = height;
    }

    public Double getWeight() {
        return weight;
    }

    public void setWeight(Double weight) {
        this.weight = weight;
    }

    public Double getBmiValue() {
        return bmiValue;
    }

    public void setBmiValue(Double bmiValue) {
        this.bmiValue = bmiValue;
    }

    public String getBmiCategory() {
        return bmiCategory;
    }

    public void setBmiCategory(String bmiCategory) {
        this.bmiCategory = bmiCategory;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
