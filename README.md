# Store Order Memory V2

This version is designed to reduce repeated cooler/inventory counting by remembering what was ordered and when.

## What V2 does
- Two separate user logins
- One private shared store list
- Live updates on both devices
- Product master list by supplier
- Reorder cycle per product (every 1, 2, 3... weeks)
- Usual/default quantity
- Last ordered date and quantity
- Automatic next-due calculation
- Suggested quantity based on the most recent order
- "This Week" checklist
- Permanent order history
- Example/demo products for testing

## First setup
1. Create a project at Supabase.
2. Open SQL Editor and run `supabase-schema.sql`.
3. Open Project Settings -> API.
4. Copy your Project URL and browser-safe Publishable key (or legacy anon key).
5. Put those values into `config.js`.
6. Deploy this folder to a static host such as Netlify, Vercel, Cloudflare Pages, or GitHub Pages.

Never place a `service_role` key in `config.js`.

## How to test the idea
1. Person A signs up and creates the store.
2. Person A adds example products or real products.
3. Set each product's cycle: weekly, every 2 weeks, every 3 weeks, etc.
4. On This Week, products that are due appear first.
5. Adjust suggested quantity with +/-.
6. Tick the checkbox when the order is actually placed.
7. That action creates a permanent History record.
8. Next time, the app uses that date/quantity to calculate the next due date and suggested quantity.
9. Invite Person B with the invite code and test changes on both devices.

## Important
This app is an ordering memory/reorder assistant, not a perpetual-inventory system. It reduces unnecessary counting, but occasional physical checks are still useful for unusual sales, shortages, damages, or delivery mistakes.
