package com.example.dosebuddy.dto;

import java.time.LocalDateTime;

public class ActivityDto {
    private Long id;
    private String type;
    private String message;
    private String relatedEntityType;
    private Long relatedEntityId;
    private String metadata;
    private LocalDateTime createdAt;

    public ActivityDto() {}

    public ActivityDto(Long id, String type, String message, String relatedEntityType, 
                      Long relatedEntityId, String metadata, LocalDateTime createdAt) {
        this.id = id;
        this.type = type;
        this.message = message;
        this.relatedEntityType = relatedEntityType;
        this.relatedEntityId = relatedEntityId;
        this.metadata = metadata;
        this.createdAt = createdAt;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public String getRelatedEntityType() {
        return relatedEntityType;
    }

    public void setRelatedEntityType(String relatedEntityType) {
        this.relatedEntityType = relatedEntityType;
    }

    public Long getRelatedEntityId() {
        return relatedEntityId;
    }

    public void setRelatedEntityId(Long relatedEntityId) {
        this.relatedEntityId = relatedEntityId;
    }

    public String getMetadata() {
        return metadata;
    }

    public void setMetadata(String metadata) {
        this.metadata = metadata;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
