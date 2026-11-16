# Landscape

Property research for land buyers and agents: find parcels, see who owns them, score how likely they are to sell, generate an offer and a ready-to-send letter.

- **New Hampshire:** free. Parcels from the NH GRANIT state map, owner records from each town's Vision (VGSI) assessor card.
- **Across the U.S.:** owner, mailing address, acreage, assessed values and last sale read straight from county assessor rolls and state tax-roll feeds through Apify (528 counties in 22 states for area searches — FL, MA, CT, NJ, NY, NC, WI, MN, MT, AR statewide, plus the big metro counties — and 2,100+ counties for single-address lookups). Sold as credits (1 credit = 1 parcel record).
- **Listings:** paste any public listings page (LandWatch, Realtor.com, a brokerage search) and the app merges address + asking price into your list.

No build step, no npm packages. `index.html` is the whole app; `api/` holds two Vercel serverless functions.

```
index.html              the app (single file, works offline for CSV/demo data)
api/landscape.js        search, assessor lookups, listings, accounts, credits, Stripe checkout
api/stripe-webhook.js   adds credits after a purchase, refills plans monthly
api/_lib.js             shared helpers (Supabase, Stripe, plan table)
supabase/schema.sql     accounts + credit ledger tables and functions
vercel.json
```

## Pricing (set in `api/_lib.js` → `PLANS`)

| Plan | Price | Credits |
|---|---|---|
| Pay as you go | $5 / $10 / $25 | 20 / 40 / 100 |
| Starter | $20 / month | 100 each month |
| Pro | $40 / month | 220 each month |
| Max | $60 / month | 360 each month |

Credits do not roll over. A search reserves its credits when it starts and returns any it didn't use when it finishes — the user only pays for parcels that came back. "Preview count" is free.

## Setup (about 20 minutes)

### 1. Supabase (accounts and credits)
1. Open the project's SQL editor and run `supabase/schema.sql` once.
2. Authentication → Providers → Email: keep **Email** on; "Confirm email" can stay on (magic links handle it).
3. Authentication → URL configuration: set **Site URL** to your app's address (e.g. `https://landscape-app.vercel.app`) and add it to **Redirect URLs**.
4. Copy the **Project URL** and the **publishable (anon) key** into the `window.LS_CONFIG` line near the top of `index.html`.
5. Copy the **service role key** for Vercel (step 3). Never put that one in `index.html`.

### 2. Apify (nationwide records)
Sign up at apify.com (the $19/month Starter plan includes $19 of usage; the free plan's $5 is enough to test). Copy your **API token** from Settings → Integrations. The two actors the app runs bill per record to that account:

| Actor | Used for | Cost to you |
|---|---|---|
| `scrapebench/us-county-property-records-export` | "Find candidates nationwide" (area exports with filters) | $0.02 per parcel row; count previews and coverage lists are free |
| `shelvick/county-property-records` | "Refresh owner record" for a single address outside NH | $0.05 per record found; misses are free |
| `apify/web-fetch` | Listings pages that block a plain fetch | $0.0015 per page |

Every run is started with a hard spend cap (`maxTotalChargeUsd`) matching the credits reserved, so a runaway run cannot overbill you.

### 3. Vercel (hosting)
Import this repo, then add these environment variables and redeploy:

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service role key (server only) |
| `APIFY_TOKEN` | Apify API token |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…` or `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | From the webhook you create in step 4 (`whsec_…`) |
| `APP_URL` | Your app's address, used for checkout return links |
| `OWNER_EMAILS` | Your own email(s), comma separated — unlimited credits, no charge |
| `FREE_CREDITS` | Optional. Credits a brand-new account starts with (default 0) |

### 4. Stripe (payments)
1. Developers → Webhooks → **Add endpoint**: `https://<your app>/api/stripe-webhook`
2. Events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` on Vercel and redeploy.
4. Settings → Billing → Customer portal: turn it on so "Manage subscription" works.

Prices are created on the fly at checkout from the `PLANS` table, so there is nothing to set up in the Stripe dashboard beyond the webhook. Test with `sk_test_` keys and card `4242 4242 4242 4242` first.

## How a nationwide search is billed
A search is a background job. `search_start` reserves the user's credits (20, 40 or 100), starts the Apify run with the user's filters (county / town / ZIP, property type, owner type, absentee, value range) and a spend cap, and records the job in `searches`. The browser then calls `search_poll` every few seconds; when the run finishes the API reads the rows, charges one credit per parcel actually returned, refunds the rest, and stores the mapped parcels on the job so a refreshed page can pick them up. Runs take one to two minutes because the actor reads the county's live feed. Government-owned parcels are always excluded.

## Running the free parts without accounts
Leave the Supabase, Stripe and Apify variables unset and the New Hampshire pulls, CSV import, scoring, offers and letters all still work. Only "Find candidates nationwide", out-of-state owner lookups and the account card need them.

## Notes
- Owner names and mailing addresses are public record; the app is built for purchase inquiries, not marketing lists. Say so in your terms of service.
- Listing sites vary in how much they allow automated reading; the scraper reads a page you give it, once, and tells the user when a site refuses.
