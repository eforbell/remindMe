-- Suite identity (Home Base Feature-10): the household member each Remind Me person is, in tailnet mode.
-- A parent links them once on the link page. Unique: one household member is one person here.
-- Unused in local mode, and kept when an app switches back, so switching to tailnet again keeps the links.

-- A brief exclusive lock on family_members, which the dispatcher reads: fail fast rather than queue behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE family_members ADD COLUMN IF NOT EXISTS suite_member_id TEXT UNIQUE;
