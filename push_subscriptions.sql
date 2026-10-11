-- Push Subscriptions Table for Web Push Notifications
-- Add this to your existing DoseBuddy database

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

-- Clean up expired subscriptions (run periodically)
-- DELETE FROM push_subscriptions WHERE active = 0 AND updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY);