package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.MedicationTime;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface MedicationTimeRepository extends JpaRepository<MedicationTime, Long> {


    @Transactional
    @Modifying
    @Query("DELETE FROM MedicationTime t WHERE t.medication.id = :medId")
    void deleteByMedicationId(@Param("medId") Long medicationId);
}
