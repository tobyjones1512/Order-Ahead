# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Existing: vanilla ES-module PWA (no build step), Vercel serverless API, Neon Postgres. Keep it.

## Users
- Customers (no accounts): people in the UK grabbing a coffee or food, on a phone, often walking, in a hurry, often outdoors in daylight. They order ahead, pay, and collect.
- Café staff (merchants, magic-link sign-in only): a barista or owner on a kitchen tablet during a rush, hands busy, glancing from a distance, plus a quieter admin moment setting up menu, hours, branding.

## Product Purpose
Lets independent UK cafés take pre-orders and payment without building their own app. Success: the customer orders in under a minute and walks in to a ready drink; the café never misses a new order during a rush.

## Positioning
Café-branded ordering on a shared platform: each café keeps its own logo and colour inside the app, and the platform takes 5% from the merchant's payout (never a surcharge to the customer).

## Operating Context
Mollie payments (Apple Pay + custom card form), Resend emails and receipts, Web Push when an order is ready, loud chime on the kitchen tablet, order states Pending → Accepted → Ready for pickup → Completed, merchant-controlled pause and +10 min rush toggle, optional VAT, 5% default tip, favourites with customisations, refunds paid from the merchant's balance.

## Capabilities and Constraints
Must look and act like a native iOS app, mobile-first (safe areas, bottom tab bar, sheets). Customers have no accounts. Merchant brand colour and logo must be able to theme the customer menu. Product name is undecided: a new short UK-café-feeling name is to be proposed and approved.

## Brand Commitments
Working name "Order Ahead" is a placeholder, open to replacement. User asked for a "unique design" across devices rather than a generic iOS clone.

## Evidence on Hand
No real cafés, photos, logos or testimonials exist. Do not fabricate customers or claims; demo menus must be labelled synthetic.

## Product Principles
- One thumb, one minute: ordering is fast and obvious.
- The café's brand leads inside its own menu; the platform recedes.
- The kitchen view must read from two metres away and never miss an order.
- Money is plain: customers see exactly what they pay, with no surprise fees.

## Accessibility & Inclusion
Outdoor daylight legibility, large touch targets, support for dark mode and reduced motion, readable at kitchen-tablet distance.
