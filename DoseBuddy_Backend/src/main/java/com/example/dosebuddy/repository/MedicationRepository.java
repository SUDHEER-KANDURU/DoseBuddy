package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;

public interface MedicationRepository extends JpaRepository<Medication, Long> {

    // ── Standard queries (used by controllers — lazy loading is fine there
    //    because the HTTP request scope keeps an open JPA session via
    //    the regular Spring MVC transaction boundary) ──────────────────────────

    List<Medication> findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(
            User user,
            LocalDate start,
            LocalDate end
    );

    List<Medication> findByStartDateLessThanEqualAndEndDateGreaterThanEqual(
            LocalDate start,
            LocalDate end
    );

    // ── Scheduler-safe queries: JOIN FETCH eagerly loads both the user and the
    //    times collection in a SINGLE SQL query so the caller never needs an
    //    open Hibernate session to access those associations.
    //
    //    Why this is needed:
    //      @Scheduled methods run on a plain thread with no surrounding
    //      transaction or HTTP request.  The repository query opens and
    //      immediately closes its own session, leaving the returned Medication
    //      objects detached.  Any subsequent access to a LAZY association
    //      (med.getTimes(), med.getUser()) on a detached entity throws
    //      LazyInitializationException.
    //
    //    JOIN FETCH forces Hibernate to load the association inside the same
    //    session that ran the query, so the data is already in memory by the
    //    time the repository method returns.
    //
    //    The DISTINCT keyword is required to de-duplicate Medication rows that
    //    would otherwise appear once per matching MedicationTime row in the
    //    result set.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Fetch all active medications today, with their {@code times} and {@code user}
     * eagerly loaded via JOIN FETCH.
     *
     * <p>Use this method in any non-HTTP context (schedulers, background jobs) where
     * there is no surrounding transaction that keeps the Hibernate session open.</p>
     */
    @Query("""
        SELECT DISTINCT m
          FROM Medication m
          JOIN FETCH m.user u
          JOIN FETCH m.times t
         WHERE m.startDate <= :today
           AND m.endDate   >= :today
    """)
    List<Medication> findActiveWithTimesAndUser(@Param("today") LocalDate today);

    /**
     * Fetch a single medication with its {@code times} and {@code user} eagerly loaded.
     *
     * <p>Use in retry-queue processing where only one medication ID is known.</p>
     */
    @Query("""
        SELECT m
          FROM Medication m
          JOIN FETCH m.user u
     LEFT JOIN FETCH m.times t
         WHERE m.id = :id
    """)
    java.util.Optional<Medication> findByIdWithTimesAndUser(@Param("id") Long id);
}
