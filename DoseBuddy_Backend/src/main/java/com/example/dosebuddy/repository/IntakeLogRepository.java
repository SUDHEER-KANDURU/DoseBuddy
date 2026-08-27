package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;

public interface IntakeLogRepository extends JpaRepository<IntakeLog, Long> {

    List<IntakeLog> findByMarkerOrderByDateDescTimeDesc(User marker);

    @EntityGraph(attributePaths = "medication")
    Page<IntakeLog> findByMarkerOrderByDateDescTimeDesc(User marker, Pageable pageable);

    List<IntakeLog> findByMarkerAndDateBetween(User marker, LocalDate start, LocalDate end);

    @EntityGraph(attributePaths = "medication")
    @Query("SELECT l FROM IntakeLog l WHERE l.marker = :marker AND l.date BETWEEN :start AND :end")
    List<IntakeLog> findLogsWithMedication(@Param("marker") User marker,
                                           @Param("start") LocalDate start,
                                           @Param("end") LocalDate end);

    List<IntakeLog> findByMarkerAndDate(User marker, LocalDate date);

    List<IntakeLog> findByMarker(User marker);

    Optional<IntakeLog> findByMarkerAndMedicationAndDateAndTime(
            User marker, Medication medication, LocalDate date, LocalTime time);

    @Transactional
    @Modifying
    @Query("DELETE FROM IntakeLog l WHERE l.medication.id = :medId")
    void deleteByMedicationId(@Param("medId") Long medicationId);

    @Query("SELECT l FROM IntakeLog l WHERE l.status = 'MISSED' " +
           "AND l.emailReminderSent = false " +
           "AND l.date = :today " +
           "AND l.scheduledTime <= :cutoff")
    List<IntakeLog> findMissedDosesNeedingEmailReminder(
            @Param("today") LocalDate today,
            @Param("cutoff") java.time.LocalDateTime cutoff);
}


