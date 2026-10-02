# 1v1 Chat — random 1-on-1 video chat with coins

Omegle-style random video chat: hit **Start Chat**, get paired with a stranger,
video + text, skip anytime. Coins buy filters and gifts; coins are bought with
real money via Stripe.

## Run it

```bash
cd 1v1-chat
npm install
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

## Take real payments (Stripe)

1. Create a Stripe account → get **test** keys first.
2. `export STRIPE_SECRET_KEY=sk_test_...`
3. `export STRIPE_WEBHOOK_SECRET=whsec_...` (from `stripe listen` or the dashboard webhook pointing at `/api/stripe/webhook`)
4. `export APP_URL=https://yourdomain.com`
5. Restart. The shop buttons activate. Flip to **live** keys when ready.

Without keys the app runs fine — the shop just shows "payments not connected".

## Launch checklist (public website)

- **VPS** (any $5–6/mo box), **domain**, **HTTPS** via Caddy/Nginx + Let's Encrypt.
- **TURN server** (coturn) — without it, ~15–30% of video calls fail behind
  strict NATs. Add your TURN credentials to `RTC_CFG` in `public/app.js`.
- **Moderation**: report/ban is built in (5 reports = 24h ban), but a public
  launch needs real moderation — consider an AI vision API on video
  snapshots, 18+ gating, Terms of Service + Privacy Policy pages.
- `node server.js` under **pm2** or **systemd** so it stays up.

## API sketch

- `POST /api/register|/api/login` → `{ token, user }`
- `GET /api/me`, `GET /api/coins/packages`
- `POST /api/coins/checkout` → `{ url }` (Stripe Checkout)
- `POST /api/coins/unlock-filters`, `POST /api/report`
- `POST /api/stripe/webhook` (Stripe → credits coins)
- WebSocket `/ws?token=…`: `queue` → `matched` → `signal`/`chat`/`gift`, `leave`, `next` via re-queue.
