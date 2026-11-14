# Landscape

Property research for land buyers and agents: find parcels, see who owns them, score how likely they are to sell, generate an offer and a ready-to-send letter.

- **New Hampshire:** free. Parcels from the NH GRANIT state map, owner records from each town's Vision (VGSI) assessor card.
- **Anywhere in the U.S.:** owner, mailing address, acreage, assessed values and last sale from Regrid, sold as credits (1 credit = 1 parcel record).
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

Credits do not roll over. A search that returns fewer parcels than requested only charges for what came back.

## Setup (about 20 minutes)

### 1. Supabase (accounts and credits)
1. Open the project's SQL editor and run `supabase/schema.sql` once.
2. Authentication → Providers → Email: keep **Email** on; "Confirm email" can stay on (magic links handle it).
3. Authentication → URL configuration: set **Site URL** to your app's address (e.g. `https://landscape-app.vercel.app`) and add it to **Redirect URLs**.
4. Copy the **Project URL** and the **publishable (anon) key** into the `window.LS_CONFIG` line near the top of `index.html`.
5. Copy the **service role key** for Vercel (step 3). Never put that one in `index.html`.

### 2. Regrid (nationwide records)
Sign up for the self-serve **Premium schema** API plan at regrid.com → API, and copy the token. The plan includes 2,000 parcel records a month, then $0.15 per record.

### 3. Vercel (hosting)
Import this repo, then add these environment variables and redeploy:

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service role key (server only) |
| `REGRID_TOKEN` | Regrid API token |
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
The app asks Regrid for exactly the number of parcels the user chose (20, 40 or 100) with the user's filters applied server-side (county or city, land type, acreage). Credits are reserved before the call, and anything Regrid doesn't return is refunded, so the user never pays for empty results. The returned parcels are scored and ranked in the browser.

## Running the free parts without accounts
Leave the Supabase and Stripe variables unset and the New Hampshire pulls, listings scraper, CSV import, scoring, offers and letters all still work. Only "Find candidates nationwide" and the account card need them.

## Notes
- Owner names and mailing addresses are public record; the app is built for purchase inquiries, not marketing lists. Say so in your terms of service.
- Listing sites vary in how much they allow automated reading; the scraper reads a page you give it, once, and tells the user when a site refuses.
