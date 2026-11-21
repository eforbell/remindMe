-- Who sees a reminder. 'private' (the default): only the person who set it and the people it reminds.
-- 'family': everyone in the household sees it coming, but only the people it reminds get the push.
-- Existing reminders become private, so after this each person sees only their own.

-- A brief exclusive lock on reminders and suggestions, which the dispatcher reads: fail fast rather than
-- queue live traffic behind it (the migration is retried at the next start).
SET LOCAL lock_timeout = '5s';

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family'));

-- Suggestions are offered back to who wrote them (and to the people they reminded), so a private reminder's
-- text doesn't turn up in someone else's composer. Rows from before this have no author: they're offered to
-- the people they last reminded.
ALTER TABLE suggestions
  ADD COLUMN IF NOT EXISTS created_by INT REFERENCES family_members(id);
