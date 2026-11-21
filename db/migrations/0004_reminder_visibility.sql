-- Who sees a reminder. 'private' (the default): only the person who set it and the people it reminds.
-- 'family': everyone in the household sees it coming, but only the people it reminds get the push.
-- Existing reminders become private, so after this each person sees only their own.

-- A brief exclusive lock on reminders and suggestions, which the dispatcher reads: fail fast rather than
-- queue live traffic behind it (the migration is retried at the next start).
SET LOCAL lock_timeout = '5s';

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family'));

-- Suggestions are kept per author and offered back only to them, so a private reminder's text doesn't turn
-- up in someone else's composer, and two people using the same text keep their own. author 0: nobody known
-- (rows from before this, or a phone that hasn't said who it is), offered to the people it last reminded.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS author INT NOT NULL DEFAULT 0;
ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_pkey;
ALTER TABLE suggestions ADD PRIMARY KEY (author, key);
