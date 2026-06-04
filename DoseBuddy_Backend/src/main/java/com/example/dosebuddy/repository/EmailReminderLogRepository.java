package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.EmailReminderLog;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

public interface EmailReminderLogRepository extends JpaRepository<EmailReminderLog, Long> {

    // ── Deduplication ────────────────────────────────────────────────────────

    /**
     * True if a SUCCESS record already exists for this medication + time slot.
     * FAILED / RETRY_EXHAUSTED rows do NOT block re-sending (handled separately).
     */
    boolean existsByMedicationIdAndScheduledDateTimeAndStatus(
            Long medicationId, LocalDateTime scheduledDateTime, String status);

    /**
     * Fetch an existing log row for a slot regardless of status.
     * Used to resume a FAILED row for retry rather than inserting a duplicate.
     */
    Optional<EmailReminderLog> findByMedicationIdAndScheduledDateTime(
            Long medicationId, LocalDateTime scheduledDateTime);

    // ── Retry queue ──────────────────────────────────────────────────────────

    /**
     * Rows that failed, have retries remaining, and whose back-off delay has elapsed.
     */
    @Query("""
        SELECT e FROM EmailReminderLog e
        WHERE e.status = 'FAILED'
          AND e.attemptCount < e.maxAttempts
          AND e.nextRetryAt <= :now
        ORDER BY e.nextRetryAt ASC
    """)
    List<EmailReminderLog> findRetryableNow(@Param("now") LocalDateTime now);

    // ── Rate-limiting ────────────────────────────────────────────────────────

    /**
     * Count SUCCESS deliveries to a given address in the last N minutes.
     * Used to enforce a per-address rate limit before sending.
     */
    @Query("""
        SELECT COUNT(e) FROM EmailReminderLog e
        WHERE e.recipientEmail = :email
          AND e.status = 'SUCCESS'
          AND e.sentAt >= :since
    """)
    long countSuccessfulSendsToAddressSince(
            @Param("email") String email,
            @Param("since") LocalDateTime since);

    // ── Analytics ────────────────────────────────────────────────────────────

    List<EmailReminderLog> findByUserIdOrderBySentAtDesc(Long userId);

    long countByUserId(Long userId);

    long countByUserIdAndStatus(Long userId, String status);

    Optional<EmailReminderLog> findTopByUserIdAndStatusOrderBySentAtDesc(Long userId, String status);

    Optional<EmailReminderLog> findTopByStatusOrderBySentAtDesc(String status);

    @Query("""
        SELECT e FROM EmailReminderLog e
        WHERE e.sentAt >= :from
        ORDER BY e.sentAt DESC
    """)
    List<EmailReminderLog> findRecentLogs(@Param("from") LocalDateTime from);

    // ── Cleanup ──────────────────────────────────────────────────────────────

    /**
     * Hard-delete logs older than a given timestamp to keep the table bounded.
     * Called periodically by the scheduler (e.g. daily).
     */
    @Modifying
    @Transactional
    @Query("DELETE FROM EmailReminderLog e WHERE e.createdAt < :cutoff")
    int deleteOlderThan(@Param("cutoff") LocalDateTime cutoff);
}
