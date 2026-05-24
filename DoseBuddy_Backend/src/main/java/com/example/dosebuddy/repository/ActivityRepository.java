package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.Activity;
import com.example.dosebuddy.model.User;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface ActivityRepository extends JpaRepository<Activity, Long> {
    
    List<Activity> findByUserOrderByCreatedAtDesc(User user);
    
    List<Activity> findByUserOrderByCreatedAtDesc(User user, Pageable pageable);
    
    List<Activity> findByUserAndTypeOrderByCreatedAtDesc(User user, String type);
    
    List<Activity> findByUserAndCreatedAtAfterOrderByCreatedAtDesc(User user, LocalDateTime after);
    
    long countByUser(User user);
    
    void deleteByUser(User user);
}
