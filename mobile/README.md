# Zapnivo mobile

Flutter starter app for portable charger rentals on Android and iOS. It follows the same core journey used by QR rental apps: find a verified station, scan its QR code (or enter its ID), review rental terms, and continue to payment.

## Run

```sh
cd mobile
flutter pub get
flutter run
```

The production API is `https://api.zapnivo.com`. For a local backend, pass `--dart-define=ZAPNIVO_API_BASE=http://10.0.2.2:3000` on the Android emulator (or a reachable LAN address on a physical device). The API routes retain their `/api/` prefix on local and production hosts.

## Backend contract

- `GET /api/mobile/stations`: live, verified stations and the current **approved** pricing version. No published stations means an empty list; no approved pricing means `pricing: null` and the payment form stays hidden.
- `POST /api/rentals/checkout`: the existing server-owned rental and Stripe Checkout flow. The app sends station ID, receipt email, bank count, optional promo, and terms consent; it never sends or calculates a charge.
- Station QRs already encode `https://www.zapnivo.com/r/<station_id>`. The app accepts that format and manual station IDs; it rejects foreign QR URLs.
- The existing website handles Stripe success/cancel and customer rental history. The native app opens those pages in the browser; it does not claim that a return happened until the station confirms it.

## Current status

The app is an initial native flow, not a store-ready release. There are no fabricated station pins or prices. The backend must have an online, installed station at a published venue, ready power banks, approved pricing, and configured Stripe before a rental can start. Physical QR scanning, checkout completion, and return behavior still need device and kiosk testing. iOS builds require macOS and Xcode.

Run `flutter analyze` and `flutter test` for app checks. The launcher icon is generated from `assets/launcher.svg` with `node tool/generate_icons.cjs` from the repository root's installed `sharp` dependency.
