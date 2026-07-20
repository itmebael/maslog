-- =============================================================================
-- Supabase RLS for Maslog Cold Spring
-- Run in Supabase SQL Editor after maslog_cold_spring.sql
-- =============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','users','login_sessions','staff_profiles','id_types','client_profiles',
    'email_otps','admin_entrance_fees','admin_cottages','system_settings',
    'property_types','staff_properties','staff_property_photos','partnership_fees',
    'gcash_settings','booking_settings','unavailable_dates','bookings',
    'booking_line_items','walk_in_transactions','walk_in_items','receipts',
    'qr_verifications','notifications','daily_sales_summary','audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS maslog_anon_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY maslog_anon_all ON %I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;

-- Allow large base64 images (selfies, IDs, QR, photos)
ALTER TABLE client_profiles ALTER COLUMN selfie_path TYPE TEXT;
ALTER TABLE client_profiles ALTER COLUMN valid_id_path TYPE TEXT;
ALTER TABLE gcash_settings ALTER COLUMN qr_image_path TYPE TEXT;
ALTER TABLE partnership_fees ALTER COLUMN logo_path TYPE TEXT;
ALTER TABLE staff_property_photos ALTER COLUMN photo_path TYPE TEXT;
ALTER TABLE system_settings ALTER COLUMN logo_path TYPE TEXT;

