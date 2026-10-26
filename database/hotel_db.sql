-- =====================================================
-- GRAND HOTEL DATABASE
-- =====================================================
CREATE DATABASE IF NOT EXISTS hotel_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS hotel_deleted_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE hotel_db;

-- ---------- Roles and permissions ----------
CREATE TABLE roles (
  id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(30) NOT NULL UNIQUE
);

CREATE TABLE permissions (
  id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE role_permissions (
  role_id       INT UNSIGNED NOT NULL,
  permission_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (permission_id) REFERENCES permissions(id)
);

-- ---------- Staff accounts ----------
CREATE TABLE users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name       VARCHAR(100) NOT NULL,
  username        VARCHAR(50)  NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  salt            VARCHAR(64)  NOT NULL,
  role_id         INT UNSIGNED NOT NULL,
  totp_secret     VARCHAR(255) NULL,
  two_fa_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    DATETIME NULL,
  last_login      DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- ---------- Hotel data ----------
CREATE TABLE guests (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name  VARCHAR(100) NOT NULL,
  phone      VARCHAR(20)  NOT NULL,
  email      VARCHAR(100) NULL,
  id_type    ENUM('Ghana Card','Passport','Driver''s License') NOT NULL,
  id_number  VARCHAR(50)  NOT NULL,
  country    VARCHAR(60)  NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rooms (
  id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_no   VARCHAR(10) NOT NULL UNIQUE,
  room_type ENUM('Single','Double','Suite') NOT NULL,
  price     DECIMAL(10,2) NOT NULL,
  status    ENUM('Available','Occupied','Maintenance') NOT NULL DEFAULT 'Available'
);

CREATE TABLE bookings (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_code VARCHAR(15) NOT NULL UNIQUE,
  guest_id     INT UNSIGNED NOT NULL,
  room_id      INT UNSIGNED NOT NULL,
  arrival      DATE NOT NULL,
  departure    DATE NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  amount_paid  DECIMAL(10,2) NOT NULL DEFAULT 0,
  status       ENUM('Confirmed','Checked in','Checked out','Cancelled') NOT NULL DEFAULT 'Confirmed',
  created_by   INT UNSIGNED NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (guest_id)   REFERENCES guests(id),
  FOREIGN KEY (room_id)    REFERENCES rooms(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  CHECK (departure > arrival)
);

CREATE TABLE payments (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  receipt_no  VARCHAR(15) NOT NULL UNIQUE,
  booking_id  INT UNSIGNED NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  method      ENUM('Cash','Card','Mobile Money') NOT NULL,
  recorded_by INT UNSIGNED NOT NULL,
  paid_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id)  REFERENCES bookings(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id),
  CHECK (amount > 0)
);

CREATE TABLE complaints (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guest_id        INT UNSIGNED NOT NULL,
  description     VARCHAR(500) NOT NULL,
  status          ENUM('Open','Resolved') NOT NULL DEFAULT 'Open',
  resolution_note VARCHAR(500) NULL,
  handled_by      INT UNSIGNED NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (guest_id)   REFERENCES guests(id),
  FOREIGN KEY (handled_by) REFERENCES users(id)
);

CREATE TABLE staff_tasks (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  assigned_to INT UNSIGNED NOT NULL,
  assigned_by INT UNSIGNED NOT NULL,
  task        VARCHAR(200) NOT NULL,
  shift       ENUM('Morning','Afternoon','Night') NOT NULL,
  is_done     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id),
  FOREIGN KEY (assigned_by) REFERENCES users(id)
);

CREATE TABLE enquiries (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_name  VARCHAR(100) NOT NULL,
  details    VARCHAR(500) NOT NULL,
  status     ENUM('Open','Resolved') NOT NULL DEFAULT 'Open',
  logged_by  INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (logged_by) REFERENCES users(id)
);

CREATE TABLE decisions (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_text VARCHAR(300) NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  status       ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  decided_by   INT UNSIGNED NULL,
  decided_at   DATETIME NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (decided_by)   REFERENCES users(id)
);

-- ---------- Settings (one row each) ----------
CREATE TABLE hotel_info (
  id            TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
  name          VARCHAR(100) NOT NULL,
  phone         VARCHAR(20),
  email         VARCHAR(100),
  address       VARCHAR(200),
  checkin_time  TIME NOT NULL DEFAULT '14:00:00',
  checkout_time TIME NOT NULL DEFAULT '11:00:00',
  CHECK (id = 1)
);

CREATE TABLE security_settings (
  id                  TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
  require_2fa         BOOLEAN NOT NULL DEFAULT TRUE,
  max_failed_attempts INT NOT NULL DEFAULT 5,
  session_timeout_min INT NOT NULL DEFAULT 15,
  min_password_length INT NOT NULL DEFAULT 10,
  CHECK (id = 1)
);

-- ---------- Audit log ----------
CREATE TABLE audit_log (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id        INT UNSIGNED NULL,
  username_tried VARCHAR(50) NULL,
  action         VARCHAR(100) NOT NULL,
  details        VARCHAR(255) NULL,
  ip_address     VARCHAR(45)  NULL,
  result         ENUM('Success','Failed') NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (created_at),
  INDEX (user_id)
);

-- ---------- Backups and restore points ----------
CREATE TABLE backups (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  taken_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  type       ENUM('Automatic','Manual') NOT NULL,
  file_name  VARCHAR(150) NOT NULL,
  checksum   VARCHAR(64) NULL,
  location   VARCHAR(100) NOT NULL,
  status     ENUM('Success','Failed') NOT NULL,
  taken_by   INT UNSIGNED NULL,
  FOREIGN KEY (taken_by) REFERENCES users(id)
);

-- Restore points hold CONFIGURATION ONLY (never guest or booking data)
CREATE TABLE restore_points (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  label       VARCHAR(100) NOT NULL,
  config_json JSON NOT NULL,
  created_by  INT UNSIGNED NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ---------- Protect the audit log: no edits, no deletes ----------
DELIMITER $$
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit log cannot be changed';
END$$

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit log cannot be deleted';
END$$
DELIMITER ;

-- =====================================================
-- DELETED DATA DATABASE (a separate filing room)
-- =====================================================
USE hotel_deleted_db;

CREATE TABLE deleted_records (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source_table VARCHAR(50) NOT NULL,
  source_id    INT UNSIGNED NOT NULL,
  record_data  JSON NOT NULL,
  deleted_by   INT UNSIGNED NULL,
  reason       VARCHAR(200) NULL,
  deleted_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (source_table, source_id)
);

-- =====================================================
-- STARTING DATA
-- =====================================================
USE hotel_db;

INSERT INTO roles (name) VALUES ('Admin'), ('Manager'), ('Receptionist');

INSERT INTO permissions (name) VALUES
 ('Manage user accounts'), ('Assign roles and permissions'), ('Manage hotel information'),
 ('View all records'), ('Monitor system activity'), ('Maintain security'), ('System backup'),
 ('Manage room availability'), ('Monitor bookings'), ('Manage staff operations'),
 ('View reports'), ('Monitor payments'), ('Handle complaints'), ('Make decisions'),
 ('Register guests'), ('Make reservations'), ('Check room availability'),
 ('Check guests in'), ('Check guests out'), ('Record payments'),
 ('Update guest records'), ('Handle enquiries');

-- Admin gets everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Admin';

-- Manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Manager' AND p.name IN
 ('Manage room availability','Monitor bookings','Manage staff operations',
  'View reports','Monitor payments','Handle complaints','Make decisions');

-- Receptionist
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Receptionist' AND p.name IN
 ('Register guests','Make reservations','Check room availability','Check guests in',
  'Check guests out','Record payments','Update guest records','Handle enquiries');

INSERT INTO rooms (room_no, room_type, price, status) VALUES
 ('101','Single',300,'Available'), ('102','Single',300,'Available'),
 ('108','Double',500,'Available'), ('204','Suite',900,'Available'),
 ('205','Double',500,'Maintenance'), ('301','Suite',900,'Available');

INSERT INTO hotel_info (name, phone, email, address)
VALUES ('Grand Hotel', '+233 00 000 0000', 'info@grandhotel.com', 'Accra, Ghana');

INSERT INTO security_settings (id) VALUES (1);

-- =====================================================
-- A LIMITED DATABASE USER FOR OUR WEBSITE (not root)
-- CHANGE THE PASSWORD below to your own strong password
-- =====================================================
CREATE USER IF NOT EXISTS 'hotel_app'@'localhost' IDENTIFIED BY 'ChangeMe-To-A-Strong-Password-1!';
GRANT SELECT, INSERT, UPDATE, DELETE ON hotel_db.* TO 'hotel_app'@'localhost';
GRANT SELECT, INSERT ON hotel_deleted_db.* TO 'hotel_app'@'localhost';
FLUSH PRIVILEGES;


USE hotel_db;
SELECT id, username, LEFT(password_hash, 24) AS hash_start, role_id FROM users;

CREATE DATABASE IF NOT EXISTS injection_demo;

CREATE TABLE injection_demo.demo_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50),
  password_plain VARCHAR(50)
);

INSERT INTO injection_demo.demo_users (username, password_plain)
VALUES ('alice', 'fakepass1'), ('bob', 'fakepass2');

GRANT SELECT ON injection_demo.* TO 'hotel_app'@'localhost';
FLUSH PRIVILEGES;

SELECT id, username, full_name,
       totp_secret IS NOT NULL AS has_authenticator
FROM users
WHERE username = 'Cannibella';

ALTER USER 'hotel_app'@'localhost'IDENTIFIED BY '5AUG2007';