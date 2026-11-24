-- ═══════════════════════════════════════════════
--  BugBeat — sign-up verification limits
--  Adds the counters behind the 5-attempt limit on emailed codes.
--  Run once on the local database (phpMyAdmin) and on Aiven (HeidiSQL),
--  BEFORE pushing the new server.js.
-- ═══════════════════════════════════════════════

ALTER TABLE email_verifications
  ADD COLUMN send_count   INT      NOT NULL DEFAULT 1 AFTER attempts,
  ADD COLUMN locked_until DATETIME NULL              AFTER send_count;
