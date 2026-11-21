-- A random key per delivery, sent as Idempotency-Key on every attempt at it, so a gateway that honors the
-- header (Home Push) answers a retry "already sent" instead of pushing again. Random rather than the row id:
-- ids repeat across installs (a dev copy and the real one sharing a person's secret), and the gateway would
-- take a different install's reminder for a retry and never send it.

-- Adding a column with a random default rewrites deliveries under an exclusive lock. The table is small
-- (RETENTION_DAYS), but fail fast rather than queue live delivery traffic behind a long wait; the migration
-- is retried at the next start.
SET LOCAL lock_timeout = '5s';

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS send_key UUID NOT NULL DEFAULT gen_random_uuid();
