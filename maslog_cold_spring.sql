-- =============================================================================
-- Maslog Cold Spring Resort — Full System Database Schema (PostgreSQL)
-- Covers: Login, Sign Up, Client (User), Staff, Admin
-- Works with: Supabase, Neon, local PostgreSQL, pgAdmin
-- NOTE: Do NOT run CREATE DATABASE here — select/create the DB first, then run this.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ENUM TYPES
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('active','inactive','pending','rejected','suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE portal_type AS ENUM ('admin','staff','client');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE review_status AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE otp_purpose AS ENUM ('signup','login_reset','booking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE partner_rate_type AS ENUM ('hour','day');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash','gcash');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('unpaid','pending','paid','refunded','partial');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM ('pending','confirmed','cancelled','completed','no_show');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE line_item_type AS ENUM ('entrance','property','partnership','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE walk_in_item_type AS ENUM ('entrance','cottage','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trx_status AS ENUM ('completed','void','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE receipt_source AS ENUM ('online_booking','walk_in');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qr_result AS ENUM ('valid','invalid','already_used','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notif_type AS ENUM ('booking','account','promo','payment','info');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Helper: auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 1. ROLES & AUTHENTICATION (Login for Admin / Staff / Client)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roles (
  id            SMALLSERIAL PRIMARY KEY,
  role_code     VARCHAR(20)  NOT NULL UNIQUE,   -- admin | staff | client
  role_name     VARCHAR(50)  NOT NULL,
  description   VARCHAR(255) NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO roles (role_code, role_name, description)
VALUES
  ('admin',  'Admin',  'Administrator portal — staff accounts, reports, system config'),
  ('staff',  'Staff',  'Cashier / Staff portal — walk-in, bookings, fees, QR verify'),
  ('client', 'Client', 'Customer app — register, book online, receipts, profile')
ON CONFLICT (role_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  role_id         SMALLINT NOT NULL REFERENCES roles(id),
  email           VARCHAR(150) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(150) NOT NULL,
  phone           VARCHAR(30)  NULL,
  status          user_status NOT NULL DEFAULT 'pending',
  last_login_at   TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE TABLE IF NOT EXISTS login_sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portal        portal_type NOT NULL,
  session_token VARCHAR(128) NOT NULL UNIQUE,
  ip_address    VARCHAR(45)  NULL,
  user_agent    VARCHAR(255) NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON login_sessions(expires_at);

-- -----------------------------------------------------------------------------
-- 2. STAFF / ADMIN ACCOUNTS
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_profiles (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  staff_code    VARCHAR(30) NULL UNIQUE,
  job_title     VARCHAR(80) NULL,
  hire_date     DATE NULL,
  notes         TEXT NULL,
  created_by    BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_staff_profiles_updated ON staff_profiles;
CREATE TRIGGER trg_staff_profiles_updated
  BEFORE UPDATE ON staff_profiles
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. CLIENT SIGN UP / REGISTRATION & VERIFICATION
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS id_types (
  id    SMALLSERIAL PRIMARY KEY,
  name  VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO id_types (name) VALUES
  ('National ID'),
  ('Driver''s License'),
  ('Passport'),
  ('Postal ID'),
  ('School ID'),
  ('Voter''s ID'),
  ('PhilHealth ID'),
  ('SSS ID')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS client_profiles (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  registration_code    VARCHAR(40) NOT NULL UNIQUE,
  id_type_id           SMALLINT NULL REFERENCES id_types(id),
  selfie_path          TEXT NULL,
  valid_id_path        TEXT NULL,
  gmail_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  camera_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  id_verified          BOOLEAN NOT NULL DEFAULT FALSE,
  gmail_staff_verified BOOLEAN NOT NULL DEFAULT FALSE,
  review_status        review_status NOT NULL DEFAULT 'pending',
  reviewed_by          BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at          TIMESTAMPTZ NULL,
  reject_reason        VARCHAR(500) NULL,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE client_profiles ALTER COLUMN selfie_path TYPE TEXT;
ALTER TABLE client_profiles ALTER COLUMN valid_id_path TYPE TEXT;

CREATE INDEX IF NOT EXISTS idx_client_status ON client_profiles(review_status);

DROP TRIGGER IF EXISTS trg_client_profiles_updated ON client_profiles;
CREATE TRIGGER trg_client_profiles_updated
  BEFORE UPDATE ON client_profiles
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE TABLE IF NOT EXISTS email_otps (
  id          BIGSERIAL PRIMARY KEY,
  email       VARCHAR(150) NOT NULL,
  otp_code    VARCHAR(10)  NOT NULL,
  purpose     otp_purpose NOT NULL DEFAULT 'signup',
  is_used     BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_otp_email ON email_otps(email, purpose);

-- -----------------------------------------------------------------------------
-- 4. ADMIN SYSTEM CONFIG — Entrance Fees & Property Rates (walk-in)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_entrance_fees (
  id          SMALLSERIAL PRIMARY KEY,
  fee_key     VARCHAR(30) NOT NULL UNIQUE,
  label       VARCHAR(80) NOT NULL,
  amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  description VARCHAR(255) NULL,
  updated_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO admin_entrance_fees (fee_key, label, amount, description) VALUES
  ('adult',  'Adult Entrance',  150.00, 'Ages 13 and above'),
  ('child',  'Child Entrance',  100.00, 'Ages 4–12'),
  ('senior', 'Senior / PWD',     75.00, 'Discounted rate'),
  ('infant', 'Infant (0–3)',      0.00, 'Free or reduced')
ON CONFLICT (fee_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_cottages (
  id           BIGSERIAL PRIMARY KEY,
  property_type VARCHAR(20) NOT NULL DEFAULT 'cottage',
  name         VARCHAR(100) NOT NULL,
  capacity     INTEGER NOT NULL DEFAULT 6,
  features     VARCHAR(255) NULL,
  rate         NUMERIC(10,2) NOT NULL DEFAULT 0,
  photo_path   TEXT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE admin_cottages ADD COLUMN IF NOT EXISTS photo_path TEXT;
ALTER TABLE admin_cottages ADD COLUMN IF NOT EXISTS property_type VARCHAR(20) NOT NULL DEFAULT 'cottage';

DROP TRIGGER IF EXISTS trg_admin_cottages_updated ON admin_cottages;
CREATE TRIGGER trg_admin_cottages_updated
  BEFORE UPDATE ON admin_cottages
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- No hardcoded properties are inserted here.
-- Add properties through Admin Property Rates or Staff Fees Edit so online booking reads public.staff_properties.

CREATE TABLE IF NOT EXISTS system_settings (
  id                SMALLSERIAL PRIMARY KEY,
  resort_name       VARCHAR(150) NOT NULL DEFAULT 'Maslog Cold Spring',
  contact_number    VARCHAR(40) NULL,
  address           VARCHAR(255) NULL,
  email             VARCHAR(150) NULL,
  logo_path         VARCHAR(500) NULL,
  receipt_header    TEXT NULL,
  receipt_footer    TEXT NULL,
  auto_receipt_no   BOOLEAN NOT NULL DEFAULT TRUE,
  qr_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  show_logo_receipt BOOLEAN NOT NULL DEFAULT TRUE,
  currency          VARCHAR(20) NOT NULL DEFAULT 'PHP',
  vat_rate          NUMERIC(5,2) NOT NULL DEFAULT 12.00,
  senior_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  pwd_discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO system_settings (resort_name, contact_number, address, email, receipt_header, receipt_footer)
SELECT
  'Maslog Cold Spring',
  '+63 917 555 0100',
  'Maslog, Claveria, Cagayan Valley',
  'admin@maslogcoldspring.com',
  E'Maslog Cold Spring\nThank you for visiting!',
  'Preserve Nature. Manage Better.'
WHERE NOT EXISTS (SELECT 1 FROM system_settings LIMIT 1);

-- -----------------------------------------------------------------------------
-- 5. STAFF FEES EDIT — Properties, partnership, GCash QR
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS property_types (
  id   SMALLSERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL
);

INSERT INTO property_types (code, name) VALUES
  ('cottage', 'Cottage'),
  ('chair',   'Chair'),
  ('tent',    'Tent')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS staff_properties (
  id               BIGSERIAL PRIMARY KEY,
  property_type_id SMALLINT NOT NULL REFERENCES property_types(id),
  name             VARCHAR(120) NOT NULL,
  price            NUMERIC(10,2) NOT NULL DEFAULT 0,
  description      TEXT NULL,
  is_available     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_staff_properties_updated ON staff_properties;
CREATE TRIGGER trg_staff_properties_updated
  BEFORE UPDATE ON staff_properties
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE TABLE IF NOT EXISTS staff_property_photos (
  id          BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES staff_properties(id) ON DELETE CASCADE,
  photo_path  TEXT NOT NULL,
  sort_order  SMALLINT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE staff_property_photos ALTER COLUMN photo_path TYPE TEXT;

CREATE TABLE IF NOT EXISTS partnership_fees (
  id           SMALLSERIAL PRIMARY KEY,
  name         VARCHAR(150) NOT NULL DEFAULT 'Vendor Stall Partnership',
  fee_per_hour NUMERIC(10,2) NOT NULL DEFAULT 0,
  fee_per_day  NUMERIC(10,2) NOT NULL DEFAULT 0,
  description  TEXT NULL,
  logo_path    VARCHAR(500) NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO partnership_fees (name, fee_per_hour, fee_per_day, description)
SELECT
  'Vendor Stall Partnership', 150.00, 1200.00,
  'Open stall space near the spring entrance. Includes 1 table and access to power outlet.'
WHERE NOT EXISTS (SELECT 1 FROM partnership_fees LIMIT 1);

CREATE TABLE IF NOT EXISTS gcash_settings (
  id             SMALLSERIAL PRIMARY KEY,
  account_name   VARCHAR(150) NOT NULL DEFAULT 'Maslog Cold Spring',
  account_number VARCHAR(40) NULL,
  qr_image_path  VARCHAR(500) NULL,
  updated_by     BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO gcash_settings (account_name, account_number)
SELECT 'Maslog Cold Spring', '09XX XXX XXXX'
WHERE NOT EXISTS (SELECT 1 FROM gcash_settings LIMIT 1);

CREATE TABLE IF NOT EXISTS booking_settings (
  id               SMALLSERIAL PRIMARY KEY,
  entrance_adult   NUMERIC(10,2) NOT NULL DEFAULT 80.00,
  entrance_child   NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  entrance_senior  NUMERIC(10,2) NOT NULL DEFAULT 60.00,
  agreement_text   TEXT NULL,
  cs_phone         VARCHAR(40) NULL,
  cs_email         VARCHAR(150) NULL,
  cs_hours         VARCHAR(100) NULL,
  cs_messenger     VARCHAR(150) NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO booking_settings (
  entrance_adult, entrance_child, entrance_senior, agreement_text,
  cs_phone, cs_email, cs_hours, cs_messenger
)
SELECT
  80.00, 50.00, 60.00,
  'You must arrive on your confirmed booking date. If you fail to show up without prior notice, 10% of your payment will not be refunded.',
  '+63 912 345 6789',
  'support@maslogcoldspring.com',
  'Daily · 7:00 AM – 6:00 PM',
  'Maslog Cold Spring Official'
WHERE NOT EXISTS (SELECT 1 FROM booking_settings LIMIT 1);

CREATE TABLE IF NOT EXISTS unavailable_dates (
  id         BIGSERIAL PRIMARY KEY,
  block_date DATE NOT NULL UNIQUE,
  reason     VARCHAR(255) NULL,
  created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 6. ONLINE BOOKINGS (Client)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bookings (
  id                 BIGSERIAL PRIMARY KEY,
  booking_code       VARCHAR(40) NOT NULL UNIQUE,
  client_user_id     BIGINT NOT NULL REFERENCES users(id),
  booking_date       DATE NOT NULL,
  property_id        BIGINT NULL REFERENCES staff_properties(id) ON DELETE SET NULL,
  property_name      VARCHAR(120) NULL,
  adults             INTEGER NOT NULL DEFAULT 1,
  children           INTEGER NOT NULL DEFAULT 0,
  seniors            INTEGER NOT NULL DEFAULT 0,
  include_partner    BOOLEAN NOT NULL DEFAULT FALSE,
  partner_rate_type  partner_rate_type NULL,
  partner_hours      INTEGER NULL,
  payment_method     payment_method NOT NULL DEFAULT 'cash',
  payment_status     payment_status NOT NULL DEFAULT 'pending',
  booking_status     booking_status NOT NULL DEFAULT 'pending',
  subtotal           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  agreement_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  notes              TEXT NULL,
  reviewed_by        BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_book_client ON bookings(client_user_id);
CREATE INDEX IF NOT EXISTS idx_book_date   ON bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_book_status ON bookings(booking_status);

DROP TRIGGER IF EXISTS trg_bookings_updated ON bookings;
CREATE TRIGGER trg_bookings_updated
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE TABLE IF NOT EXISTS booking_line_items (
  id          BIGSERIAL PRIMARY KEY,
  booking_id  BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  item_type   line_item_type NOT NULL,
  description VARCHAR(200) NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL DEFAULT 0,
  line_total  NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- 7. WALK-IN TRANSACTIONS
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS walk_in_transactions (
  id              BIGSERIAL PRIMARY KEY,
  trx_code        VARCHAR(40) NOT NULL UNIQUE,
  cashier_user_id BIGINT NOT NULL REFERENCES users(id),
  guest_name      VARCHAR(150) NULL,
  payment_method  payment_method NOT NULL DEFAULT 'cash',
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          trx_status NOT NULL DEFAULT 'completed',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS walk_in_items (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES walk_in_transactions(id) ON DELETE CASCADE,
  item_type      walk_in_item_type NOT NULL,
  item_name      VARCHAR(150) NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,
  unit_price     NUMERIC(10,2) NOT NULL DEFAULT 0,
  line_total     NUMERIC(12,2) NOT NULL DEFAULT 0,
  cottage_id     BIGINT NULL REFERENCES admin_cottages(id) ON DELETE SET NULL
);

-- -----------------------------------------------------------------------------
-- 8. E-RECEIPTS & QR VERIFICATION
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS receipts (
  id             BIGSERIAL PRIMARY KEY,
  receipt_no     VARCHAR(40) NOT NULL UNIQUE,
  source_type    receipt_source NOT NULL,
  booking_id     BIGINT NULL REFERENCES bookings(id) ON DELETE SET NULL,
  walk_in_id     BIGINT NULL REFERENCES walk_in_transactions(id) ON DELETE SET NULL,
  client_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  guest_name     VARCHAR(150) NULL,
  amount_paid    NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method payment_method NOT NULL,
  qr_payload     TEXT NULL,
  qr_image_path  VARCHAR(500) NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE receipts ALTER COLUMN qr_payload TYPE TEXT;

CREATE TABLE IF NOT EXISTS qr_verifications (
  id          BIGSERIAL PRIMARY KEY,
  receipt_id  BIGINT NULL REFERENCES receipts(id) ON DELETE SET NULL,
  booking_id  BIGINT NULL REFERENCES bookings(id) ON DELETE SET NULL,
  verified_by BIGINT NOT NULL REFERENCES users(id),
  scan_result qr_result NOT NULL,
  notes       VARCHAR(255) NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 9. CLIENT NOTIFICATIONS
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notif_type notif_type NOT NULL DEFAULT 'info',
  title      VARCHAR(150) NOT NULL,
  message    TEXT NOT NULL,
  href       VARCHAR(255) NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notif_user_read ON notifications(user_id, is_read);

-- -----------------------------------------------------------------------------
-- 10. SALES SUMMARY & AUDIT
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS daily_sales_summary (
  id             BIGSERIAL PRIMARY KEY,
  sale_date      DATE NOT NULL UNIQUE,
  entrance_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  cottage_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
  online_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
  walk_in_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total    NUMERIC(12,2) NOT NULL DEFAULT 0,
  visitor_count  INTEGER NOT NULL DEFAULT 0,
  booking_count  INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  portal     portal_type NULL,
  action     VARCHAR(80) NOT NULL,
  table_name VARCHAR(80) NULL,
  record_id  VARCHAR(80) NULL,
  details    TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 11. SEED DEFAULT ACCOUNTS
-- -----------------------------------------------------------------------------
-- No demo users are inserted here.
-- Create the single admin account directly in the database, then let admin create staff accounts.
-- Client accounts are created from the sign-up page and reviewed by staff/admin.
-- -----------------------------------------------------------------------------
-- 12. VIEWS
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_active_staff AS
SELECT u.id, u.full_name, u.email, u.phone, u.status, sp.staff_code, sp.job_title, r.role_name
FROM users u
JOIN roles r ON r.id = u.role_id
LEFT JOIN staff_profiles sp ON sp.user_id = u.id
WHERE r.role_code IN ('admin','staff') AND u.status = 'active';

CREATE OR REPLACE VIEW v_pending_clients AS
SELECT u.id, u.full_name, u.email, u.phone, cp.registration_code, cp.review_status, cp.submitted_at,
       cp.gmail_verified, cp.camera_verified, cp.id_verified, cp.gmail_staff_verified
FROM users u
JOIN client_profiles cp ON cp.user_id = u.id
WHERE cp.review_status = 'pending';

CREATE OR REPLACE VIEW v_booking_overview AS
SELECT b.booking_code, b.booking_date, b.booking_status, b.payment_method, b.payment_status,
       b.total_amount, u.full_name AS client_name, u.email AS client_email,
       b.property_name, b.adults, b.children, b.seniors, b.created_at
FROM bookings b
JOIN users u ON u.id = b.client_user_id;

-- =============================================================================
-- END OF SCHEMA (PostgreSQL)
-- =============================================================================

