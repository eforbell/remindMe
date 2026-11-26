-- "Until acknowledged" and snooze (docs/plan-ack-and-snooze.md).
--
-- A reminder can re-alert each recipient every few minutes until they tap Got it. Re-alerts and snoozes are
-- follow-up alerts of one occurrence's delivery to one person: they never add occurrences, so the schedule,
-- the list and the counts are unchanged.
--
-- Every alert is a delivery row. alert_no = 0 is the delivery itself (the first push); it also carries the
-- acknowledgement state and the follow-up cursor. alert_no >= 1 rows are follow-up alerts, ordinary sendable
-- rows with their own send_key, retries and give-up time.

-- Brief exclusive locks on reminders and deliveries, which the dispatcher reads every minute: fail fast rather
-- than queue live traffic behind a long wait; the migration is retried at the next start.
SET LOCAL lock_timeout = '5s';

ALTER TABLE reminders
  ADD COLUMN ack_required       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN realert_every_min  SMALLINT CHECK (realert_every_min IN (5, 10, 15, 30)),
  ADD COLUMN realert_for_min    SMALLINT CHECK (realert_for_min IN (60, 240, 720)),
  ADD CONSTRAINT reminders_ack_every CHECK (ack_required = (realert_every_min IS NOT NULL)),
  ADD CONSTRAINT reminders_ack_for   CHECK (ack_required = (realert_for_min IS NOT NULL)),
  -- Passive makes no sound, so nagging with it would be pointless.
  ADD CONSTRAINT reminders_ack_level CHECK (NOT ack_required OR level <> 'passive');

ALTER TABLE deliveries
  ADD COLUMN alert_no           SMALLINT NOT NULL DEFAULT 0 CHECK (alert_no >= 0),
  ADD COLUMN alert_kind         TEXT CHECK (alert_kind IN ('nag', 'snooze')),         -- follow-up alerts only
  -- The rest are used on the delivery (alert_no = 0) only.
  ADD COLUMN realert_every_min  SMALLINT,      -- snapshot from the reminder when recorded
  ADD COLUMN realert_for_min    SMALLINT,      -- snapshot from the reminder when recorded
  ADD COLUMN follow_up_at       TIMESTAMPTZ,   -- when the next follow-up alert is due; NULL = none
  ADD COLUMN follow_up_kind     TEXT CHECK (follow_up_kind IN ('nag', 'snooze')),
  ADD COLUMN follow_up_until    TIMESTAMPTZ,   -- no nag is created after this
  ADD COLUMN follow_up_horizon  TIMESTAMPTZ,   -- no alert of any kind is created after this
  ADD COLUMN follow_ups         INT NOT NULL DEFAULT 0,  -- highest alert_no created so far
  ADD COLUMN snoozed_from       INT,           -- the alert_no a pending snooze was asked from
  -- Final: acked, superseded, cancelled (nothing reopens them). Soft: expired (a final reason replaces it).
  ADD COLUMN follow_up_ended    TEXT CHECK (follow_up_ended IN ('acked', 'expired', 'superseded', 'cancelled')),
  ADD COLUMN acked_at           TIMESTAMPTZ,
  ADD COLUMN acked_by           INT REFERENCES family_members(id),
  ADD COLUMN ack_via            TEXT CHECK (ack_via IN ('notification', 'link', 'app')),
  ADD CONSTRAINT deliveries_alert_kind CHECK (alert_no = 0 OR alert_kind IS NOT NULL),
  ADD CONSTRAINT deliveries_realert_pair CHECK ((realert_every_min IS NULL) = (realert_for_min IS NULL)),
  -- An endless loop can't be stored: a pending nag always has a deadline, every pending follow-up a horizon.
  ADD CONSTRAINT deliveries_follow_up_bounded CHECK (follow_up_at IS NULL OR (follow_up_kind IS NOT NULL AND follow_up_horizon IS NOT NULL)),
  ADD CONSTRAINT deliveries_nag_deadline CHECK (follow_up_kind IS DISTINCT FROM 'nag' OR follow_up_until IS NOT NULL);

ALTER TABLE deliveries DROP CONSTRAINT deliveries_reminder_id_occurrence_no_member_id_key;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_alert_key UNIQUE (reminder_id, occurrence_no, member_id, alert_no);

-- A token names its delivery by send_key, so it must be unique.
CREATE UNIQUE INDEX deliveries_send_key ON deliveries (send_key);
CREATE INDEX deliveries_follow_up ON deliveries (follow_up_at) WHERE follow_up_at IS NOT NULL;

-- The key that signs action tokens (lib/acks.js). Created here, before either dispatcher starts, so two
-- processes can never each create one. 244 random bits from pg_strong_random. Rotating it (one UPDATE of this
-- row) kills every outstanding token; those deliveries can still be acknowledged in the app.
INSERT INTO app_config (key, value)
VALUES ('ack_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (key) DO NOTHING;
