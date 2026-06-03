package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.VitalRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Repository
public interface VitalRecordRepository extends JpaRepository<VitalRecord, Long> {

    List<VitalRecord> findByUserIdOrderByRecordedAtDesc(Long userId);

    @Query("SELECT v FROM VitalRecord v WHERE v.userId = ?1 ORDER BY v.recordedAt DESC LIMIT 1")
    Optional<VitalRecord> findLatestByUserId(Long userId);

    @Query("SELECT v FROM VitalRecord v WHERE v.userId = ?1 AND v.recordedAt >= ?2 ORDER BY v.recordedAt ASC")
    List<VitalRecord> findByUserIdAndRecordedAtAfterOrderByRecordedAtAsc(Long userId, LocalDateTime since);
}
