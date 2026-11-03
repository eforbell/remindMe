-- Optional push mirror: a copy of every push to a second brrr-compatible gateway (PUSH_MIRROR_URL),
-- for running a self-hosted gateway side by side with brrr before relying on it. brrr stays the
-- delivery of record: the mirror never changes a delivery's status, retries or timing.

-- One mirror key per member, set from the People page. Like the brrr key, never selected into a response.
CREATE TABLE member_mirror_channels (
  member_id      INT PRIMARY KEY REFERENCES family_members(id) ON DELETE CASCADE,
  target_secret  TEXT NOT NULL,
  last_ok_at     TIMESTAMPTZ,
  last_error     TEXT,
  last_error_at  TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each delivery is mirrored at most once. mirror_claimed_at is the claim (set by a conditional UPDATE),
-- the rest is the outcome: the gateway's HTTP status and message id, or the error.
ALTER TABLE deliveries
  ADD COLUMN mirror_claimed_at TIMESTAMPTZ,
  ADD COLUMN mirror_done_at    TIMESTAMPTZ,
  ADD COLUMN mirror_status     INT,
  ADD COLUMN mirror_id         TEXT,
  ADD COLUMN mirror_error      TEXT;
