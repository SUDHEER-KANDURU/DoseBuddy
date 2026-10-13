-- Additive, privacy-safe Web Push attempt diagnostics.
-- No message payload, endpoint, cookie, token, or medical details are stored.
CREATE TABLE IF NOT EXISTS push_delivery_attempts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(191) NOT NULL,
    user_id BIGINT NOT NULL,
    subscription_id INT NOT NULL,
    event_created_at DATETIME(3) NULL,
    scheduled_at DATETIME(3) NULL,
    attempted_at DATETIME(3) NOT NULL,
    provider_status SMALLINT NULL,
    outcome VARCHAR(32) NOT NULL,
    processing_lag_ms INT NOT NULL,
    delivery_latency_ms INT NOT NULL,
    retry_count INT NOT NULL DEFAULT 0,
    error_category VARCHAR(100) NULL,
    INDEX idx_push_attempt_event (event_id),
    INDEX idx_push_attempt_user_time (user_id, attempted_at)
);
