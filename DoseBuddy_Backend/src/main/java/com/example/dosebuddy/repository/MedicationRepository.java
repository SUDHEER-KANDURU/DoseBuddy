package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.LocalDate;
import java.util.List;

public interface MedicationRepository extends JpaRepository<Medication, Long> {

    List<Medication> findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(
            User user,
            LocalDate start,
            LocalDate end
    );

    List<Medication> findByStartDateLessThanEqualAndEndDateGreaterThanEqual(
            LocalDate start,
            LocalDate end
    );
}
