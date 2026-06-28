-- =========================================================
-- Tawsil Crowdshipping — MySQL Schema (Clean Version)
-- Only Schema Creation - No Seed Data
-- =========================================================

CREATE DATABASE IF NOT EXISTS crowdshipping_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE crowdshipping_db;

-- =========================================================
-- 1. Users
-- =========================================================
CREATE TABLE Users (
    id                VARCHAR(36)  PRIMARY KEY,
    first_name        VARCHAR(50)  NOT NULL,
    last_name         VARCHAR(50)  NOT NULL,
    email             VARCHAR(100) UNIQUE NOT NULL,
    password          VARCHAR(255) NOT NULL,
    phone             VARCHAR(20)  UNIQUE NOT NULL,
    profile_picture   VARCHAR(255),
    is_onboarded      BOOLEAN      DEFAULT FALSE,
    city              VARCHAR(100),
    address           TEXT,
    is_email_verified BOOLEAN      DEFAULT FALSE,
    is_blocked        BOOLEAN      DEFAULT FALSE,
    is_suspended      BOOLEAN      DEFAULT FALSE,
    token_version     INT          DEFAULT 0,
    blocked_at        DATETIME,
    suspended_at      DATETIME,
    created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- =========================================================
-- 2. Roles
-- =========================================================
CREATE TABLE Admins (
    user_id VARCHAR(36) PRIMARY KEY,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

CREATE TABLE Authorities (
    user_id VARCHAR(36) PRIMARY KEY,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- =========================================================
-- 2.1 User Tokens
-- =========================================================
CREATE TABLE UserTokens (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL,
    type        ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET') NOT NULL,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  BIGINT NOT NULL,
    used_at     DATETIME,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- =========================================================
-- 3. Participants
-- =========================================================
CREATE TABLE Participants (
    user_id VARCHAR(36) PRIMARY KEY,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- =========================================================
-- 4. Requesters
-- =========================================================
CREATE TABLE Requesters (
    participant_id VARCHAR(36) PRIMARY KEY,
    FOREIGN KEY (participant_id) REFERENCES Participants(user_id) ON DELETE CASCADE
);

-- =========================================================
-- 5. Drivers
-- FIX: Added missing column `verification_status`
-- =========================================================
CREATE TABLE Drivers (
    participant_id        VARCHAR(36)  PRIMARY KEY,
    license_number        VARCHAR(50)  NOT NULL,
    license_expiry        DATE         NOT NULL,
    id_card               VARCHAR(50)  NOT NULL,
    review_status         ENUM('pending','approved','rejected','blocked') NOT NULL DEFAULT 'pending',
    verification_status   ENUM('pending','approved','rejected','blocked') NOT NULL DEFAULT 'pending',
    review_reason         TEXT,
    reviewed_by           VARCHAR(36),
    reviewed_at           DATETIME,
    approved_at           DATETIME,
    is_documents_verified BOOLEAN      DEFAULT FALSE,
    is_available          BOOLEAN      DEFAULT FALSE,
    availability          ENUM('available','busy','offline') DEFAULT 'offline',
    approval_welcome_shown BOOLEAN     DEFAULT FALSE,
    rating                DECIMAL(3,2) DEFAULT 0.0,
    vehicle_info          TEXT,
    driver_type           ENUM('normal_driver','pro_transporter') NOT NULL DEFAULT 'normal_driver',
    max_weight_kg         DECIMAL(10,2) NULL,
    max_volume_m3         DECIMAL(10,4) NULL,
    FOREIGN KEY (participant_id) REFERENCES Participants(user_id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by)   REFERENCES Users(id)             ON DELETE SET NULL
);

-- =========================================================
-- Migration for existing databases:
-- ALTER TABLE Drivers ADD COLUMN approval_welcome_shown BOOLEAN DEFAULT FALSE;
-- =========================================================
-- 6. Vehicles
-- =========================================================
CREATE TABLE Vehicles (
    id                VARCHAR(36) PRIMARY KEY,
    driver_id         VARCHAR(36) NOT NULL,
    make              VARCHAR(50),
    model             VARCHAR(50),
    year              INT,
    color             VARCHAR(30),
    license_plate     VARCHAR(20) UNIQUE,
    insurance_number  VARCHAR(50),
    insurance_expiry  DATE,
    type              ENUM('standard','comfort','premium','van') DEFAULT NULL,
    is_verified       BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE
);

-- =========================================================
-- 7. Documents
-- =========================================================
CREATE TABLE Documents (
    id             VARCHAR(36)  PRIMARY KEY,
    driver_id      VARCHAR(36)  NOT NULL,
    document_type  ENUM('ID_CARD','LICENSE','INSURANCE','VEHICLE_REG','RC') NOT NULL,
    document_url   VARCHAR(255) NOT NULL,
    expiry_date    DATE,
    review_status  ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    review_reason  TEXT,
    reviewed_by    VARCHAR(36),
    reviewed_at    DATETIME,
    is_verified    BOOLEAN DEFAULT FALSE,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id)   REFERENCES Drivers(participant_id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES Users(id)               ON DELETE SET NULL
);

-- =========================================================
-- 8. Trips
-- =========================================================
CREATE TABLE Trips (
    id                    VARCHAR(36) PRIMARY KEY,
    driver_id             VARCHAR(36) NOT NULL,
    title                 VARCHAR(120),
    departure_time        DATETIME    NOT NULL,
    expected_arrival_time DATETIME,
    max_deliveries        INT         DEFAULT 3,
    available_capacity    INT         DEFAULT 3,
    vehicle_type          ENUM('standard','comfort','premium','van') DEFAULT NULL,
    accepted_package_size ENUM('small_only','up_to_medium','up_to_large','any') NOT NULL DEFAULT 'any',
    route_geometry        JSON DEFAULT NULL,
    route_distance_meters INT DEFAULT NULL,
    route_duration_seconds INT DEFAULT NULL,
    status                ENUM('planned','active','completed','cancelled') DEFAULT 'planned',
    notes                 TEXT,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE
);

-- =========================================================
-- 9. TripLocations
-- =========================================================
CREATE TABLE TripLocations (
    id        VARCHAR(36) PRIMARY KEY,
    trip_id   VARCHAR(36) NOT NULL,
    type      ENUM('START','WAYPOINT','END'),
    address   TEXT,
    latitude  DECIMAL(10,8),
    longitude DECIMAL(11,8),
    FOREIGN KEY (trip_id) REFERENCES Trips(id) ON DELETE CASCADE
);

-- =========================================================
-- 10. Deliveries
-- =========================================================
CREATE TABLE Deliveries (
    id                      VARCHAR(36) PRIMARY KEY,
    requester_id            VARCHAR(36) NOT NULL,
    assigned_driver_id      VARCHAR(36),
    trip_id                 VARCHAR(36),
    package_type            VARCHAR(50),
    package_description     TEXT,
    package_image_url       VARCHAR(255),
    package_weight_category ENUM('SMALL','MEDIUM','LARGE','XLARGE'),
    package_size_category   VARCHAR(50),
    package_weight_kg       DECIMAL(10,2),
    package_length_cm       DECIMAL(10,2),
    package_width_cm        DECIMAL(10,2),
    package_height_cm       DECIMAL(10,2),
    package_volume_m3       DECIMAL(10,4),
    capacity_reserved       DECIMAL(10,2) DEFAULT 0,
    is_urgent               BOOLEAN DEFAULT FALSE,
    delivery_mode           VARCHAR(30) DEFAULT 'standard',
    recipient_name          VARCHAR(100),
    recipient_phone         VARCHAR(20),
    delivery_note           TEXT,
    status                  ENUM(
                                'Draft','Pending','Accepted',
                                'DriverArrivedPickup','PickedUp','InTransit',
                                'ArrivedDropoff','Delivered',
                                'CancelledByUser','CancelledByDriver',
                                'Rejected','FailedDelivery','Refunded'
                            ) DEFAULT 'Pending',
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (requester_id)       REFERENCES Requesters(participant_id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_driver_id) REFERENCES Drivers(participant_id)    ON DELETE SET NULL,
    FOREIGN KEY (trip_id)            REFERENCES Trips(id)                  ON DELETE SET NULL
);

-- =========================================================
-- 11. DeliveryRejections
-- =========================================================
CREATE TABLE DeliveryRejections (
    id          VARCHAR(36) PRIMARY KEY,
    delivery_id VARCHAR(36) NOT NULL,
    driver_id   VARCHAR(36) NOT NULL,
    reason      TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_delivery_driver_rejection (delivery_id, driver_id),
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id)          ON DELETE CASCADE,
    FOREIGN KEY (driver_id)   REFERENCES Drivers(participant_id) ON DELETE CASCADE
);

-- =========================================================
-- 12. DeliveryOtps
-- =========================================================
CREATE TABLE DeliveryOtps (
    id          VARCHAR(36) PRIMARY KEY,
    delivery_id VARCHAR(36) UNIQUE NOT NULL,
    otp_hash    VARCHAR(255) NOT NULL,
    expires_at  DATETIME NOT NULL,
    attempts    INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE
);

-- =========================================================
-- 13. DeliveryProofs
-- =========================================================
CREATE TABLE DeliveryProofs (
    id                  VARCHAR(36) PRIMARY KEY,
    delivery_id         VARCHAR(36) UNIQUE NOT NULL,
    photo_url           VARCHAR(255),
    recipient_name      VARCHAR(120),
    recipient_signature TEXT,
    notes               TEXT,
    confirmed_at        DATETIME,
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE
);

-- =========================================================
-- 14. DeliveryLocations
-- =========================================================
CREATE TABLE DeliveryLocations (
    id          VARCHAR(36) PRIMARY KEY,
    delivery_id VARCHAR(36) NOT NULL,
    type        ENUM('PICKUP','DROPOFF') NOT NULL,
    address     TEXT,
    latitude    DECIMAL(10,8),
    longitude   DECIMAL(11,8),
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE
);

-- =========================================================
-- 14.1 DeliveryPricing
-- =========================================================
CREATE TABLE DeliveryPricing (
    id               VARCHAR(36) PRIMARY KEY,
    delivery_id      VARCHAR(36) UNIQUE NOT NULL,
    base_fee         DECIMAL(10,2),
    distance_fee     DECIMAL(10,2),
    weight_surcharge DECIMAL(10,2),
    size_surcharge   DECIMAL(10,2),
    urgent_surcharge DECIMAL(10,2),
    price            DECIMAL(10,2) NOT NULL,
    final_price      DECIMAL(10,2),
    currency         VARCHAR(10) DEFAULT 'DZD',
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE
);

-- =========================================================
-- 14.2 DeliveryEstimates
-- =========================================================
CREATE TABLE DeliveryEstimates (
    id                    VARCHAR(36)  PRIMARY KEY,
    requester_id          VARCHAR(36)  NOT NULL,
    pickup_address        TEXT,
    pickup_latitude       DECIMAL(10,8),
    pickup_longitude      DECIMAL(11,8),
    dropoff_address       TEXT,
    dropoff_latitude      DECIMAL(10,8),
    dropoff_longitude     DECIMAL(11,8),
    package_type          VARCHAR(50),
    package_description   TEXT,
    package_size_category VARCHAR(50),
    package_weight_kg     DECIMAL(10,2),
    package_length_cm     DECIMAL(10,2),
    package_width_cm      DECIMAL(10,2),
    package_height_cm     DECIMAL(10,2),
    package_volume_m3     DECIMAL(10,4),
    is_urgent             BOOLEAN DEFAULT FALSE,
    base_fee              DECIMAL(10,2),
    distance_fee          DECIMAL(10,2),
    weight_surcharge      DECIMAL(10,2),
    size_surcharge        DECIMAL(10,2),
    urgent_surcharge      DECIMAL(10,2),
    estimated_price       DECIMAL(10,2) NOT NULL,
    currency              VARCHAR(10) DEFAULT 'DZD',
    distance_meters       INT,
    duration_seconds      INT,
    expires_at            DATETIME NOT NULL,
    consumed_at           DATETIME,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (requester_id) REFERENCES Requesters(participant_id) ON DELETE CASCADE
);

-- =========================================================
-- 14.3 DeliveryPayments
-- =========================================================
CREATE TABLE DeliveryPayments (
    id             VARCHAR(36) PRIMARY KEY,
    delivery_id    VARCHAR(36) UNIQUE NOT NULL,
    method         ENUM('card','cash','paypal') NOT NULL,
    status         ENUM('pending','completed','failed','refunded','cash_pending','cash_received') NOT NULL DEFAULT 'pending',
    transaction_id VARCHAR(120),
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE
);

-- =========================================================
-- 14.4 DeliveryTimeline
-- =========================================================
CREATE TABLE DeliveryTimeline (
    id                       VARCHAR(36) PRIMARY KEY,
    delivery_id              VARCHAR(36) UNIQUE NOT NULL,
    accepted_at              DATETIME,
    driver_arrived_pickup_at DATETIME,
    picked_up_at             DATETIME,
    in_transit_at            DATETIME,
    arrived_dropoff_at       DATETIME,
    delivered_at             DATETIME,
    cancelled_at             DATETIME,
    failed_at                DATETIME,
    refunded_at              DATETIME,
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE
);

-- =========================================================
-- 14.5 DeliveryCancellation
-- =========================================================
CREATE TABLE DeliveryCancellation (
    id                     VARCHAR(36) PRIMARY KEY,
    delivery_id            VARCHAR(36) UNIQUE NOT NULL,
    cancelled_by_user_id   VARCHAR(36),
    cancelled_by_driver_id VARCHAR(36),
    reason                 TEXT,
    cancelled_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id)            REFERENCES Deliveries(id)          ON DELETE CASCADE,
    FOREIGN KEY (cancelled_by_user_id)   REFERENCES Users(id)               ON DELETE SET NULL,
    FOREIGN KEY (cancelled_by_driver_id) REFERENCES Drivers(participant_id) ON DELETE SET NULL
);

-- =========================================================
-- 15. DriverLocation
-- =========================================================
CREATE TABLE DriverLocation (
    driver_id  VARCHAR(36) PRIMARY KEY,
    latitude   DECIMAL(10,8),
    longitude  DECIMAL(11,8),
    heading    DECIMAL(5,2),
    speed      DECIMAL(5,2),
    `timestamp` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE
);

-- =========================================================
-- 16. Rates
-- =========================================================
CREATE TABLE Rates (
    id           VARCHAR(36) PRIMARY KEY,
    from_user_id VARCHAR(36) NOT NULL,
    to_user_id   VARCHAR(36) NOT NULL,
    id_delivery  VARCHAR(36),
    rating       INT CHECK (rating BETWEEN 1 AND 5),
    comment      TEXT,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES Users(id)      ON DELETE CASCADE,
    FOREIGN KEY (to_user_id)   REFERENCES Users(id)      ON DELETE CASCADE,
    FOREIGN KEY (id_delivery)  REFERENCES Deliveries(id) ON DELETE SET NULL
);

-- =========================================================
-- 17. Notifications
-- =========================================================
CREATE TABLE Notifications (
    id              VARCHAR(36) PRIMARY KEY,
    recipient_id    VARCHAR(36) NOT NULL,
    title           VARCHAR(100),
    message         TEXT,
    type            VARCHAR(50),
    reference_id    VARCHAR(36),
    reference_model VARCHAR(50),
    delivery_id     VARCHAR(36),
    trip_id         VARCHAR(36),
    promotion_id    VARCHAR(36),
    is_read         BOOLEAN DEFAULT FALSE,
    action_url      VARCHAR(255),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recipient_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- =========================================================
-- 18. Promotions
-- =========================================================
CREATE TABLE Promotions (
    id              VARCHAR(36) PRIMARY KEY,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    code            VARCHAR(50),
    discount        DECIMAL(10,2),
    start_date      DATETIME,
    end_date        DATETIME,
    target_user_type ENUM('all', 'client', 'driver') DEFAULT 'all',
    is_active       BOOLEAN DEFAULT TRUE,
    created_by      VARCHAR(36),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES Users(id) ON DELETE SET NULL
);

-- =========================================================
-- 19. DriverVerificationTimeline
-- =========================================================
CREATE TABLE DriverVerificationTimeline (
    id          VARCHAR(36) PRIMARY KEY,
    driver_id   VARCHAR(36) NOT NULL,
    event_type  ENUM('driver_review_updated','document_added','document_updated','document_reviewed') NOT NULL,
    entity_type ENUM('driver','document') NOT NULL,
    entity_id   VARCHAR(36),
    status      VARCHAR(50),
    reason      TEXT,
    actor_id    VARCHAR(36),
    metadata    JSON,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id)  REFERENCES Users(id)               ON DELETE SET NULL
);

-- =========================================================
-- 19. AuthorityIncidents
-- =========================================================
CREATE TABLE AuthorityIncidents (
    id                       VARCHAR(36)  PRIMARY KEY,
    delivery_id              VARCHAR(36),
    trip_id                  VARCHAR(36),
    reported_by_user_id      VARCHAR(36),
    assigned_to_authority_id VARCHAR(36),
    severity                 ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
    status                   ENUM('open','in_review','resolved','dismissed') NOT NULL DEFAULT 'open',
    title                    VARCHAR(160) NOT NULL,
    description              TEXT NOT NULL,
    resolution_notes         TEXT,
    occurred_at              DATETIME,
    resolved_at              DATETIME,
    created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id)              REFERENCES Deliveries(id)         ON DELETE SET NULL,
    FOREIGN KEY (trip_id)                  REFERENCES Trips(id)              ON DELETE SET NULL,
    FOREIGN KEY (reported_by_user_id)      REFERENCES Users(id)              ON DELETE SET NULL,
    FOREIGN KEY (assigned_to_authority_id) REFERENCES Authorities(user_id)   ON DELETE SET NULL
);

-- =========================================================
-- 20. AuthorityComplaints
-- =========================================================
CREATE TABLE AuthorityComplaints (
    id                      VARCHAR(36) PRIMARY KEY,
    complainant_user_id     VARCHAR(36) NOT NULL,
    target_user_id          VARCHAR(36),
    delivery_id             VARCHAR(36),
    trip_id                 VARCHAR(36),
    handled_by_authority_id VARCHAR(36),
    category                ENUM('driver_behavior','delay','damage','payment','fraud','other') NOT NULL,
    status                  ENUM('new','in_review','resolved','rejected') NOT NULL DEFAULT 'new',
    description             TEXT NOT NULL,
    resolution_notes        TEXT,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (complainant_user_id)     REFERENCES Users(id)            ON DELETE CASCADE,
    FOREIGN KEY (target_user_id)          REFERENCES Users(id)            ON DELETE SET NULL,
    FOREIGN KEY (delivery_id)             REFERENCES Deliveries(id)       ON DELETE SET NULL,
    FOREIGN KEY (trip_id)                 REFERENCES Trips(id)            ON DELETE SET NULL,
    FOREIGN KEY (handled_by_authority_id) REFERENCES Authorities(user_id) ON DELETE SET NULL
);

-- =========================================================
-- 21. AuthorityComplianceReports
-- =========================================================
CREATE TABLE AuthorityComplianceReports (
    id           VARCHAR(36) PRIMARY KEY,
    type         ENUM('daily','weekly','monthly','incident','custom') NOT NULL,
    status       ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
    generated_by VARCHAR(36),
    period_start DATETIME,
    period_end   DATETIME,
    summary      TEXT,
    report_json  JSON,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at DATETIME,
    FOREIGN KEY (generated_by) REFERENCES Authorities(user_id) ON DELETE SET NULL
);

-- PricingAnalytics table was removed because the codebase only
-- references DeliveryPricingAnalytics (see services/delivery.service.js
-- and controllers/delivery.workflow.js). This avoids schema duplication.

-- =========================================================
-- 17. DeliveryPricingAnalytics
-- =========================================================
CREATE TABLE IF NOT EXISTS DeliveryPricingAnalytics (
    id                  VARCHAR(36) PRIMARY KEY,
    delivery_id         VARCHAR(36) NOT NULL,
    pricing_mode        VARCHAR(50) NOT NULL,
    distance_km         DECIMAL(10,2) NOT NULL,
    base_fee            DECIMAL(10,2) NOT NULL,
    distance_fee        DECIMAL(10,2) NOT NULL,
    size_surcharge      DECIMAL(10,2) NOT NULL,
    weight_surcharge    DECIMAL(10,2) NOT NULL,
    deviation_cost      DECIMAL(10,2) DEFAULT 0,
    urgent_surcharge    DECIMAL(10,2) DEFAULT 0,
    estimated_price     DECIMAL(10,2) NOT NULL,
    driver_score        INT DEFAULT NULL,
    selected_driver_id  VARCHAR(36) DEFAULT NULL,
    is_best_deal        BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE,
    FOREIGN KEY (selected_driver_id) REFERENCES Drivers(participant_id) ON DELETE SET NULL
);

-- =========================================================
-- 24. Settings (key-value store)
-- =========================================================
CREATE TABLE IF NOT EXISTS Settings (
    setting_key   VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT IGNORE INTO Settings (setting_key, setting_value) VALUES ('fuel_cost_per_km', '8');

-- =========================================================
-- 25. DeliveryEarningsSnapshot
-- =========================================================
CREATE TABLE IF NOT EXISTS DeliveryEarningsSnapshot (
    id                 VARCHAR(36) PRIMARY KEY,
    delivery_id        VARCHAR(36) NOT NULL,
    driver_id          VARCHAR(36) NOT NULL,
    estimated_earnings DECIMAL(10,2) NOT NULL,
    actual_earnings    DECIMAL(10,2) DEFAULT NULL,
    snapshot_data      JSON DEFAULT NULL,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE,
    FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE
);

-- =========================================================
-- 20. DriverStatusHistory
-- =========================================================
CREATE TABLE DriverStatusHistory (
    id          VARCHAR(36) PRIMARY KEY,
    driver_id   VARCHAR(36) NOT NULL,
    old_status  VARCHAR(50) DEFAULT NULL,
    new_status  VARCHAR(50) NOT NULL,
    changed_by  VARCHAR(36) DEFAULT NULL,
    comment     TEXT DEFAULT NULL,
    changed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by) REFERENCES Users(id) ON DELETE SET NULL
);

-- =========================================================
-- Indexes
-- =========================================================
CREATE INDEX idx_users_blocked_suspended              ON Users(is_blocked, is_suspended);
CREATE INDEX idx_drivers_available                    ON Drivers(is_available, is_documents_verified);
CREATE INDEX idx_drivers_availability                 ON Drivers(availability);
CREATE INDEX idx_drivers_review_status                ON Drivers(review_status);
CREATE INDEX idx_drivers_verification_status          ON Drivers(verification_status);
CREATE INDEX idx_trips_driver_status_departure        ON Trips(driver_id, status, departure_time);
CREATE INDEX idx_trips_status_capacity                ON Trips(status, available_capacity);
CREATE INDEX idx_trip_locations_trip_type             ON TripLocations(trip_id, type);
CREATE INDEX idx_deliveries_requester_status          ON Deliveries(requester_id, status, created_at);
CREATE INDEX idx_deliveries_driver_status             ON Deliveries(assigned_driver_id, status, created_at);
CREATE INDEX idx_deliveries_trip_status               ON Deliveries(trip_id, status, created_at);
CREATE INDEX idx_delivery_locations_type              ON DeliveryLocations(delivery_id, type);
CREATE INDEX idx_delivery_estimates_requester_expiry  ON DeliveryEstimates(requester_id, expires_at, consumed_at);
CREATE INDEX idx_driver_location_ts                   ON DriverLocation(`timestamp`);
CREATE INDEX idx_rates_from_user                      ON Rates(from_user_id);
CREATE INDEX idx_rates_to_user                        ON Rates(to_user_id);
CREATE INDEX idx_notifications_recipient              ON Notifications(recipient_id, is_read, created_at);
CREATE INDEX idx_driver_verification_timeline_driver  ON DriverVerificationTimeline(driver_id, created_at);
CREATE INDEX idx_authority_incidents_status           ON AuthorityIncidents(status, severity, created_at);
CREATE INDEX idx_authority_incidents_delivery         ON AuthorityIncidents(delivery_id);
CREATE INDEX idx_authority_complaints_status          ON AuthorityComplaints(status, category, created_at);
CREATE INDEX idx_authority_complaints_delivery        ON AuthorityComplaints(delivery_id);
CREATE INDEX idx_authority_compliance_reports_status  ON AuthorityComplianceReports(status, type, created_at);
CREATE INDEX idx_user_tokens_lookup                   ON UserTokens(user_id, type, expires_at);
CREATE INDEX idx_driver_status_history_driver         ON DriverStatusHistory(driver_id, changed_at);

-- ---------------------------------------------------------
-- Delivery Ratings
-- ---------------------------------------------------------
CREATE TABLE DeliveryRatings (
    id                    VARCHAR(36) PRIMARY KEY,
    delivery_id           VARCHAR(36) NOT NULL UNIQUE,
    driver_id             VARCHAR(36) NOT NULL,
    client_id             VARCHAR(36) NOT NULL,
    communication_rating  TINYINT UNSIGNED NOT NULL CHECK (communication_rating BETWEEN 1 AND 5),
    package_rating        TINYINT UNSIGNED NOT NULL CHECK (package_rating BETWEEN 1 AND 5),
    delivery_time_rating  TINYINT UNSIGNED NOT NULL CHECK (delivery_time_rating BETWEEN 1 AND 5),
    average_rating        DECIMAL(3,2) NOT NULL,
    comment               TEXT,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE,
    FOREIGN KEY (driver_id)   REFERENCES Drivers(participant_id) ON DELETE CASCADE,
    FOREIGN KEY (client_id)   REFERENCES Requesters(participant_id) ON DELETE CASCADE
);

CREATE INDEX idx_delivery_ratings_driver      ON DeliveryRatings(driver_id);
CREATE INDEX idx_delivery_ratings_delivery    ON DeliveryRatings(delivery_id);

-- =========================================================
-- End of Schema
-- =========================================================