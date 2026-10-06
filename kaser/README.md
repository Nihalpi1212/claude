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
| Account | Saved addresses (CRUD), favourites, wallet + top-up + cashback ledger, **Kaser Plus** subscription (free delivery, 5% cashback), language, help centre, dark mode |
| Design | Apple-style: large titles, continuous corners, glass tab bar, spring physics on every tap, haptics, light + dark themes. Brand: Qatar maroon `#8A1538` + gold `#E4B25A` |

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
src/i18n/           en.ts / ar.ts
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
