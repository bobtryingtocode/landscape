# Landscape for iPhone

The web app inside a native iOS shell (Capacitor). Same features, same account, plus native sign-in links,
an in-app browser for assessor cards and checkout, and the share sheet.

## One-time setup on a Mac
1. Install **Xcode** from the Mac App Store (free, ~15 GB), open it once and accept the license.
2. In Terminal:
   ```
   cd ~/code/landscape/mobile
   npm install
   npx cap add ios
   ./scripts/after-add-ios.sh
   npm run ios
   ```
   Xcode opens. Select the **App** target → Signing & Capabilities → pick your Team (your Apple ID works for
   running on your own phone). Plug in your iPhone, choose it at the top, press ▶.
3. In Supabase → Authentication → URL configuration, add `landscape://auth` to **Redirect URLs** so sign-in
   links open the app.

## Every time the web app changes
```
npm run ios
```
copies `../index.html` into the app, points it at your hosted API (`LANDSCAPE_API=https://… npm run ios` to override),
syncs native plugins and opens Xcode. Press ▶ again.

## App Store notes
- Credits and plans are bought through Stripe in the browser, outside the app. Apple's rules on external purchases
  differ by country; in the US, apps may link out to a web checkout. If review pushes back, the fallback is Apple
  In-App Purchase (StoreKit) for the same packs and plans — the credit ledger already supports a second source.
- Owner data is public record; say so in the App Store privacy details and in your terms.
