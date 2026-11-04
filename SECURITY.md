# Security

Remind Me is meant to run on a private network (for example a tailnet) behind a reverse proxy, for one
household. It has no logins of its own: anyone who can reach it can schedule reminders and manage
people. Do not expose it to the internet.

## brrr secrets

- Each person's brrr webhook secret is stored in PostgreSQL (`member_notification_channels`), in plain
  text, like the other Sovereign Home apps; protect the disk and the database. Anyone holding a secret can
  push notifications to that person's phone.
- The API never returns a secret, only `••••` and its last four characters. Secrets are not logged.
  Delivery rows store the payload, never the secret.
- Pushes send the secret in an `Authorization: Bearer` header to `<PUSH_BASE_URL>/v1/send` (by default
  `https://api.brrr.now/v1/send`), never in a URL. Pasted webhook URLs are accepted only for that service; the app never posts
  anywhere else.
- Removing a person erases their secret.

## Requests

- The server listens on loopback unless `HOST` says otherwise.
- Changes need `Content-Type: application/json` (so a plain cross-site form cannot submit one) and are
  refused when the browser marks them `Sec-Fetch-Site: cross-site`. No CORS headers are sent.
- Everything the pages render from data goes through HTML escaping or `textContent`.

## Reporting

Please open a private security advisory on the GitHub repository rather than a public issue.
