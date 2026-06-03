package com.example.dosebuddy.service;

import com.example.dosebuddy.dto.ActivityDto;
import com.example.dosebuddy.model.Activity;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.ActivityRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class ActivityService {

    private final ActivityRepository activityRepository;

    public ActivityService(ActivityRepository activityRepository) {
        this.activityRepository = activityRepository;
    }

    @Transactional
    public Activity logActivity(User user, String type, String message) {
        Activity activity = new Activity(user, type, message);
        return activityRepository.save(activity);
    }

    @Transactional
    public Activity logActivity(User user, String type, String message, 
                               String relatedEntityType, Long relatedEntityId) {
        Activity activity = new Activity(user, type, message, relatedEntityType, relatedEntityId);
        return activityRepository.save(activity);
    }

    @Transactional
    public Activity logActivity(User user, String type, String message, 
                               String relatedEntityType, Long relatedEntityId, String metadata) {
        Activity activity = new Activity(user, type, message, relatedEntityType, relatedEntityId);
        activity.setMetadata(metadata);
        return activityRepository.save(activity);
    }

    public List<ActivityDto> getRecentActivities(User user, int limit) {
        List<Activity> activities = activityRepository.findByUserOrderByCreatedAtDesc(
            user, 
            PageRequest.of(0, limit)
        );
        return activities.stream()
            .map(this::toDto)
            .collect(Collectors.toList());
    }

    public List<ActivityDto> getAllActivities(User user) {
        List<Activity> activities = activityRepository.findByUserOrderByCreatedAtDesc(user);
        return activities.stream()
            .map(this::toDto)
            .collect(Collectors.toList());
    }

    public List<ActivityDto> getActivitiesByType(User user, String type) {
        List<Activity> activities = activityRepository.findByUserAndTypeOrderByCreatedAtDesc(user, type);
        return activities.stream()
            .map(this::toDto)
            .collect(Collectors.toList());
    }

    public List<ActivityDto> getActivitiesSince(User user, LocalDateTime since) {
        List<Activity> activities = activityRepository.findByUserAndCreatedAtAfterOrderByCreatedAtDesc(user, since);
        return activities.stream()
            .map(this::toDto)
            .collect(Collectors.toList());
    }

    public long getActivityCount(User user) {
        return activityRepository.countByUser(user);
    }


    @Transactional
    public void deleteAllActivities(User user) {
        activityRepository.deleteByUser(user);
    }

    private ActivityDto toDto(Activity activity) {
        return new ActivityDto(
            activity.getId(),
            activity.getType(),
            activity.getMessage(),
            activity.getRelatedEntityType(),
            activity.getRelatedEntityId(),
            activity.getMetadata(),
            activity.getCreatedAt()
        );
    }
}
