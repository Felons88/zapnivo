# Zapnivo mobile

Flutter renter app for Android and iOS. Sign in with Google or a six-digit SMS code, learn the rental journey, find or scan a verified station, review approved pricing, pay through Stripe Checkout, and follow the rental through confirmed return.

## Run

```sh
cd mobile
flutter pub get
flutter run
```

The production API is `https://api.zapnivo.com`. For a local backend, pass `--dart-define=ZAPNIVO_API_BASE=http://10.0.2.2:3000` on the Android emulator (or a reachable HTTPS address on a physical device).

## Required service setup

- Configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` on the server. Only the publishable URL and anon key reach the app.
- Enable Google OAuth in Supabase Auth and allow `com.zapnivo.charging://auth-callback/` as an additional redirect URL. Android and iOS deep-link declarations are included.
- Phone login needs Twilio `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `MOBILE_AUTH_SECRET` (or `HELPDESK_SECRET`). The server sends a six-digit code that expires in ten minutes. New phone-only accounts use a private synthetic login email; the renter enters a real receipt email at checkout.
- Live rentals require an online installed station, ready bank, published venue, approved pricing, Stripe, and a kiosk adapter.

## Backend contract

- `GET /api/mobile/stations`: live, verified stations and the current **approved** pricing version. No published stations means an empty list; no approved pricing means `pricing: null` and the payment form stays hidden.
- `GET /api/mobile/stations/:id`: direct QR/manual lookup, even when a station has no map coordinates. `test_mode` marks staff test stations — the app labels them and never presents them as public venues.
- `POST /api/mobile/checkout/quote`: read-only, bearer-authenticated quote. Re-runs the checkout gates (station, maintenance, inventory, pricing) and validates a promo WITHOUT reserving it; returns authoritative `hold_cents`, `first_hour_estimate_cents`, and a promo discount preview. The app re-quotes right before creating the Stripe session.
- `GET /api/mobile/config` and `POST /api/mobile/auth/phone`: mobile auth settings and SMS code flow.
- `GET /api/mobile/me` and `GET /api/mobile/rentals`: signed-in account and rental timeline. In-progress rentals carry a `dispense` block — `{stage, slot, errorCode, simulated, commandStatus, updatedAt}` — the normalized stage the backend derives from `device_commands` + `device_events` (`connecting` → `verifying` → `preparing` → `releasing` → `dispensing` → `almost_ready` → `ready`, or `failed`/`checking`). The dispensing screen mirrors this state; it never decides success itself. This endpoint also advances due test-kiosk simulated dispense stages through the real ingest pipeline.
- `POST /api/rentals/checkout`: the existing server-owned rental and Stripe Checkout flow. The app sends station ID, receipt email, bank count, optional promo, and terms consent; it never sends or calculates a charge.
- Station QRs already encode `https://www.zapnivo.com/r/<station_id>`. The app accepts that format and manual station IDs; it rejects foreign QR URLs.
- The website handles Stripe success/cancel in the browser. Only the station's physical return confirmation ends a rental.

## Current status

The app is not a store-ready release. There are no fabricated station pins or prices. Physical QR scanning, Google OAuth, Twilio, checkout, dispensing, and return behavior still need device and kiosk testing. iOS builds require macOS and Xcode.

Run `flutter analyze` and `flutter test` for app checks. The launcher icon is generated from `assets/launcher.svg` with `node tool/generate_icons.cjs` from the repository root's installed `sharp` dependency.
