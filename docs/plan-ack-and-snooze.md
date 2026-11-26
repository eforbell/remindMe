# Plan: "Until acknowledged" and snooze

Status: proposed, not built. Revised after Codex review rounds 1–3 (see the end).

## Why

A phone that gets a lot of notifications buries things. A reminder that matters ("Riley: take your medicine")
can arrive, buzz once, and sink under twenty others. This plan adds two related behaviours:

- **Until acknowledged.** The reminder keeps re-alerting the person every few minutes until they tap
  **Got it**. Seeing the notification doesn't count.
- **Snooze.** Any reminder can be pushed back "10 minutes from now" and alerts once more then.

Neither one creates more reminders. The schedule, the list, "Next up" and the occurrence count stay exactly as
they are. Re-alerting happens inside one occurrence's delivery to one person.

## Decisions

| Question | Decision |
|---|---|
| Who acknowledges a reminder sent to several people? | **Each person acknowledges their own.** Sam's tap doesn't stop Riley's alerts. Whoever set the reminder can also clear it for someone from the app ("Mark done for Riley"); that is recorded as acknowledged by them. |
| Tell the person who set it when nobody acknowledges? | **No**, not in this plan. The state is visible in the app instead. |
| Does a Home Push receipt ("shown") count as acknowledged? | **No, never.** Only a deliberate tap counts. |
| How often? | A choice per reminder: every 5, 10, **15** or 30 minutes. |
| For how long? | A choice per reminder: give up after 1 h, **4 h** or 12 h. The reminder's next occurrence also ends the previous one's alerts. |
| Interruption level | Re-alerts use the reminder's level. "Until acknowledged" can't be combined with Passive, which makes no sound, so nagging with it would be pointless. |

## Model

### Every alert is a delivery row

Today a **delivery** row is one occurrence for one person: a snapshot of what to send, plus the claim, retry,
back-off and give-up machinery, and a random `send_key` used as the Idempotency-Key.

This plan reuses that machinery for every alert. A new column `alert_no` numbers the alerts of one occurrence
for one person:

- **`alert_no = 0`** is the delivery as it is today: the first push. It also carries the acknowledgement
  state and the follow-up cursor. The rest of this plan calls it **the delivery**.
- **`alert_no ≥ 1`** is a **follow-up alert**: a re-alert or a snooze alert. It is an ordinary sendable row.
  It has its own `send_key`, so every alert has its own Idempotency-Key. It has its own retries, its own
  short give-up time, and a fresh payload with its own expiry.

This means an alert is never lost by being "claimed" before it's sent. A follow-up alert exists as a row before
anything tries to send it. A dispatcher that dies mid-send leaves a `sending` row that the other dispatcher
reclaims after `CLAIM_STALE_MS`, with the same key. A failure is retried like any delivery. An alert that fails
for good is a `failed` row, which the problems list shows.

### Columns

```
reminders  + ack_required        boolean  NOT NULL DEFAULT false
           + realert_every_min   smallint CHECK IN (5, 10, 15, 30)
           + realert_for_min     smallint CHECK IN (60, 240, 720)
           CHECK (ack_required = (realert_every_min IS NOT NULL))
           CHECK (ack_required = (realert_for_min IS NOT NULL))
           CHECK (NOT ack_required OR level <> 'passive')

deliveries + alert_no            smallint NOT NULL DEFAULT 0
           + alert_kind          text CHECK IN ('nag', 'snooze')        -- follow-up alerts only
           -- The rest are used on the delivery (alert_no = 0) only:
           + realert_every_min   smallint      -- snapshot from the reminder when recorded
           + realert_for_min     smallint      -- snapshot from the reminder when recorded
           + follow_up_at        timestamptz   -- when the next follow-up alert is due; NULL = none
           + follow_up_kind      text CHECK IN ('nag', 'snooze')
           + follow_up_until     timestamptz   -- no nag is created after this
           + follow_up_horizon   timestamptz   -- no alert of any kind is created after this
           + follow_ups          int NOT NULL DEFAULT 0   -- highest alert_no created so far
           + snoozed_from        int           -- the alert_no a pending snooze was asked from
           + follow_up_ended     text CHECK IN ('acked', 'expired', 'superseded', 'cancelled')
           + acked_at            timestamptz
           + acked_by            int REFERENCES family_members(id)
           + ack_via             text CHECK IN ('notification', 'link', 'app')
CHECK (alert_no = 0 OR alert_kind IS NOT NULL)
CHECK ((realert_every_min IS NULL) = (realert_for_min IS NULL))
CHECK (follow_up_at IS NULL OR (follow_up_kind IS NOT NULL AND follow_up_horizon IS NOT NULL))
CHECK (follow_up_kind IS DISTINCT FROM 'nag' OR follow_up_until IS NOT NULL)
UNIQUE (reminder_id, occurrence_no, member_id)
    → UNIQUE (reminder_id, occurrence_no, member_id, alert_no)
UNIQUE INDEX deliveries_send_key ON deliveries (send_key)
INDEX deliveries_follow_up ON deliveries (follow_up_at) WHERE follow_up_at IS NOT NULL
```

Both settings are copied onto the delivery when it's recorded, like the payload already is. An edit therefore
doesn't change the timing of a loop already running. Turning "Until acknowledged" off does stop it (see
Stopping).

The CHECKs make an endless loop impossible to store: a pending nag always has a deadline, and every pending
follow-up has a horizon.

### Deadlines

They are set from a start time `t0`, by whichever comes first: the first push being marked `sent`
(`t0 = sent_at`), or a snooze arriving before that (`t0 = now`; the phone can show the push before the push
service has answered). Each is written with `COALESCE`, so the second never moves them.

- `follow_up_until = t0 + realert_for_min`. No nag is created after it.
- `follow_up_horizon` is the hard stop for snoozes too:
  - with "Until acknowledged": `follow_up_until + 60 min`
  - otherwise: `t0 + 12 h`

A snooze can't land past the horizon; a longer one is shortened to it. Repeated snoozes can't push a delivery
past it either.

The horizon only limits **creating** alerts. Once an alert exists, it always has at least 15 minutes to
be sent (see step 2), so an alert created at the horizon can still go out.

### Ending reasons

`follow_up_ended` has two kinds of value:

- **Final:** `acked`, `superseded`, `cancelled`. Nothing reopens it.
- **Soft:** `expired`. A final reason can still replace it, so a Got it, a removed recipient or a newer
  occurrence is still recorded truthfully.

Every stop writes
`follow_up_ended = CASE WHEN follow_up_ended IN ('acked','superseded','cancelled') THEN follow_up_ended ELSE $reason END`.
Snooze applies only while `follow_up_ended IS NULL`, so an expired delivery is never reopened; it can only be
acknowledged late.

## Lifecycle

### 1. First push sent: arming

When the delivery (`alert_no = 0`) is marked `sent`, the same UPDATE sets the deadlines (`COALESCE`, see
Deadlines). If it has `realert_every_min`, it also arms the first nag, but only if nothing stopped it in the
meantime, and no snooze already set the cursor:

```sql
follow_up_at   = CASE WHEN realert_every_min IS NOT NULL AND acked_at IS NULL AND follow_up_ended IS NULL
                       AND follow_up_at IS NULL
                      THEN $sent + make_interval(mins => realert_every_min) ELSE follow_up_at END,
follow_up_kind = CASE WHEN … (same condition) THEN 'nag' ELSE follow_up_kind END
```

This is a separate `finishDelivery()`, not a change to the generic `finish()`. Got it, supersession and
cancellation write `acked_at` and `follow_up_ended` on the delivery **whatever its status**. A Got it that
arrives while the first push is still `sending` (the phone got it before the gateway answered), or `pending`
after a timeout, is therefore recorded, and arming honours it. The same goes for a newer occurrence or an edit
that lands during the send.

### 2. Each pass: creating follow-up alerts

A new step runs between "record due" and "send pending". It runs in one transaction per batch:

```sql
SELECT d.* FROM deliveries d
  JOIN reminders r ON r.id = d.reminder_id
  JOIN family_members m ON m.id = d.member_id
 WHERE d.alert_no = 0 AND d.follow_up_at <= $now AND d.acked_at IS NULL AND d.follow_up_ended IS NULL
 ORDER BY d.follow_up_at, d.id LIMIT 25
 FOR UPDATE OF d SKIP LOCKED
 FOR KEY SHARE OF r, m SKIP LOCKED
```

**Lock order.** Inserting a follow-up alert takes foreign-key locks on its reminder and member. Delete
(`lockActive`) holds the reminder and then waits for the delivery; archive does the same through the member.
Locking the delivery first and then waiting on the reminder would deadlock against them. This SELECT takes
all three row locks at once with `SKIP LOCKED`, so it never waits on a row lock (ordinary table-level locks
are still taken as usual): a delivery whose reminder is being deleted is skipped until next pass. The insert's foreign-key checks then find locks this transaction already holds.
Everything else keeps the order reminder → member → delivery → its follow-up alerts. Got it and snooze lock
the delivery, then its alerts.

For each row:

1. **Too late?** If `$now > follow_up_horizon`, or this is a nag and `$now > follow_up_until`: end it
   `expired` with no alert. After downtime, a nag that is past its deadline is never sent late.
2. **Otherwise create the alert.** `alert_no = follow_ups + 1`, `alert_kind = follow_up_kind`, `pending`, due
   now. Its payload is built fresh (wording below). Its `give_up_at` is `now + max(15, every) min` for a nag and
   `now + 30 min` for a snooze, and its `expiration_date` equals that `give_up_at`.
   - The window is at least 15 minutes, so no alert is created already expired.
   - A claim left by a dispatcher that died is recovered by whichever comes first: the stale-claim sweep
     (after `CLAIM_STALE_MS`, 5 min, still inside the window), or the next alert, which replaces it (step 3).
     With a 5-minute interval the next alert usually wins. The last alert has no successor, so the sweep
     recovers it.
   - The horizon doesn't shorten it.

   `ON CONFLICT DO NOTHING` on the new unique key.
3. **Older alerts not yet sent (`pending` or `sending`) go `missed`** ("a newer alert was due"), so a retrying
   alert never lands after its successor. A `sending` row moved to `missed` can't be finished by the worker
   holding it (`finish()` requires `sending`), and is never reclaimed.
4. **Move the cursor on:**
   - `follow_ups = alert_no`
   - With "Until acknowledged", the next nag is due at `$now + every`; once that would pass
     `follow_up_until`, the cursor is cleared and the delivery is marked `expired`. Expiry only stops new
     alerts. The alert just created, the last one, is left to send within its own window (see Stopping).
   - After a snooze on a normal reminder, the cursor is simply cleared, so a later snooze is still possible.
   - Moving from `$now`, not from the old cursor, means one alert after downtime, not a burst.

Creating the alert and moving the cursor happen in one transaction. A crash either creates neither or both;
an alert that exists gets sent by any later pass.

### 3. Sending

This is the existing send step. Follow-up alerts sit in the same queue and use the same claim, finish,
back-off and give-up.

Immediately before any row is handed to the push service, first pushes included, `sendOne` makes one
check in a single query:

- the row is still `sending` under **this worker's** `claim_token` (Got it or a snooze may have cancelled it
  since it was claimed);
- for a follow-up alert, its delivery isn't acknowledged, superseded or cancelled;
- the reminder isn't deleted.

If any of these fails, the row isn't sent. A row this worker still owns becomes `cancelled`; one it no longer
owns is left alone. The mirror skips follow-up alerts, and the late "Was due …" rewrite doesn't
apply to them; they carry their own wording.

**Queue order changes from `scheduled_for, id` to `give_up_at, id`.** Among first pushes nothing changes while
`DELIVERY_GIVE_UP_HOURS` stays the same, because their `give_up_at` is `scheduled_for` plus that constant.
After the setting changes, they go in order of their stored deadlines, which is still a sensible priority. A follow-up alert's window is short, so
it goes ahead of an old backlog of first pushes instead of ageing out behind them. A first push still within
15 minutes of its own give-up still goes first. Health also reports the oldest follow-up alert still due
(`follow_up_lag_s`), so a stalled queue shows even though the heartbeat stays fresh.

### Got it, snooze and stops cancel everything not yet sent

Got it, a snooze, and every **final** stop in the table below move the delivery's **unsent follow-up alerts**
to `cancelled` (or `missed` for a supersession) in the same transaction. Unsent means `pending` or `sending`.
Expiry is not a final stop: it only clears the cursor, and alerts already created still go out within their
own windows.

- **Alert 1 failed at 09:15 and is waiting to retry at 09:16, and the person snoozes until 09:45.** The
  snooze cancels the 09:16 retry.
- **A worker already holding a row (`sending`)** loses it. The send-time check stops the HTTP request if it
  hasn't started. `finish()` updates nothing, and the stale-claim sweep never picks it up again.

**The first push is handled by where the tap came from:**

| Tap came from | Got it | Snooze |
|---|---|---|
| A token (notification or tap-through page) | The first push, if unsent, becomes `sent` | Same |
| The app | The first push, if unsent, becomes `cancelled` | The first push is left alone |

- **Why a token tap marks it `sent`:** the token came from that push, so the push arrived; only the push
  service's answer was lost. Promoting it also clears the member's channel `last_error`, as a successful send
  does. Otherwise the People page could keep saying the last send failed.
- **Why the app leaves it alone on snooze:** it keeps sending or retrying as usual, so the delivery never sits
  `cancelled` while its snooze is still live and hides from the creator's view. Arming in step 1 respects the
  snooze's cursor.

The card, the list, the creator's view and recent deliveries read the delivery's acknowledgement and follow-up
fields, not its status. An acknowledged first push that is `cancelled` still shows there as "Got it".
Follow-up creation never looks at the delivery's status.

### What Remind Me can and can't promise

Once Got it commits, no row of that delivery passes the send-time check, so Remind Me starts no new hand-off to
the push service. Some alerts may still arrive:

- **An HTTP request that passed its check before the commit** can still get through. That is at most one per
  row being sent, bounded by the 10-second send timeout. Holding a database lock across the HTTP call would close
  this gap, but it would tie up pool connections for the length of a send, so the plan doesn't.
- **A push service that queues** can deliver an alert it had already accepted. Home Push answers 202 when it
  queues a send.
- **APNs delivery and ordering are best effort.**

Stopping queued alerts inside the gateway would need gateway work. It isn't in this plan.

### Stopping

| Event | Effect |
|---|---|
| Got it (the person, or the creator for them) | delivery `acked`; its unsent rows `cancelled` |
| `follow_up_until` / horizon passes (soft) | delivery `expired` (shown as "not acknowledged"); no new alerts, but alerts already created still send; Got it still accepted late |
| **Any** later occurrence of the reminder is recorded, whether it is sent or `missed` | older deliveries (every member) `superseded`; their unsent follow-up alerts `missed` |
| Reminder deleted | all its deliveries `cancelled`; all pending rows `cancelled` (as today) |
| Edited with "Until acknowledged" turned off | its open deliveries `cancelled` |
| Edited so a recipient is removed | that member's open deliveries for it `cancelled` |
| Member archived | their open deliveries `cancelled` (in `members.archive`, alongside today's pending cancel) |

Each of these sets `follow_up_ended` by the final-over-soft rule (Ending reasons) and clears `follow_up_at`.
The final ones also cancel the delivery's unsent follow-up alerts. Each applies whatever the delivery's status,
so arming in step 1 sees it.

**Supersession has two parts, and only one is new:**

- **Ending older deliveries' follow-ups, and making their unsent follow-up alerts `missed`,** runs whenever a
  later occurrence is recorded, whether it is sent or `missed`.
- **Older first pushes still retrying** keep today's rule: they are made `missed` only when the new occurrence
  is sendable. Their `give_up_at` was stored under whatever `DELIVERY_GIVE_UP_HOURS` was set at the time, so
  an older push can still be in time when a newer one is already past its own.

A one-off, or the last of a series, is `completed` as soon as it's recorded, and the edit API refuses
finished reminders. Its alerts are stopped per delivery instead: Got it, or the creator's Mark done. The
"Waiting on you" list and the creator's view read deliveries directly, not through the reminders list.

### Queries that must ignore follow-up alerts

Every existing query on `deliveries` was checked:

| Where | Change |
|---|---|
| `recordDue` insert | `ON CONFLICT` names the new four-column key. It generates the delivery's `send_key` itself (see Token). |
| `recordDue` "superseded" update | unchanged for first pushes (sendable occurrences only). A new update, run for every recorded later occurrence, ends older deliveries' follow-ups and makes their unsent (`pending` or `sending`) follow-up alerts `missed` (Stopping). |
| `reminders.list` latest outcome (`DISTINCT ON`) | Shows each recipient's row **from the reminder's latest occurrence** (`alert_no = 0`), not each member's own latest. Otherwise someone re-added after missing one occurrence would show a Got it from an older one. The row now includes the delivery `id`, which Mark done needs. |
| send claim in `sendPending` | `ORDER BY give_up_at, id` (Sending) |
| `reminders.recentDeliveries` | `AND d.alert_no = 0`; shows `follow_ups` and the ack state instead. Its `status <> 'cancelled'` filter also lets through cancelled rows that are acknowledged. |
| `reminders.problems` | includes follow-up alerts that failed for good, worded "Re-alert 3 couldn't be sent" |
| `reminders.remove`, `members.archive` pending cancel | unchanged; they already catch pending alerts |
| `members` mirror report | `AND d.alert_no = 0` |
| `pruneIfDue` | unchanged |

## What a follow-up alert says

The same title, `thread_id` and level as the delivery's payload, with its own message and expiry:

```
Still waiting · was due 9:00 AM · alert 3
Snoozed · was due 9:00 AM
```

The wording stays deterministic, built in `lib/brrr.js` like the rest.

## Acknowledging and snoozing

### Token

A delivery's action token is:

```
base64url(send_key) "." base64url(HMAC-SHA256(ack_key, "remind-me-ack:" + send_key)[0..16])
```

- **`send_key`** is the delivery's existing random UUID. `recordDue` now generates it in Node
  (`crypto.randomUUID()`) and inserts it, so the token can go into the first push's payload, which is built
  before the row exists. Follow-up alerts carry the token of their delivery.
- **`ack_key`** is a random key in `app_config`, inserted by migration `0006` (`ON CONFLICT DO NOTHING`). It is
  there before either dispatcher starts, so two processes can't each create one.
- **Checking** a token means looking up the delivery by `send_key` and recomputing the MAC in constant time.
  Nothing per token is stored.
- **Rotating** `ack_key` (a documented one-line SQL update) kills every outstanding token. Those deliveries
  can still be acknowledged in the app. Alerts created after the rotation carry new tokens.

A token can do three things to its one delivery: show it, acknowledge it, snooze it. It acts as the delivery's
own member, so acknowledgement stays per person. It works until `COALESCE(follow_up_horizon, give_up_at) + 12 h`.
That deadline exists from the moment the row is recorded (`give_up_at` is set then), so a token that reaches
the phone before the first push is settled already has a lifetime. After the deadline, or once the delivery is
superseded or cancelled, it answers `gone`.

**A token is a secret, like a push key:**

- It never goes in a URL path or query string, a log line, or any API response except to its holder.
- **The push service's error text is redacted.** `brrr.send` already strips the push secret from an error
  before storing it. It also strips every token in the payload, before truncating, the same way. Without this,
  a gateway that echoes the payload in an error would put a working token on the delivery and on the
  member's channel, and the People page shows channel errors to parents even for private reminders.
- The mirror gets a copy with `open_url` and any action fields removed.

### Endpoints

| Route | Who | Does |
|---|---|---|
| `POST /api/ack` `{ token, action, minutes?, from? }` | Anyone holding the token (no session) | `peek`, `ack` or `snooze` (below) |
| `POST /api/deliveries/:id/ack` | The delivery's member, or the reminder's creator | Got it from the app. `acked_by` is the viewer. |
| `POST /api/deliveries/:id/snooze` `{ minutes, from }` | The delivery's member | Snooze from the app |
| `GET /ack` | Open page | The tap-through page (below). Shows nothing without a token. |

**Ack** is one conditional UPDATE on the delivery, in a transaction that also cancels its unsent rows, the
first push's retry included:

```sql
SET acked_at = COALESCE(acked_at, now()), acked_by = COALESCE(acked_by, $who), ack_via = COALESCE(ack_via, $via),
    follow_up_at = NULL, follow_up_ended = 'acked'   -- replaces a soft 'expired'; the WHERE excludes final stops
WHERE id = $id AND follow_up_ended IS DISTINCT FROM 'superseded' AND follow_up_ended IS DISTINCT FROM 'cancelled'
```

- It answers `recorded`, `already` (with who and when; a replay keeps the first actor and time), or `gone`.
- It works in any status, including `expired`: a late Got it is recorded and never re-arms alerts.
- The phone treats only `recorded` and `already` as done.

**Snooze** takes `minutes` (10, 30 or 60, required; the notification button sends 10) and `from`, the
`alert_no` the person snoozed from. The notification knows it, and the app and ack page get it from `peek`.
It is one conditional UPDATE:

- **Apply** only when `follow_up_ended IS NULL` (not acknowledged, stopped or expired) and `from = follow_ups`
  (it was asked from the latest alert). It works even before the first push is settled. It sets the deadlines
  if they aren't set yet (Deadlines, `t0 = now`), then `follow_up_at = least(now + minutes, follow_up_horizon)`,
  `follow_up_kind = 'snooze'`, `snoozed_from = from`, and cancels the delivery's unsent follow-up alerts.
  The first push follows the table under Sending. An expired
  delivery is never reopened.
- **Replay:** `snoozed_from = from` with the snooze still pending. Nothing changes, and it answers with the
  stored time. A retry after a lost response never moves the alert again.
- **Stale:** `from < follow_ups`, or the snooze already fired. Nothing changes; it answers `stale` and the
  current state.
- **Ack wins:** both are conditional UPDATEs of the same row. Once Got it is recorded, a snooze answers
  `already`.

`GET /api/reminders` gains a `waiting` list for the viewer. It reads deliveries directly (`alert_no = 0`, the
viewer's own). It includes deliveries whose alerts are still open or that expired in the last 12 hours, plus
normal reminders that went off in the last 30 minutes (so they can be snoozed). The per-recipient deliveries on
each reminder gain `acked_at`, `acked_by`, `follow_ups` and `follow_up_ended`, so the creator sees "Riley:
waiting, 3 alerts".

### Tailnet mode

In tailnet mode every write must be JSON from the app's own origin (`suite.guard`), and every request needs a
linked household member (`suite.requireMember`). A background POST from Home Push carries no browser origin.
It may also come from a device whose identity isn't linked to the member the delivery is for.

- **Exactly `POST /api/ack`** (method and exact path) is let past both. In `lib/app.js` it skips
  `suite.guard`. In `suite-identity.js` it gets a method-aware exemption: `OPEN_PATHS` matches the path only,
  so adding it there would also open `GET /api/ack`. It still goes through the `/api` JSON check. The handler reads only the token, never ambient identity (`viewerOf`). The guard protects
  requests that carry identity automatically, like a cookie. This route ignores identity and needs a secret
  in the body, so that protection isn't needed here.
- **`GET /ack`** (the page) is open too, so a tap-through works on a phone not yet linked. It renders no data.
- **`/api/deliveries/:id/ack` and `/snooze`** go through both gates as normal and are added to
  `KID_ROUTES`: kids acknowledge their own reminders.
- **Tests:**
  - Every other route, including `GET /api/ack` and other spellings, still needs both gates.
  - `POST /api/ack` works with no origin and no identity headers.

### Where links point

A new config value, `ackBaseUrl`, comes from `APP_PUBLIC_URL`. It is validated like the tailnet public
address, and it is independent of `TAP_OPENS_APP`.

- **Without it:** pushes carry no token and no tap link, and Got it happens in the app only.
- **`PUSH_ACTIONS=true` (phase 2) without it:** refuses to start.

## Phase 1: remindMe only (works with any brrr-compatible service)

### Composer

Under **Alert**, a toggle: **Until acknowledged**, off by default. On, it shows:

- *Re-alert every*: 5 / 10 / **15** / 30 min
- *Give up after*: 1 h / **4 h** / 12 h

Turning it on while Passive is selected switches the level to the default (Urgent). The summary line says it
plainly: *"9:00 AM every day · re-alerts every 15 min until Riley taps Got it."* Suggestions remember the
setting along with the level.

### Home screen: "Waiting on you"

A card above Next up, from the `waiting` list:

```
┌ Waiting on you ─────────────────────────────┐
│ Take your medicine        due 9:00 · alert 3 │
│ [ Got it ]                   [ Snooze ▾ ]    │
└──────────────────────────────────────────────┘
```

- **Snoozed** normal reminders show "Snoozed until 9:40".
- **A normal reminder that just went off** shows with Snooze only.
- **Expired** deliveries show "Not acknowledged" for 12 hours, with a Got it that records it late (no Snooze).

### Reminder list and recent deliveries

Each reminder with "Until acknowledged" shows a small chip. For the latest occurrence, each recipient shows
one of: *Waiting · 3 alerts*, *Got it 9:12*, *Not acknowledged*. The creator gets **Mark done for Riley** on a
waiting recipient. The same appears on a finished one-off, which is reached through the creator's deliveries,
not the reminders list.

### Tap-through page

For deliveries with "Until acknowledged" (and when `ackBaseUrl` is set), every alert's `open_url` is the ack
page with the token in the fragment: `<ackBaseUrl>ack#t=<token>`.

- **The token stays out of server logs.** A fragment never reaches the server, so it isn't in any access log.
- **The page:** it reads the token, POSTs `peek`, and shows the reminder with big **Got it** and **Snooze**
  buttons and the current state.
- **Loading it never acknowledges anything,** so a link preview or prefetch can't press Got it for you.
- **Other reminders are unchanged:** `TAP_OPENS_APP` still decides their tap link.

## Phase 2: Home Push action buttons

Phase 1 means opening a page. Phase 2 puts **Got it** and **Snooze 10 min** on the notification itself
(long-press, or swipe on the lock screen), on the Watch too.

### What remindMe sends

Only when `PUSH_ACTIONS=true` (off by default, since brrr doesn't know these fields):

```json
{
  "collapse_id": "remind-me-<delivery send_key>",
  "category": "remind-me.ack",
  "action_callback": { "url": "<ackBaseUrl>api/ack", "token": "<token>", "from": 3 }
}
```

- **`category`:** `remind-me.ack` (Got it + Snooze 10 min) for "Until acknowledged", `remind-me.snooze` (Snooze
  10 min) for the rest.
- **`collapse_id`** is the delivery's, the same on the first push and every follow-up alert. Each alert
  **replaces** the last one in Notification Center and still sounds, so you see one notification re-alerting,
  not eight copies.
- **`from`** is the alert's `alert_no`, for the snooze rules.
- **The buttons send their values explicitly:** Got it posts `{token, action: "ack"}`, Snooze 10 min posts
  `{token, action: "snooze", minutes: 10, from}`.

### Home Push gateway (separate repo)

- Pass `collapse_id` through as the `apns-collapse-id` header (64 bytes max), outside the encrypted envelope.
- Carry `category` and `action_callback` inside the encrypted envelope, so the token is end-to-end encrypted.
- Validate: `category` from the known list, `action_callback.url` https only.
- Its error responses must never echo the payload. Remind Me redacts anyway.

### Home Push app (separate repo, needs a TestFlight build)

- **Categories:** register them at launch. They are a fixed set built into the app, so a new category needs an
  app build.
- **The NSE** sets `categoryIdentifier` from the decrypted payload.
- **The buttons** run in the background (no `.foreground`). Each POSTs to the callback URL, then completes.
- **Allowed hosts:** it only posts to https URLs on hosts the household knows (from the Home Base household
  manifest), so a payload can't make the phone post anywhere else.
- **It fails safe.** Any answer other than `recorded`, `already` or a snooze result is a failure: no network,
  off the tailnet, `gone`, an error. On a failure it posts a local notification: "Couldn't reach Remind Me. Open
  it to tap Got it." The server never recorded anything, so the re-alerts keep coming. A failure means more
  alerts, never a silent acknowledgement.

## Not in this plan

- Telling the creator when nobody acknowledges (decided against for now).
- Clearing a notification that's still on the phone after Got it was tapped in the app or on another device.
  This would need a silent push. With `collapse_id` there is at most one left over.
- Cancelling alerts already queued inside the push service.
- Alert intervals that tighten over time (15 min, then 5).
- Quick-entry wording ("until I say got it").
- Quiet hours. The horizon is the bound: at most 13 hours of alerts.

## Delivery plan

Each PR is kept to a few files.

| # | Repo | Contents | Files |
|---|---|---|---|
| 1 | remindMe | Migration `0006` (columns, CHECKs, unique key, `ack_key`), arming, the follow-up step, send-time recheck, cancel-unsent, supersession, queue order, wording, tokens and redaction | migration, `lib/dispatcher.js`, `lib/brrr.js`, `lib/acks.js`, 2 test files |
| 2 | remindMe | Reminder settings (validate, store, cancel on edit/delete/recipient removal), endpoints, `waiting` list, query changes, archive, tailnet routes | `lib/reminders.js`, `lib/members.js`, `lib/app.js`, `lib/suite-identity.js`, 2 test files |
| 3 | remindMe | Composer toggle, "Waiting on you" card, list chips, ack page, **and the tap link in the payload** | `public/index.html`, `public/app.js`, `public/remind-skin.css`, `public/ack.html`, `public/ack.js`, `lib/dispatcher.js` |
| 4 | homePush | Gateway: `collapse_id`, `category`, `action_callback` | `gateway/lib/payload.js`, `gateway/lib/apns.js`, tests |
| 5 | homePush | App: categories, NSE category, background action, fail-safe notice | iOS files; TestFlight build |
| 6 | remindMe | `PUSH_ACTIONS` payload fields | `lib/brrr.js`, `lib/dispatcher.js`, README, tests |

- **PR 1 changes nothing on its own:** no delivery can have alerts until PR 2 lets a reminder have "Until
  acknowledged".
- **The tap link only starts appearing in pushes with PR 3,** together with the page it opens. A reminder
  created through the PR 2 API never gets a link to a page that doesn't exist yet.
- **During the update, one pass can fail.** Migration `0006` replaces the three-column unique key. The timer
  (a one-shot every minute, which runs no migrations) can land on either side of the web service's migration:
  old code after the change, or new code before it. That pass's recording fails inside its per-reminder
  savepoint and rolls back, and the reminder stays due. The next pass, a minute later, records it. Nothing is
  sent twice, and a reminder in that minute can arrive up to a minute late. Only a reminder already at its
  give-up time (12 hours late by default) could be recorded `missed` instead. The PR notes this.
- **Phase 1 (PRs 1–3) is useful by itself.**
- **PRs 4 and 5 ship before 6,** so a gateway that doesn't know the new fields never receives them.

## Tests that must exist

**Dispatcher (`test/dispatcher.test.js`)**
- Two concurrent passes create each follow-up alert once and send it once.
- A dispatcher that dies after creating an alert, or mid-send, leaves an alert that is sent later with the
  same Idempotency-Key.
- Every alert's Idempotency-Key differs from the first push's and from every other alert's.
- A follow-up alert that fails is retried within its give-up time. One that fails for good shows in problems.
- Nagging never arms before the first push is `sent`. A first push that gives up never nags.
- Got it, a newer occurrence, or an edit that lands while the first push is `sending` or `pending` stops the
  loop from arming.
- After a long stop, an overdue nag before its deadline sends one alert. One past its deadline sends none and
  ends `expired`.
- The last nag before `follow_up_until` is sent, and the delivery is `expired`; nothing after it.
- A follow-up alert whose delivery was acknowledged after it was created is `cancelled`, not sent.
- A newer occurrence that is recorded `missed` still supersedes, and cancels older pending and `sending` alerts.
- Got it while the first push is waiting to retry cancels the retry. A snooze cancels a follow-up alert waiting
  to retry. A worker holding a row that was cancelled meanwhile can't mark it sent, and nobody reclaims it.
- A snooze shortened to the horizon, and a final nag created at `follow_up_until`, are both still sent. A
  stale claim on the last nag is reclaimed and sent within its window. A stale claim on an earlier 5-minute nag
  is replaced by the next nag.
- The last nag is sent even though creating it marks the delivery `expired`.
- A worker that claimed a row before Got it or a snooze committed doesn't start the HTTP request (the
  ownership check).
- An app snooze while the first push is `sending` leaves the first push to finish. The delivery stays
  visible to the creator.
- A newer occurrence recorded `missed` doesn't make an older first push `missed` while that push still has
  time to retry (a mixed `DELIVERY_GIVE_UP_HOURS` case).
- A token tap that promotes a first push to `sent` clears the member's channel error.
- A late Got it on an expired delivery records `acked`.
- Follow-up alerts are sent ahead of an old backlog of first pushes (`give_up_at` order).
- Follow-up creation never deadlocks against delete or archive. Run them concurrently and check that neither
  is aborted.
- A follow-up alert's `expiration_date` is its own `give_up_at`, even when the first push went out 11 hours
  late.
- A gateway error that echoes the payload stores no token anywhere.

**API (`test/ack.test.js` and others)**
- Per person: Sam's Got it leaves Riley's alerts running. The creator's Mark done stops Riley's and records
  the creator.
- Got it while the first push is `sending` is recorded. Replays answer `already` and keep the first actor and
  time. A late Got it after `expired` is recorded and arms nothing.
- Snooze:
  - On a normal reminder it sends exactly one alert.
  - It is capped at the horizon.
  - A replay doesn't move it, and a stale `from` changes nothing.
  - It loses to an earlier Got it.
- Delete, editing "Until acknowledged" off, removing a recipient, and archiving the member each stop open
  loops. Other edits don't change running loops.
- An expired delivery that is then cancelled or superseded records the final reason; its token answers `gone`,
  and Snooze can't reopen it.
- A token used before the first push is settled works. Got it is recorded. Snooze sets the deadlines itself,
  its alert is sent, and the first push row becomes `sent`, not retried. An in-flight `finish()` for it
  updates nothing.
- The list shows each recipient's state from the reminder's latest occurrence. Someone re-added after missing
  one shows nothing, not an old Got it.
- Tokens:
  - A token works only for its delivery.
  - It answers `gone` once superseded, cancelled, or past horizon + 12 h.
  - It fails after `ack_key` rotates.
  - A token from another install fails.
- Tailnet mode:
  - `POST /api/ack` works with no origin and no identity headers.
  - Every other route and spelling still needs both gates.
  - A kid can acknowledge their own delivery from the app.
- `GET /ack` never acknowledges.

**UI**
- Check the composer, the card and the ack page at 390 px in WebKit, as the repo's rules require.

## Review history

**Codex round 1** asked for changes. Its 11 findings and how this revision answers them:

1. **A Got it during the first send could be lost or the loop revived.** Got it, supersession and cancellation
   now apply in any status, and arming checks them atomically (Lifecycle 1).
2. **A gateway error could leak the token.** Tokens are redacted from error text, the mirror copy is stripped,
   and the exemption is exactly `POST /api/ack`.
3. **Claiming consumed an alert before it was sent.** Every alert is now a delivery row, with retries,
   reclaim, its own key, and a visible failure.
4. **Got it on the last alert was a no-op.** A late Got it is now recorded, and answers are distinguished:
   `recorded`, `already` or `gone`.
5. **Stale nags after downtime; nags indistinguishable from snoozes; a loop with no deadline.**
   `follow_up_kind` now separates them, a nag past its deadline is never sent, and CHECKs require a deadline
   and a horizon.
6. **The "at most one extra alert" promise was overstated.** There is now a send-time recheck, and the promise
   is restated around what Remind Me controls.
7. **Follow-ups inherited the first push's expiry.** Each alert now has a fresh payload and expiry.
8. **Snooze had no replay or ordering rules.** It now has `from`, replay and stale rules, ack wins, explicit
   `minutes`, and a horizon cap.
9. **Some stop paths were missing.** Missed occurrences supersede, removing a recipient and archiving cancel,
   and finished one-offs are reached per delivery.
10. **Starvation, and an incomplete snapshot.** Both settings are now snapshotted. Follow-up alerts are created
    before the send step and share its queue.
11. **Creating `ack_key` could race; token build order and link base.** The key is created in the migration,
    `send_key` is generated before the payload is built, and `ackBaseUrl` is independent of `TAP_OPENS_APP`.

**Codex round 2** asked for changes. Its 8 findings and how this revision answers them:

- **H1. Alerts after Got it or snooze.**
  - Got it, snooze and every stop now cancel all of the delivery's unsent rows (`pending` and `sending`),
    including the first push's retry. Older alerts are superseded whether they are `pending` or `sending`.
  - The remaining gap, an HTTP request already in flight, is stated, with the reason no lock is held across
    it.
- **H2. Expired deliveries could reopen.** `expired` is now a soft reason that a final reason replaces.
  Snooze needs `follow_up_ended IS NULL`, so it never reopens one.
- **H3. A token could arrive before it had a lifetime.** Token lifetime now falls back to `give_up_at`. A
  snooze before the push is settled sets the deadlines itself, and arming keeps them.
- **H4. Zero-length windows.** Every follow-up alert gets at least 15 minutes to be sent, longer than the stale
  claim time. The horizon limits creation only.
- **M1. Lock-order deadlock.** Follow-up creation locks delivery, reminder and member in one `SKIP LOCKED`
  SELECT, so it never waits.
- **M2. Starvation.** The send queue orders by `give_up_at`, and health reports `follow_up_lag_s`.
- **M3. List view.** It shows state from the reminder's latest occurrence and returns the delivery `id`.
- **M4. Unique-key cutover.** The one-pass failure window during the update is described, and retried the
  next minute. The tap link moves to PR 3 alongside its page, and the `/api/ack` exemption is method-aware.

**Codex round 3** found five new defects in the round-2 changes, and some round-2 fixes were only partial:

1. **Expiry cancelled the last nag.** Expiry is now soft: it stops new alerts only. Only final stops cancel
   unsent follow-up alerts.
2. **A stale 5-minute claim is replaced before it can be reclaimed.** The plan now says so: the next alert is
   the recovery, and the sweep recovers the last alert.
3. **An app snooze could hide a live one-off.** An app snooze leaves the first push alone. The creator's view
   and recent deliveries show acknowledged rows even when they are cancelled.
4. **A missed newer occurrence could discard an older first push that still had time.** Older first pushes
   keep today's sendable-only supersession. Only follow-ups are superseded every time.
5. **A false "last send failed".** A token promotion now clears the channel error.

The partial round-2 fixes, finished:

- **H1:** the send-time check now covers first pushes and checks claim ownership.
- **H2:** Got it replaces a soft `expired` with `acked`.
- **M1:** the plan now says "never waits on a row lock", not "never waits".
- **M4:** the cutover wording no longer promises "nothing is lost".
