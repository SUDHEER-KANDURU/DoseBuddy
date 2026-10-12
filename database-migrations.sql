-- DoseBuddy Notification System Database Migrations
-- Run these in order against your production database

-- 1. Create push_subscriptions table (if not exists)
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint TEXT NOT NULL,
    subscription_data TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_active (user_id, active),
    INDEX idx_endpoint (endpoint(255))
);

-- 2. Create push_delivery_attempts table (if not exists)
CREATE TABLE IF NOT EXISTS push_delivery_attempts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(191) NOT NULL,
    user_id INT NOT NULL,
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

-- 3. Add active column to medications table (if not exists)
-- Check if column exists first to avoid errors
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists 
FROM information_schema.columns 
WHERE table_schema = DATABASE() 
AND table_name = 'medications' 
AND column_name = 'active';

SET @sql = IF(@col_exists = 0, 
  'ALTER TABLE medications ADD COLUMN active BOOLEAN DEFAULT 1', 
  'SELECT "Column active already exists" as message');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Create indexes for better performance on existing tables
CREATE INDEX IF NOT EXISTS idx_medications_user_active ON medications (user_id, active);
CREATE INDEX IF NOT EXISTS idx_medication_times_med ON medication_times (medication_id);
CREATE INDEX IF NOT EXISTS idx_intake_logs_user_date ON intake_logs (marker_user_id, date);
CREATE INDEX IF NOT EXISTS idx_intake_logs_med_date_time ON intake_logs (medication_id, date, time);