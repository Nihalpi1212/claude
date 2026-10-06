# Kaser — delivery app for Qatar

Native **iOS + Android** app (React Native / Expo SDK 57, Expo Router, Reanimated 4). One codebase, real store-ready app packages — not a web app. Bilingual **English / العربية with full RTL**, QAR pricing, Doha areas, Qatar-style addresses (Zone / Street / Building).

## What's in the app

| Area | Details |
|---|---|
| Onboarding & auth | 3 animated slides, EN/AR switch, Qatar mobile (+974) OTP login (demo code `1234`), guest mode |
| Home | Address picker, categories (Qatari, Shawarma, Burgers, Pizza, Asian, Indian, Healthy, Coffee & Karak, Desserts, Bakery, Grocery, Pharmacy, Flowers), promo carousel, top rated / fastest rails, filters + sorting, order-again |
| Search | Dishes + stores, Arabic-aware matching, recent / popular searches |
| Store page | Parallax hero, collapsing glass header, sticky menu tabs, open/closed hours (incl. past midnight), favourites |
| Items | Required / optional / multi-select option groups, notes, quantity, live price |
| Cart & checkout | Promo codes (`WELCOME30`, `FREEDEL`, `KASER20`, `QND18`), tip, delivery fee / service fee, minimum order, Standard / Priority / Scheduled, Apple Pay / Google Pay / card (Visa · Mastercard · NAPS) / Kaser Wallet / cash on delivery, contactless drop-off |
| Live tracking | Animated courier on a route map, 5-step status, ETA countdown, call / SMS courier, cancel, rating |
| Account | Saved addresses (CRUD), favourites, wallet + top-up + cashback ledger, **Kaser Rewards** (free delivery + 5% cashback — named per the brand book's naming list), language, help centre, dark mode |
| Design | Built to the **Kaser Brand Book v1.0**: Kaser Orange `#FD8912` with *ink* text on orange, Cream `#FFF8EE` backgrounds, Fresh Green `#276B54` for success, Error `#BC453D`; flat surfaces, 16 px cards / 12 px buttons / pill chips, 44 px minimum touch targets, ring brand pattern, 100–260 ms motion (respects reduced-motion), haptics, light + dark themes |

## Run it

```bash
cd kaser
npm install
npx expo start            # scan the QR with Expo Go (iOS camera / Android Expo Go app)
```

`expo-updates` and `react-native-worklets` need a dev build for some features; for the complete native experience:

```bash
npx expo run:ios          # needs macOS + Xcode
npx expo run:android      # needs Android Studio / SDK
```

## Ship it (no Mac needed)

```bash
npm i -g eas-cli && eas login
eas init                                   # links the project, fills extra.eas.projectId in app.json
npm run build:preview                      # installable Android .apk + iOS internal build
npm run build:ios                          # App Store build  (.ipa)  — needs an Apple Developer account
npm run build:android                      # Play Store build (.aab)
eas submit -p ios   &&   eas submit -p android
```

Bundle IDs: `qa.kaser.app` (change in `app.json` if you want your own).

## Project layout

```
src/app/            screens (Expo Router, file-based)
  (tabs)/           Home · Search · Orders · Account
  restaurant/[id]   store page          item/[vendorId]/[itemId]  item sheet
  cart · checkout · tracking/[id] · order/[id]
  addresses · address-edit · wallet · plus · favorites · promos · language · help
src/components/     ui kit (Tap, Button, Chip, Art…), VendorCard, TabBar, CartBar, TrackingMap
src/data/           stores, menus, categories, promos, Doha areas  (bilingual)
src/store/          Zustand store, persisted to AsyncStorage
src/lib/            pricing engine, order lifecycle, search, formatting, RTL
src/i18n/           en.ts / ar.ts  (launch lines from the brand book; Arabic needs native proofreading)
```

## Demo data vs. production

This build is **fully functional offline** so you can demo the whole flow. Before launch, replace these seams with real services:

1. **Catalogue** — `src/data/*` → your API (stores, menus, hours, fees, promos).
2. **Auth** — `src/app/login.tsx` accepts OTP `1234`; wire to an SMS provider (Twilio / Unifonic / Vonage) + token storage (`expo-secure-store`).
3. **Orders** — `placeOrder` in `src/store` and the time-based simulation in `src/lib/orders.ts`; stream real status + courier position (WebSocket / FCM / APNs) and feed `progress` into `TrackingMap`. Swap the stylised map for `react-native-maps` / Mapbox if you want street-level maps.
4. **Payments** — checkout currently records the chosen method. Integrate a Qatar-capable PSP (e.g. Checkout.com, Stripe-via-partner, MyFatoorah, Dibsy, QPay/NAPS) and Apple Pay / Google Pay tokens; never handle raw card numbers in-app.
5. **Imagery** — stores/dishes use gradient + emoji art (offline, brand-consistent). Swap `Art` for `expo-image` photos when you have real assets.
6. **Push notifications** — add `expo-notifications` for order-status pushes.

Store/restaurant names in the demo catalogue are fictional.

## Brand implementation notes

- **Logo** — `assets/kaser-logo.png` is the supplied circular master, extracted from the brand book PDF and used unmodified (only the square corners outside the circle are made transparent so it sits on cream). Shown on onboarding and login (min 48 px, 104 px on login).
- **App icon / splash / Android adaptive icon** — orange field + the K glyph taken from the supplied logo, as in the brand book's icon page. The book marks a *simplified K icon redrawn from the approved vector master* as a required final asset: **replace `assets/icon.png`, `android-icon-*.png` and `splash-icon.png` once you have the vector master.**
- **Typography** — the book specifies DejaVu Sans as a starting point and says to test a licensed Arabic family. The app uses the system fonts (SF Pro / Roboto, which render Arabic natively). Swap in a licensed family via `expo-font` when chosen.
- **Colour** — tokens in `src/theme/index.ts`. `primaryText` (`#B35A00`) is a darker orange derived for small orange text/icons on light surfaces to meet contrast; fills use the exact brand orange.
- **Imagery** — the book requires real food photography with honest portions; dishes currently use flat tiles with emoji placeholders.
