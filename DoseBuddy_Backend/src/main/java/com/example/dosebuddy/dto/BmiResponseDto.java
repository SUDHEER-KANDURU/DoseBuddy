package com.example.dosebuddy.dto;

import java.time.LocalDateTime;
import java.util.List;

public class BmiResponseDto {
    private Long id;
    private Double height;
    private Double weight;
    private Double bmiValue;
    private String bmiCategory;
    private String healthStatus;
    private String statusColor;
    private List<String> healthSuggestions;
    private List<String> dietRecommendations;
    private LocalDateTime createdAt;

    public BmiResponseDto() {}

    public BmiResponseDto(Long id, Double height, Double weight, Double bmiValue, 
                         String bmiCategory, String healthStatus, String statusColor,
                         List<String> healthSuggestions, List<String> dietRecommendations,
                         LocalDateTime createdAt) {
        this.id = id;
        this.height = height;
        this.weight = weight;
        this.bmiValue = bmiValue;
        this.bmiCategory = bmiCategory;
        this.healthStatus = healthStatus;
        this.statusColor = statusColor;
        this.healthSuggestions = healthSuggestions;
        this.dietRecommendations = dietRecommendations;
        this.createdAt = createdAt;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
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

    public String getHealthStatus() {
        return healthStatus;
    }

    public void setHealthStatus(String healthStatus) {
        this.healthStatus = healthStatus;
    }

    public String getStatusColor() {
        return statusColor;
    }

    public void setStatusColor(String statusColor) {
        this.statusColor = statusColor;
    }

    public List<String> getHealthSuggestions() {
        return healthSuggestions;
    }

    public void setHealthSuggestions(List<String> healthSuggestions) {
        this.healthSuggestions = healthSuggestions;
    }

    public List<String> getDietRecommendations() {
        return dietRecommendations;
    }

    public void setDietRecommendations(List<String> dietRecommendations) {
        this.dietRecommendations = dietRecommendations;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
