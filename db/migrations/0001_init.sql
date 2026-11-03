-- Remind Me: initial schema.
--
-- A reminder is ONE row however often it repeats: its rule plus a cursor (next_fire_at). The dispatcher
-- picks up rows whose cursor is due, records one delivery per recipient, and moves the cursor on.
-- Nothing in the future is stored ahead of time.

CREATE TABLE family_members (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX family_members_name_live ON family_members (lower(btrim(name))) WHERE archived_at IS NULL;

-- One brrr key per member. A member without one cannot be picked as a recipient.
CREATE TABLE member_notification_channels (
  member_id      INT PRIMARY KEY REFERENCES family_members(id) ON DELETE CASCADE,
  channel_type   TEXT NOT NULL DEFAULT 'brrr' CHECK (channel_type = 'brrr'),
  target_secret  TEXT NOT NULL,
  last_ok_at     TIMESTAMPTZ,
  last_error     TEXT,
  last_error_at  TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reminders (
  id                    SERIAL PRIMARY KEY,
  text                  TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 120),
  level                 TEXT NOT NULL CHECK (level IN ('passive', 'active', 'time-sensitive', 'critical')),
  created_by            INT REFERENCES family_members(id),
  -- The schedule, in household wall-clock terms.
  timezone              TEXT NOT NULL,
  start_date            DATE NOT NULL,
  time_of_day           TIME NOT NULL CHECK (
                          EXTRACT(MINUTE FROM time_of_day)::int % 15 = 0 AND EXTRACT(SECOND FROM time_of_day) = 0
                        ),
  freq                  TEXT NOT NULL CHECK (freq IN ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  repeat_every          INT NOT NULL DEFAULT 1 CHECK (repeat_every BETWEEN 1 AND 99),
  weekdays              SMALLINT[] CHECK (weekdays IS NULL OR (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[])),
  max_occurrences       INT CHECK (max_occurrences IS NULL OR max_occurrences BETWEEN 1 AND 100000),
  extend_by             INT NOT NULL DEFAULT 1 CHECK (extend_by BETWEEN 1 AND 1000),
  -- The cursor: how many occurrences have passed, and the next one (NULL once the series is over).
  fired_count           INT NOT NULL DEFAULT 0,
  next_fire_date        DATE,
  next_fire_at          TIMESTAMPTZ,
  last_fired_at         TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'deleted')),
  renewal_dismissed_at  TIMESTAMPTZ,
  version               INT NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at              TIMESTAMPTZ,
  CHECK ((freq = 'weekly') = (weekdays IS NOT NULL)),
  CHECK (freq <> 'once' OR max_occurrences = 1),
  CHECK (status <> 'active' OR (next_fire_at IS NOT NULL AND next_fire_date IS NOT NULL))
);
CREATE INDEX reminders_due ON reminders (next_fire_at) WHERE status = 'active';

CREATE TABLE reminder_recipients (
  reminder_id  INT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  member_id    INT NOT NULL REFERENCES family_members(id),
  PRIMARY KEY (reminder_id, member_id)
);
CREATE INDEX reminder_recipients_member ON reminder_recipients (member_id);

-- One row per (occurrence, recipient). The unique key makes recording an occurrence idempotent, and the
-- row carries a snapshot of what to send, so retries do not depend on later edits.
CREATE TABLE deliveries (
  id               BIGSERIAL PRIMARY KEY,
  reminder_id      INT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  occurrence_no    INT NOT NULL,
  member_id        INT NOT NULL REFERENCES family_members(id),
  scheduled_for    TIMESTAMPTZ NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'missed', 'cancelled')),
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  claimed_at       TIMESTAMPTZ,
  give_up_at       TIMESTAMPTZ NOT NULL,
  sent_at          TIMESTAMPTZ,
  response_status  INT,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, occurrence_no, member_id)
);
CREATE INDEX deliveries_work ON deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX deliveries_recent ON deliveries (scheduled_for DESC);

-- What people have scheduled before, for suggestions while typing. One row per distinct text.
CREATE TABLE suggestions (
  key                  TEXT PRIMARY KEY,
  text                 TEXT NOT NULL,
  use_count            INT NOT NULL DEFAULT 1,
  last_used_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_time_of_day     TIME,
  last_level           TEXT,
  last_repeat          JSONB,
  last_recipient_ids   INT[]
);
