package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

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

    @EntityGraph(attributePaths = "times")
    @Query("SELECT DISTINCT m FROM Medication m " +
           "WHERE m.user = :user AND m.startDate <= :end AND m.endDate >= :start")
    List<Medication> findScheduledInRange(@Param("user") User user,
                                          @Param("start") LocalDate start,
                                          @Param("end") LocalDate end);

    @Query("SELECT MIN(m.startDate) FROM Medication m WHERE m.user = :user")
    LocalDate findEarliestStartDate(@Param("user") User user);
}
