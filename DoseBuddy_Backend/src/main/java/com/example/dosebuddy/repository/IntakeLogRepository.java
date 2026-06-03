package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;

public interface IntakeLogRepository extends JpaRepository<IntakeLog, Long> {

    List<IntakeLog> findByMarkerOrderByDateDescTimeDesc(User marker);

    List<IntakeLog> findByMarkerAndDateBetween(User marker, LocalDate start, LocalDate end);

    List<IntakeLog> findByMarkerAndDate(User marker, LocalDate date);

    List<IntakeLog> findByMarker(User marker);

    Optional<IntakeLog> findByMarkerAndMedicationAndDateAndTime(
            User marker, Medication medication, LocalDate date, LocalTime time);

    @Transactional
    @Modifying
    @Query("DELETE FROM IntakeLog l WHERE l.medication.id = :medId")
    void deleteByMedicationId(@Param("medId") Long medicationId);
}


