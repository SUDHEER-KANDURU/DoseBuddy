package com.example.dosebuddy.dto;

public class BmiCalculationRequest {
    private Long userId;
    private Double height;
    private Double weight;

    public BmiCalculationRequest() {}

    public BmiCalculationRequest(Long userId, Double height, Double weight) {
        this.userId = userId;
        this.height = height;
        this.weight = weight;
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
}
