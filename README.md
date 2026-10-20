# Duatetes Worker

Cloudflare Worker + D1 (`duatetes_coupon`) behind two static frontends:
`duatetes_loyalty_app` (customers spin the wheel) and `duatetes_backoffice_app` (staff).

Production: https://duatetes-worker.duatetes.workers.dev

## Commands

All Wrangler calls go through `./wr`, which loads the Cloudflare token from `../tokens/tokens.env`.

```sh
./wr deploy                       # deploy the Worker
./wr dev --port 8790              # local worker (reads .dev.vars)
./wr tail                         # live logs
./set-pin 123456                  # change the back-office PIN (6 digits)
```

## Secrets

| Name | What |
|---|---|
| `SESSION_SECRET` | Random string. Signs back-office sessions, spin tickets and prize picks. Changing it logs everyone out and invalidates open spin tickets. |
| `ADMIN_PIN_HASH` | `salt:sha256(salt + pin)`. Set with `./set-pin`, never by hand. |

Set a secret: `printf '%s' "<value>" | ./wr secret put SESSION_SECRET`.
For local dev copy both into `.dev.vars` (gitignored).

## Database

Migrations in `migrations/` are applied by hand, in order. `d1_migrations` is not used.

```sh
./wr d1 execute duatetes_coupon --remote --file migrations/000N_name.sql
```

Tables: `coupons`, `customers`, `prizes` (catalogue), `prize_settings` (what is on the wheel, with
percentage and slices), `auth_attempts` (failed-login rate limit).

## How it works

- **Public routes**: `GET /api/health`, `GET /api/wheel`, `GET /api/winners`, `POST /api/validate`,
  `POST /api/spin`, `POST /api/spin/claim`, `POST /api/login`. Everything else needs a session.
- **Login**: `POST /api/login {pin}` returns a signed token (`Authorization: Bearer ...`). 5 wrong PINs per
  IP lock that IP for 15 minutes. A session lasts 3 days from the last activity; the Worker returns a
  fresh token in `X-Session-Token` while it is in use.
- **Spin**: `POST /api/spin` picks the prize on the server (weighted by `prize_settings.percentage`) and
  returns it with a signed ticket. Nothing is saved. The prize comes from `HMAC(coupon_id)`, so the same
  coupon always gets the same prize and reloading cannot re-roll it. When the prize is on screen the
  frontend calls `POST /api/spin/claim` with the ticket, which writes it to the coupon. Prizes flagged
  `is_fail` are redeemed automatically.
- **Wheel rules** (enforced here and in the back office): 5–12 prizes, 10–12 slices in total,
  percentages add up to 100, prize names up to 14 characters.
- `GET /api/coupons` returns the latest 200 coupons.
