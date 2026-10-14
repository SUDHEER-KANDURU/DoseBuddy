-- DoseBuddy Notification System Database Migrations (MySQL 8)
-- Additive and idempotent. Do not run this file until its documented staging
-- preflight has passed; this repository never executes it automatically.

-- Base notification tables for fresh installations.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    endpoint TEXT NOT NULL,
    subscription_data TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_active (user_id, active),
    INDEX idx_endpoint (endpoint(255))
);

CREATE TABLE IF NOT EXISTS dose_occurrences (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    medication_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    schedule_version BIGINT NOT NULL,
    local_date DATE NOT NULL,
    local_time TIME NOT NULL,
    scheduled_at_utc DATETIME(3) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    taken_at DATETIME(3) NULL,
    missed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_dose_occurrence_schedule (medication_id, schedule_version, local_date, local_time),
    INDEX idx_dose_occurrence_state_time (state, scheduled_at_utc),
    CONSTRAINT fk_occurrence_medication FOREIGN KEY (medication_id) REFERENCES medications(id) ON DELETE CASCADE,
    CONSTRAINT fk_occurrence_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_delivery_attempts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(191) NOT NULL,
    occurrence_id BIGINT NULL,
    medication_id BIGINT NULL,
    schedule_version BIGINT NOT NULL DEFAULT 0,
    user_id BIGINT NOT NULL,
    subscription_id INT NOT NULL,
    event_type VARCHAR(16) NOT NULL DEFAULT 'REMINDER',
    event_created_at DATETIME(3) NULL,
    scheduled_at DATETIME(3) NULL,
    attempted_at DATETIME(3) NOT NULL,
    provider_status SMALLINT NULL,
    outcome VARCHAR(32) NOT NULL,
    processing_lag_ms INT NOT NULL DEFAULT 0,
    delivery_latency_ms INT NOT NULL DEFAULT 0,
    retry_count INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NULL,
    error_category VARCHAR(100) NULL,
    claim_token VARCHAR(64) NULL,
    claim_version BIGINT NOT NULL DEFAULT 0,
    lease_expires_at DATETIME(3) NULL,
    dispatch_started_at DATETIME(3) NULL,
    uncertain_at DATETIME(3) NULL,
    UNIQUE KEY uq_delivery_event_subscription (event_id, subscription_id),
    INDEX idx_push_attempt_event (event_id),
    INDEX idx_push_attempt_user_time (user_id, attempted_at),
    INDEX idx_push_attempt_recovery (outcome, lease_expires_at),
    CONSTRAINT fk_delivery_occurrence FOREIGN KEY (occurrence_id) REFERENCES dose_occurrences(id) ON DELETE CASCADE,
    CONSTRAINT fk_delivery_medication FOREIGN KEY (medication_id) REFERENCES medications(id) ON DELETE CASCADE,
    CONSTRAINT fk_delivery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_delivery_subscription FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
);

-- Existing installations: add user zone and medication revision fields first.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='time_zone')=0,
  'ALTER TABLE users ADD COLUMN time_zone VARCHAR(64) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='medications' AND column_name='active')=0,
  'ALTER TABLE medications ADD COLUMN active BOOLEAN NOT NULL DEFAULT 1', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='medications' AND column_name='schedule_version')=0,
  'ALTER TABLE medications ADD COLUMN schedule_version BIGINT NOT NULL DEFAULT 1', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dose_occurrences' AND column_name='taken_at')=0,
  'ALTER TABLE dose_occurrences ADD COLUMN taken_at DATETIME(3) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dose_occurrences' AND column_name='missed_at')=0,
  'ALTER TABLE dose_occurrences ADD COLUMN missed_at DATETIME(3) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Link new intake history rows to stable dose occurrences. Existing legacy
-- history remains intact because the additive column is nullable.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='intake_logs' AND column_name='occurrence_id')=0,
  'ALTER TABLE intake_logs ADD COLUMN occurrence_id BIGINT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add the complete delivery ledger shape to legacy tables. Nullable foreign-key
-- references preserve historical rows that cannot be safely reconstructed.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='occurrence_id')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN occurrence_id BIGINT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='medication_id')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN medication_id BIGINT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='schedule_version')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN schedule_version BIGINT NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='event_type')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN event_type VARCHAR(16) NOT NULL DEFAULT ''REMINDER''', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='next_attempt_at')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN next_attempt_at DATETIME(3) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='claim_token')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN claim_token VARCHAR(64) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='claim_version')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN claim_version BIGINT NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='lease_expires_at')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN lease_expires_at DATETIME(3) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='dispatch_started_at')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN dispatch_started_at DATETIME(3) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='uncertain_at')=0,
  'ALTER TABLE push_delivery_attempts ADD COLUMN uncertain_at DATETIME(3) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Normalize columns in tables created by earlier standalone notification SQL.
-- The application schema uses signed BIGINT primary keys for users/medications.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_subscriptions' AND column_name='user_id' AND column_type='bigint')=0,
  'ALTER TABLE push_subscriptions MODIFY COLUMN user_id BIGINT NOT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dose_occurrences' AND column_name='medication_id' AND column_type='bigint')=0,
  'ALTER TABLE dose_occurrences MODIFY COLUMN medication_id BIGINT NOT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dose_occurrences' AND column_name='user_id' AND column_type='bigint')=0,
  'ALTER TABLE dose_occurrences MODIFY COLUMN user_id BIGINT NOT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='medication_id' AND column_type='bigint')=0,
  'ALTER TABLE push_delivery_attempts MODIFY COLUMN medication_id BIGINT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='user_id' AND column_type='bigint')=0,
  'ALTER TABLE push_delivery_attempts MODIFY COLUMN user_id BIGINT NOT NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Preserve all legacy history while making duplicate old ledger keys unique.
UPDATE push_delivery_attempts
SET event_id = CONCAT(LEFT(event_id, 170), ':legacy:', id)
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY event_id, subscription_id ORDER BY id) AS duplicate_rank
    FROM push_delivery_attempts
  ) AS ranked_legacy_events
  WHERE duplicate_rank > 1
);

-- Idempotent indexes and integrity constraints. The foreign keys intentionally
-- fail rather than deleting orphaned user data; complete the documented preflight
-- and repair any reported orphan records before an authorized migration run.
-- MySQL 8 does not support `CREATE INDEX IF NOT EXISTS`; guard each index via
-- information_schema.statistics so re-runs stay idempotent.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='push_subscriptions' AND index_name='idx_user_active')=0,
  'CREATE INDEX idx_user_active ON push_subscriptions (user_id, active)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='push_subscriptions' AND index_name='idx_endpoint')=0,
  'CREATE INDEX idx_endpoint ON push_subscriptions (endpoint(255))', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- Stable occurrence identities are required for idempotent scheduler and API
-- processing. Existing duplicates intentionally stop this migration so an
-- operator can review them rather than silently deleting patient history.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='dose_occurrences' AND index_name='uq_dose_occurrence_schedule')=0,
  'CREATE UNIQUE INDEX uq_dose_occurrence_schedule ON dose_occurrences (medication_id,schedule_version,local_date,local_time)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='medications' AND index_name='idx_medications_user_active')=0,
  'CREATE INDEX idx_medications_user_active ON medications (user_id, active)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='medication_times' AND index_name='idx_medication_times_med')=0,
  'CREATE INDEX idx_medication_times_med ON medication_times (medication_id)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='intake_logs' AND index_name='idx_intake_logs_user_date')=0,
  'CREATE INDEX idx_intake_logs_user_date ON intake_logs (marker_user_id, date)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='intake_logs' AND index_name='idx_intake_logs_med_date_time')=0,
  'CREATE INDEX idx_intake_logs_med_date_time ON intake_logs (medication_id, date, time)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='intake_logs' AND index_name='uq_intake_logs_occurrence')=0,
  'CREATE UNIQUE INDEX uq_intake_logs_occurrence ON intake_logs (occurrence_id)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND index_name='idx_push_attempt_event')=0,
  'CREATE INDEX idx_push_attempt_event ON push_delivery_attempts (event_id)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND index_name='idx_push_attempt_user_time')=0,
  'CREATE INDEX idx_push_attempt_user_time ON push_delivery_attempts (user_id, attempted_at)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND index_name='idx_push_attempt_recovery')=0,
  'CREATE INDEX idx_push_attempt_recovery ON push_delivery_attempts (outcome, lease_expires_at)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='push_delivery_attempts' AND constraint_name='uq_delivery_event_subscription')=0,
  'ALTER TABLE push_delivery_attempts ADD CONSTRAINT uq_delivery_event_subscription UNIQUE (event_id, subscription_id)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='push_subscriptions' AND column_name='user_id' AND referenced_table_name='users' AND referenced_column_name='id')=0,
  'ALTER TABLE push_subscriptions ADD CONSTRAINT fk_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='dose_occurrences' AND column_name='medication_id' AND referenced_table_name='medications' AND referenced_column_name='id')=0,
  'ALTER TABLE dose_occurrences ADD CONSTRAINT fk_occurrence_medication FOREIGN KEY (medication_id) REFERENCES medications(id) ON DELETE CASCADE', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='dose_occurrences' AND column_name='user_id' AND referenced_table_name='users' AND referenced_column_name='id')=0,
  'ALTER TABLE dose_occurrences ADD CONSTRAINT fk_occurrence_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='intake_logs' AND column_name='occurrence_id' AND referenced_table_name='dose_occurrences' AND referenced_column_name='id')=0,
  'ALTER TABLE intake_logs ADD CONSTRAINT fk_intake_logs_occurrence FOREIGN KEY (occurrence_id) REFERENCES dose_occurrences(id) ON DELETE SET NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='occurrence_id' AND referenced_table_name='dose_occurrences' AND referenced_column_name='id')=0,
  'ALTER TABLE push_delivery_attempts ADD CONSTRAINT fk_delivery_occurrence FOREIGN KEY (occurrence_id) REFERENCES dose_occurrences(id) ON DELETE CASCADE', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='medication_id' AND referenced_table_name='medications' AND referenced_column_name='id')=0,
  'ALTER TABLE push_delivery_attempts ADD CONSTRAINT fk_delivery_medication FOREIGN KEY (medication_id) REFERENCES medications(id) ON DELETE CASCADE', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='user_id' AND referenced_table_name='users' AND referenced_column_name='id')=0,
  'ALTER TABLE push_delivery_attempts ADD CONSTRAINT fk_delivery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name='subscription_id' AND referenced_table_name='push_subscriptions' AND referenced_column_name='id')=0,
  'ALTER TABLE push_delivery_attempts ADD CONSTRAINT fk_delivery_subscription FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
