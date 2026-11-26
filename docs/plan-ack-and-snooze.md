# Plan: "Until acknowledged" and snooze

Status: proposed, not built.

## Why

A phone that gets a lot of notifications buries things. A reminder that matters ("Riley: take your medicine")
can arrive, buzz once, and sink under twenty others. This plan adds two related behaviours:

- **Until acknowledged.** The reminder keeps re-alerting the person every few minutes until they tap
  **Got it**. Seeing the notification doesn't count.
- **Snooze.** Any reminder can be pushed back "10 minutes from now" and alerts once more then.

Neither one creates more reminders. The schedule, the list, "Next up" and the occurrence count stay exactly as
they are. Re-alerting happens inside one delivery of one occurrence.

## Decisions

| Question | Decision |
|---|---|
| Who acknowledges a reminder sent to several people? | **Each person acknowledges their own.** Sam's tap doesn't stop Riley's alerts. Whoever set the reminder can also clear it for someone from the app ("Mark done for Riley"); that is recorded as acknowledged by them. |
| Tell the person who set it when nobody acknowledges? | **No**, not in this plan. The state is visible in the app instead. |
| Does a Home Push receipt ("shown") count as acknowledged? | **No, never.** Only a deliberate tap counts. |
| How often? | A choice per reminder: every 5, 10, **15** or 30 minutes. |
| For how long? | A choice per reminder: give up after 1 h, **4 h** or 12 h. The reminder's next occurrence also ends the previous one's alerts. |
| Interruption level | Re-alerts use the reminder's level. "Until acknowledged" can't be combined with Passive, which makes no sound, so nagging with it would be pointless. |

## Model: follow-ups live on the delivery

remindMe already has two layers. A **reminder** row holds the rule and a cursor (`next_fire_at`). A
**delivery** row is one occurrence for one person, with a snapshot of what to send. This plan gives a
delivery a second cursor of its own, the **follow-up**:

```
reminders  + ack_required        boolean  NOT NULL DEFAULT false
           + realert_every_min   smallint CHECK IN (5, 10, 15, 30)    -- NULL unless ack_required
           + realert_for_min     smallint CHECK IN (60, 240, 720)     -- NULL unless ack_required
           CHECK (ack_required = (realert_every_min IS NOT NULL) AND ack_required = (realert_for_min IS NOT NULL))
           CHECK (NOT ack_required OR level <> 'passive')

deliveries + realert_every_min   smallint      -- snapshot from the reminder when recorded; NULL = no nagging
           + follow_up_at        timestamptz   -- when to alert again; NULL = nothing pending
           + follow_up_until     timestamptz   -- when nagging gives up (snapshot: sent_at + realert_for_min)
           + follow_ups          int NOT NULL DEFAULT 0   -- re-alerts sent so far (nags and snoozes)
           + follow_up_ended     text CHECK IN ('acked', 'expired', 'superseded', 'cancelled')
           + acked_at            timestamptz
           + acked_by            int REFERENCES family_members(id)
           + ack_via             text CHECK IN ('notification', 'link', 'app')
INDEX deliveries_follow_up ON deliveries (follow_up_at) WHERE follow_up_at IS NOT NULL
```

The settings are copied onto the delivery when it's recorded, like the payload already is. An edit therefore
doesn't change the timing of alerts already running; turning "Until acknowledged" off does stop them
(see Stopping).

One cursor covers every case:

| | When the first push is marked `sent` | After each re-alert | **Snooze N min** | **Got it** |
|---|---|---|---|---|
| Normal reminder | `follow_up_at` stays NULL (today's behaviour) | `follow_up_at = NULL` | `follow_up_at = now + N` (one more alert) | Nothing to do; the notification is dismissed |
| Until acknowledged | `follow_up_at = sent_at + every`, `follow_up_until = sent_at + for` | `follow_up_at = now + every`, or ends `expired` once that passes `follow_up_until` | `follow_up_at = now + N`; nagging resumes after that alert | `acked_at = now`, `follow_up_at = NULL`, ended `acked` |

Snooze always gets its one alert, even past `follow_up_until`. After it, nagging continues only while it's
before `follow_up_until`.

## Dispatcher

### Step 3 of each pass: follow-ups

A third step runs after "record due" and "send pending", inside the same 45-second budget.

**Claim.** One statement claims due follow-ups and moves each cursor on, so two dispatchers can never send
the same re-alert:

```sql
UPDATE deliveries d
   SET follow_ups = d.follow_ups + 1,
       follow_up_at = CASE
         WHEN d.realert_every_min IS NULL THEN NULL                                     -- a snooze: one alert
         WHEN $now + make_interval(mins => d.realert_every_min) > d.follow_up_until THEN NULL
         ELSE $now + make_interval(mins => d.realert_every_min) END,
       follow_up_ended = CASE
         WHEN d.realert_every_min IS NOT NULL
          AND $now + make_interval(mins => d.realert_every_min) > d.follow_up_until THEN 'expired'
         ELSE d.follow_up_ended END,
       updated_at = now()
  FROM (SELECT id FROM deliveries
         WHERE follow_up_at <= $now AND acked_at IS NULL AND status = 'sent'
         ORDER BY follow_up_at, id LIMIT 10
         FOR UPDATE SKIP LOCKED) pick
 WHERE d.id = pick.id
RETURNING d.*
```

`expired` is set as the last alert is claimed: that alert still goes out, and no further ones are scheduled.

**Send.** The same send path as a delivery (`sendImpl`), with a follow-up payload (below). Before sending,
check the same things `sendOne` checks (reminder deleted, member archived); a cancelled one ends
`cancelled` instead.

**No retry.** A failed re-alert isn't retried; the next one is the retry. The failure goes on the member's
channel (`last_error`) as today, so the People page shows a broken key. This keeps follow-ups out of the
back-off and give-up machinery.

### Rules the dispatcher must keep

- **Nagging starts only once the first push is `sent`.** `sendBrrr` sets `follow_up_at` and
  `follow_up_until` in the same `finish()` that marks it sent, and only for a delivery with
  `realert_every_min`. While the first push is failing and retrying, back-off owns it, and the two never stack.
- **A new idempotency key for every alert.** Every attempt at a delivery sends
  `Idempotency-Key: remind-me-<send_key>` today. A gateway that honours it (Home Push) would answer re-alert
  #2 "already sent" and never deliver it. Re-alerts send `remind-me-<send_key>-f<follow_ups>`, where
  `follow_ups` is the value just claimed.
- **No burst after downtime.** A cursor found overdue moves to `now + every`, not `+ every` from where it was,
  so one alert goes out, not a backlog.
- **Re-alert times aren't on the quarter hour.** The quarter-hour rule is for scheduled times, not re-alerts.
- **The next occurrence takes over.** When `recordDue` records a new occurrence of a reminder, the open
  follow-ups of its older deliveries (every member) end `superseded`. This is the same rule it already applies
  to older deliveries still retrying. One reminder never has two nag loops for the same person.

### Stopping

| Event | Effect on open follow-ups |
|---|---|
| Got it (the person, or the creator for them) | that delivery: `acked` |
| `follow_up_until` passes | that delivery: `expired` (shown as "not acknowledged") |
| The reminder's next occurrence is recorded | older deliveries: `superseded` |
| The reminder is deleted, or edited with "Until acknowledged" turned off | all its deliveries: `cancelled` |
| The member is archived | caught at send time: `cancelled` |

An acknowledgement that arrives while a re-alert is in flight can't recall it; at most one extra alert goes out.

### Pruning

Unchanged. Deliveries with follow-ups are `sent` rows and are pruned with the rest after `RETENTION_DAYS`.

## What a re-alert says

It uses the delivery's payload (same title, same `thread_id`, same level) with a new message, for example:

```
Still waiting · was due 9:00 AM · alert 3
Snoozed · was due 9:00 AM
```

The wording stays deterministic, built in `lib/brrr.js` like the rest.

## Acknowledging and snoozing

### Token

Each delivery has an action token: `<delivery id>.<HMAC-SHA256(ack_key, 'ack:' + send_key)>`, cut to 128 bits
and base64url-encoded. `ack_key` is a random key in `app_config`, created at startup if missing. Nothing
per delivery is stored. The token is derived when a push is built and checked by recomputing it. Rotating
`ack_key` revokes every outstanding token.

A token can do exactly three things to that one delivery: show it, acknowledge it, snooze it. It acts as the
delivery's own member (per-person acknowledgement). Once follow-ups have ended, it answers "already done"
and changes nothing.

The token never goes in a URL path or query string (both get logged), a log line, or an API response other
than to its holder.

### Endpoints

| Route | Who | Does |
|---|---|---|
| `POST /api/ack` `{ token, action: 'peek' \| 'ack' \| 'snooze', minutes? }` | Anyone holding the token (no session needed) | Peek returns the reminder's title, time and follow-up state. Ack and snooze act as the delivery's member. Snooze takes 10, 30 or 60 minutes. |
| `POST /api/deliveries/:id/ack` | The delivery's member, or the reminder's creator | Got it from the app. `acked_by` is the viewer. |
| `POST /api/deliveries/:id/snooze` `{ minutes }` | The delivery's member | Snooze from the app. |
| `GET /ack` | Open page | The tap-through page (below). Shows nothing without a token. |

`GET /api/reminders` gains a `waiting` list for the viewer: their own deliveries with follow-ups still open or
expired in the last 12 hours, newest first. The per-recipient `deliveries` on each reminder gain `acked_at`,
`follow_up_at`, `follow_ups` and `follow_up_ended`, so the creator sees "Riley: waiting, 3 alerts".

### Tailnet mode

In tailnet mode every write must be JSON from the app's own origin (`suite.guard`), and every request needs a
linked household member (`suite.requireMember`). A background POST from Home Push carries no browser origin.
It may also come from a device whose identity isn't linked to the member the delivery is for.

- `POST /api/ack` is authorised by its token alone. It is added to `OPEN_PATHS` and passed around
  `suite.guard` by an exact-path check in `lib/app.js`. It must read no ambient identity (no `viewerOf`).
  The guard is there because ambient identity rides on every request like a cookie; a route that ignores
  identity and needs a secret in the body is not exposed to that.
- `GET /ack` is added to `OPEN_PATHS` too, so a tap-through works on a phone not yet linked.
- `/api/deliveries/:id/ack` and `/snooze` go through the gate as normal and are added to `KID_ROUTES`: kids
  acknowledge their own reminders.
- The `/api` JSON check already accepts a native client, which sends JSON and no `Sec-Fetch-Site`.

## Phase 1: remindMe only (works with any brrr-compatible service)

### Composer

Under **Alert**, a toggle: **Until acknowledged**, off by default. On, it shows:

- *Re-alert every*: 5 / 10 / **15** / 30 min
- *Give up after*: 1 h / **4 h** / 12 h

Turning it on while Passive is selected switches the level to the default (Urgent). The summary line says it
plainly: *"9:00 AM every day · re-alerts every 15 min until Riley taps Got it."* Suggestions remember the
setting along with the level.

### Home screen: "Waiting on you"

A card above Next up, listing the viewer's open deliveries:

```
┌ Waiting on you ─────────────────────────────┐
│ Take your medicine        due 9:00 · alert 3 │
│ [ Got it ]                   [ Snooze ▾ ]    │
└──────────────────────────────────────────────┘
```

A normal reminder that was snoozed shows here too ("Snoozed until 9:40"), with Got it to drop the pending
alert. Expired ones stay for 12 hours, marked "Not acknowledged", with a Got it that only records the
acknowledgement.

### Reminder list and recent deliveries

Each reminder with "Until acknowledged" shows a small chip. For the latest occurrence, each recipient shows
one of: *Waiting · 3 alerts*, *Got it 9:12*, *Not acknowledged*. The creator gets **Mark done for Riley** on a
waiting recipient.

### Tap-through page

For deliveries with "Until acknowledged", the push's `open_url` is the ack page, with the token in the
fragment: `<APP_PUBLIC_URL>ack#t=<token>`. A fragment never reaches the server, so the token isn't in any
access log. The page reads it, POSTs `peek`, and shows the reminder with big **Got it** and **Snooze**
buttons. Loading the page never acknowledges anything: a link preview or prefetch can't press Got it for you.

This needs `APP_PUBLIC_URL`. Without it, no tap link is sent and the app's "Waiting on you" card is the way
to acknowledge. `TAP_OPENS_APP` is unchanged for other reminders.

## Phase 2: Home Push action buttons

Phase 1 means opening a page. Phase 2 puts **Got it** and **Snooze 10 min** on the notification itself
(long-press, or swipe on the lock screen), on the Watch too.

### What remindMe sends

Only when `PUSH_ACTIONS=true` (off by default, since brrr doesn't know these fields):

```json
{
  "collapse_id": "remind-me-<send_key>",
  "category": "remind-me.ack",
  "action_callback": { "url": "<APP_PUBLIC_URL>api/ack", "token": "<token>" }
}
```

- `category`: `remind-me.ack` (Got it + Snooze 10 min) for "Until acknowledged", `remind-me.snooze`
  (Snooze 10 min) for the rest.
- `collapse_id` is the same on the first push and every re-alert of a delivery. Each alert **replaces** the
  last one in Notification Center and still sounds. You see one notification re-alerting, not eight copies.

### Home Push gateway (separate repo)

- Pass `collapse_id` through as the `apns-collapse-id` header (64 bytes max), outside the encrypted envelope.
- Carry `category` and `action_callback` inside the encrypted envelope, so the token is end-to-end encrypted.
- Validate: `category` from the known list, `action_callback.url` https only.

### Home Push app (separate repo, needs a TestFlight build)

- At launch, register the categories: a fixed set built into the app. A new category needs an app build.
- The NSE sets `categoryIdentifier` from the decrypted payload.
- An action button runs in the background (no `.foreground`): POST `{ token, action }` to the callback URL,
  then complete. It only posts to https URLs on hosts the household knows (from the Home Base household
  manifest), so a payload can't make the phone post anywhere else.
- **It fails safe.** If the POST fails (off the tailnet, server down), the app posts a local notification:
  "Couldn't reach Remind Me. Open it to tap Got it." The server never heard the acknowledgement, so the
  re-alerts keep coming. A failure means more alerts, never a silent acknowledgement.

## Not in this plan

- Telling the creator when nobody acknowledges (decided against for now).
- Clearing a notification that's still on the phone after Got it was tapped in the app or on another device.
  This would need a silent push to remove it; with `collapse_id` there is at most one left over.
- Alert intervals that tighten over time (15 min, then 5).
- Quick-entry wording ("until I say got it").
- Quiet hours. The give-up time is the bound: at most 12 hours of alerts.

## Delivery plan

Each PR is kept to a few files.

| # | Repo | Contents | Files |
|---|---|---|---|
| 1 | remindMe | Migration `0006`, dispatcher step 3 + start/supersede rules, re-alert wording, token helpers (`lib/acks.js`); dispatcher tests | migration, `lib/dispatcher.js`, `lib/brrr.js`, `lib/acks.js`, 2 test files |
| 2 | remindMe | Validation and storage of the reminder settings, edit/delete cancelling, the endpoints, the `waiting` list, tailnet routes | `lib/reminders.js`, `lib/app.js`, `lib/suite-identity.js`, 2 test files |
| 3 | remindMe | Composer toggle, "Waiting on you" card, list chips, ack page | `public/index.html`, `public/app.js`, `public/remind-skin.css`, `public/ack.html`, `public/ack.js` |
| 4 | homePush | Gateway: `collapse_id`, `category`, `action_callback` | `gateway/lib/payload.js`, `gateway/lib/apns.js`, tests |
| 5 | homePush | App: categories, NSE category, background action, fail-safe notice | iOS files; TestFlight build |
| 6 | remindMe | `PUSH_ACTIONS` payload fields | `lib/brrr.js`, `lib/dispatcher.js`, README, tests |

PR 1 changes nothing on its own: no reminder can have "Until acknowledged" until PR 2. Phase 1 (1–3) is
useful by itself. PRs 4 and 5 ship before 6, so a gateway that doesn't know the new fields never receives them.

## Tests that must exist

- Two concurrent passes never send the same re-alert (the claim), and never two for one cursor position.
- Nagging doesn't start before the first push is `sent`. A first push that fails and gives up never nags.
- Every re-alert's Idempotency-Key differs from the first push's and from each other's.
- After a long stop, an overdue cursor sends one alert, not several.
- The last alert before `follow_up_until` is sent and marks the delivery `expired`; nothing after it.
- A new occurrence supersedes the old delivery's follow-ups for every member.
- Delete, and editing "Until acknowledged" off, cancel open follow-ups. Other edits don't change running ones.
- Snooze on a normal reminder sends exactly one more alert. Snooze past `follow_up_until` still sends its alert.
- Per-person: Sam's Got it leaves Riley's alerts running. The creator's "Mark done for Riley" stops them and
  records the creator.
- The token works only for its delivery, does nothing once follow-ups end, and is rejected after `ack_key`
  rotates. A token for one install doesn't work on another.
- Tailnet mode: `POST /api/ack` works with no origin and no identity headers; every other write still needs
  both. A kid can acknowledge their own delivery from the app.
- `GET /ack` never acknowledges.
- UI: check the composer, the card and the ack page at 390 px in WebKit, as the repo's rules require.
