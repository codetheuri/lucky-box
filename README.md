# Chama Lucky Box

A fair "folded papers in a basket" draw for chamas (savings groups), shared over WhatsApp.

- **One winner**: one paper says YES, the rest say NO.
- **Numbers 1 to N**: sets the merry-go-round payout order.

Members open the link, tap a folded paper, type their first name, and it unfolds. No accounts.

## Fairness

When a draw is created, the server shuffles the papers with `crypto.randomInt`, builds a proof string
(`Box1:NO | Box2:YES | ... | Secret:<random>`) and shows its SHA-256 hash to everyone from the start.
Unpicked values never leave the server. When the last paper is picked the proof string is revealed, and
anyone can check that its hash matches.

## Stack

Nuxt 4 + Tailwind CSS v4. Draws are stored in **Upstash Redis** (24-hour expiry). Box claims use
`HSETNX`, so two people can never get the same paper even across serverless instances. Without Redis
credentials the app falls back to an in-memory store, which is fine for local development only.

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Import this repository in Vercel. The Nuxt preset is detected automatically.
2. In the project, open **Storage → Create / Connect → Upstash (Redis)** and connect it to the project.
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
   (Or create a database at upstash.com and add `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.)
3. Redeploy so the new environment variables are picked up.
