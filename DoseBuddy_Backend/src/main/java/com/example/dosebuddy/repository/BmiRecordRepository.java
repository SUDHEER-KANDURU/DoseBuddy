package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.BmiRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface BmiRecordRepository extends JpaRepository<BmiRecord, Long> {

    List<BmiRecord> findByUserIdOrderByCreatedAtDesc(Long userId);

    @Query("SELECT b FROM BmiRecord b WHERE b.userId = ?1 ORDER BY b.createdAt DESC LIMIT 1")
    Optional<BmiRecord> findLatestByUserId(Long userId);
}
