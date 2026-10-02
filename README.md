# 1v1 Chat — random 1-on-1 video chat with coins

Omegle-style random video chat: hit **Start Chat**, get paired with a stranger,
video + text, skip anytime. Coins buy filters and gifts; coins are bought with
real money via Stripe. Production database: **PostgreSQL**.

## Run it locally

Needs Postgres running locally:

```bash
cd 1v1-chat
npm install
export DATABASE_URL=postgres://onevone:onevone@localhost:5432/onevone
node server.js
```

Open http://localhost:3000. Register two accounts (use two browsers or a
private window) and hit **Start Chat** on both to test matching.

Camera/mic need a **secure context**: `localhost` counts, so local testing
works. In production you MUST serve over HTTPS or cameras won't turn on.

## Coins

- New accounts get **100 free coins**.
- Packages: 500 coins $4.99 · 1,200 coins $9.99 · 3,000 coins $19.99
- Spend: unlock gender/country **filters for 24h = 100 coins**; **gifts**
  of 10/25/50/100 coins to your chat partner.

## Production deploy (Render)

`render.yaml` is a one-click Blueprint: web service (**Starter**, always-on)
+ managed **Postgres (basic-256mb)**. On Render: New → Blueprint → this repo.

Monthly cost: **~$13–14 USD** (Starter web $7 + Basic Postgres ~$6 + storage).

After deploy, set in the Render dashboard:
- `APP_URL` → your real public URL (already defaults to the onrender URL)
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` when ready for live payments
  (Stripe webhook endpoint: `https://<your-url>/api/stripe/webhook`)

## Take real payments (Stripe)

1. Create a Stripe account → get **test** keys first.
2. `export STRIPE_SECRET_KEY=sk_test_...`
3. `export STRIPE_WEBHOOK_SECRET=whsec_...` (from `stripe listen` or the dashboard webhook pointing at `/api/stripe/webhook`)
4. `export APP_URL=https://yourdomain.com`
5. Restart. The shop buttons activate. Flip to **live** keys when ready.

Without keys the app runs fine — the shop just shows "payments not connected".

## Launch checklist (public website)

- **HTTPS** is automatic on Render (required for cameras).
- **TURN server** — without it, ~15–30% of video calls fail behind strict
  NATs. Add TURN credentials to `RTC_CFG` in `public/app.js`
  (e.g. a hosted TURN service or your own coturn box).
- **Moderation**: report/ban is built in (5 reports = 24h ban), but a public
  launch needs real moderation — consider an AI vision API on video
  snapshots, 18+ gating, Terms of Service + Privacy Policy pages.

## API sketch

- `POST /api/register|/api/login` → `{ token, user }`
- `GET /api/me`, `GET /api/coins/packages`, `GET /health`
- `POST /api/coins/checkout` → `{ url }` (Stripe Checkout)
- `POST /api/coins/unlock-filters`, `POST /api/report`
- `POST /api/stripe/webhook` (Stripe → credits coins)
- WebSocket `/ws?token=…`: `queue` → `matched` → `signal`/`chat`/`gift`, `leave`, `next` via re-queue.
