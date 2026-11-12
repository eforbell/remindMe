# Remind Me

Household reminders that arrive. Pick what, who, and when (on the quarter hour). At that time, every
person you picked gets a [brrr.now](https://brrr.now) push on their iPhone. One-offs or repeating series,
four alert levels, and nothing else.

Part of the Sovereign Home suite. It installs from Home Base (catalog id `remind-me`, mounted at `/remind/`)
or runs on its own with Node 20+ and PostgreSQL.

## What it does

- **Schedule**: a text, one or more people, a date (calendar) and a time on the quarter hour
  (:00, :15, :30, :45), a repeat, and an alert level.
- **Quick entry**: type “remind Sam to take medicine tomorrow at 5pm” and tap **Use** to fill the form.
  The parser is deterministic and conservative (`public/shared/quick-parse.js`); nothing is applied
  without a tap.
- **Suggestions**: what you scheduled before is offered as you type, with its last time, people, repeat,
  and level.
- **Repeat**: daily, weekly on chosen days, monthly (the 31st falls on the last day of shorter months),
  or yearly, every N, for a set number of times or until deleted.
- **Renewal**: as a bounded series nears its end, the home page offers **Add N more**, **Change**, or
  **Let it end**. The last push says it is the last one.
- **Alert levels** (brrr `interruption_level`): Quiet (`passive`), Standard (`active`),
  Urgent (`time-sensitive`, the default), Critical (`critical`, needs Critical Alerts allowed for brrr on
  the phone).
- **People**: each person pastes their own brrr webhook secret or URL. Without one, nobody can pick them.
  **Send test** confirms the key works.

## How delivery stays reliable

A reminder is a single row however often it repeats: the rule plus a cursor (`next_fire_at`). Nothing in
the future is stored ahead of time, so “until deleted” costs nothing.

The dispatcher (`lib/dispatcher.js`) runs **every minute from two places**: the
`remind-me-dispatch.timer` systemd timer and the web process itself. Each pass:

1. **Records due occurrences.** It locks due reminders (`FOR UPDATE SKIP LOCKED`), inserts one delivery
   row per recipient (unique per occurrence and person), and moves the cursor, all in one transaction.
2. **Sends.** It claims pending deliveries in one `UPDATE … RETURNING`, sends each, and marks it sent.
   Failures retry with back-off (1, 2, 4, 8, 16, 32, then 60 minutes) until `DELIVERY_GIVE_UP_HOURS`
   after the due time, then the delivery is marked failed and shows on the home page. A claim left by a
   crashed process is taken over after 5 minutes.

The two schedulers never double-send, because every step claims rows. Delivery is at-least-once: a crash
between brrr accepting a push and the row being marked sent means a rare duplicate, never a miss.

Other details:

- **Downtime**: after downtime only the latest missed occurrence is sent, marked “Was due …”. Older ones
  are recorded as missed.
- **Expiry**: each push carries brrr’s `expiration_date`, so Apple keeps retrying a phone that is offline.
- **Health**: `/api/health` reports the dispatcher’s last check-in. The app shows a warning if it goes
  quiet for 3 minutes.
- **Mirror (optional)**: set `PUSH_MIRROR_URL` to a second gateway that speaks brrr's API, and give
  people a mirror key on the People page. Each delivery is then copied to that gateway once, alongside
  the brrr send. This is for running a self-hosted gateway side by side with brrr before relying on it.
  - brrr stays the delivery of record: a mirror failure never changes a delivery's status, retries or
    timing.
  - The outcome is kept on the delivery: HTTP status, the gateway's message id, or the error.
  - `GET /api/mirror/report?days=30` lists both outcomes for every delivery in the window, with
    totals, so misses can be counted.
- **Time zone and DST**: times are household wall-clock times (`HOUSEHOLD_TIMEZONE`). A daily 9:00 AM
  stays 9:00 AM across DST changes. A time skipped by spring-forward moves forward by the gap. A time that
  happens twice at fall-back means the first one.

## Running it

```bash
docker compose up -d            # PostgreSQL on 127.0.0.1:5441
cp .env.example .env
npm install
npm run dev                     # http://127.0.0.1:3013 (migrations run at start)
npm run dispatch                # one dispatcher pass by hand
```

Tests need a throwaway database (its schema is dropped):

```bash
TEST_DATABASE_URL=postgresql://remindme:remindme@127.0.0.1:5441/remindme_test npm test
```

Without `TEST_DATABASE_URL`, the database tests are skipped and the pure ones still run.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `PORT` / `HOST` | `3013` / `127.0.0.1` | Loopback unless you mean to expose it |
| `HOUSEHOLD_TIMEZONE` | `America/New_York` | IANA zone that reminder times are in |
| `APP_PUBLIC_URL` | empty | This app's address; used as the tap-through link only when `TAP_OPENS_APP=true` |
| `TAP_OPENS_APP` | `false` | Tapping a push opens the app. Off by default, so Home Push shows the reminder itself instead |
| `BRRR_ICON_URL` | empty | Notification icon. Must be publicly reachable, not a tailnet URL |
| `DELIVERY_GIVE_UP_HOURS` | `12` | How long a failing push keeps retrying (0.25 to 72) |
| `RETENTION_DAYS` | `180` | Finished reminders and delivery history are pruned after this |
| `IN_PROCESS_DISPATCH` | `true` | The web process also dispatches every minute |
| `MIGRATE_ON_START` | `true` | Apply pending migrations at start |
| `PUSH_MIRROR_URL` | empty | Optional second brrr-compatible gateway that gets a copy of every push (see Mirror above) |

## Deploying without Home Base

`deploy/` has a web unit, a oneshot dispatcher unit, and a timer that runs every minute. Run
`node db/migrate.js` after each update. Put nginx in front and keep every path relative: the app works
under any mount path.

## iOS wrapper notes

Zoom is off in every form, in four layers:

1. a viewport meta tag with `maximum-scale=1, user-scalable=no` (WKWebView honors it)
2. `touch-action: pan-x pan-y` on every element (no pinch or double-tap zoom)
3. every input at 16px or more (no focus zoom)
4. cancelled WebKit gesture events

There is no `window.prompt`/`alert`/`confirm`, because wrappers often drop them: confirmations are
in-page sheets.

## License

MIT

## Silent push verification

Push setup uses `PUSH_BASE_URL` (default: `https://api.brrr.now`). In notification
settings, **Verify saved secret (no push)** rechecks the currently saved target;
save any edited secret first. Saving a target also returns a verification result.
The check uses bearer-authenticated `GET /v1/check` with a timeout and refuses
redirects or URLs belonging to a different push service. Secrets and gateway
response bodies are not included in verification feedback.

A verified device/person secret means homePush recognizes it and has at least one
active device with an APNs key. It does **not** prove phone delivery, notification
permissions, or end-to-end receipt. Unknown secrets, inactive devices, missing
APNs keys, connectivity errors, and invalid responses remain **not verified**.
brrr and endpoints returning 404/405/501 are **unsupported**, not successful
verification; saving remains available. Results are point-in-time, not a durable
health badge—recheck after changing services or rotating/enrolling devices.
