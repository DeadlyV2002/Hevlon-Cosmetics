# Kolor Activ — HO Inventory + Sales Control Center

Vercel-ready React 19 / Vite / TypeScript + Supabase starter for the four-layer sales hierarchy:
**HO Admin → State/Super Distributor → Distributor → Retailer**, plus salesman field performance and collections.

## What's included

| Module | Description |
|--------|-------------|
| Dashboard | Stock truth monitor, exception queue, regional snapshot |
| Inventory Control | Expected vs reported vs verified stock; product-level reconciliation |
| Bill Import | Live Supabase write on Excel/CSV upload; PDF text extraction (PDF.js 5.4); duplicate protection |
| Reconciliation | Exception-driven; reported figures never overwritten |
| Collections | Record, track, and review collections; overdue flagging |
| Salesmen | Roster with calls, PC%, secondary sales, collections |
| Sales Performance | Monthly scorecard and daily activity timeline |
| Exception Center | Log, view, and export exceptions; live count badge |
| Reports | Six reconciled export types with audit trail |

## Setup

### 1. Create a Supabase project
Go to https://supabase.com → New project.

### 2. Run the schema
In Supabase → SQL Editor, paste and run the contents of `supabase/schema.sql`.
This creates all tables, indexes, RLS policies, helper functions, and audit triggers.

### 3. Configure environment
```bash
cp .env.example .env.local
```
Edit `.env.local`:
```
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_anon_key_here
```
Both values are under Supabase → Project Settings → API.

### 4. Install and run locally
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build → dist/
```

### 5. Deploy to Vercel
1. Push this folder to a GitHub repository.
2. Import the repo in Vercel.
3. Under Project → Settings → Environment Variables, add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
4. Redeploy.

## Before going live (production checklist)

- [ ] Create a `user_profiles` row for each Supabase Auth user with the correct `role` and `distributor_id`/`state_id`
- [ ] Review RLS policies — the schema ships with hierarchy-scoped policies; validate them against your exact org structure
- [ ] Add indexes for any additional query patterns you identify
- [ ] Enable Supabase Auth (Email / OTP / OAuth) and protect routes
- [ ] Enable Supabase Realtime on tables you want to push live updates from
- [ ] Set up server-side reconciliation jobs (Edge Functions or pg_cron) for automated nightly runs
- [ ] Route scanned PDFs through an OCR service before import

## What was fixed vs the previous version

| Issue | Fix |
|-------|-----|
| RLS "allow all authenticated" bootstrap policies | Replaced with role- and hierarchy-scoped policies (HO_ADMIN, STATE, DISTRIBUTOR, SALESMAN) |
| No `user_profiles` table | Added — links Supabase Auth user to `app_role` + hierarchy node |
| No database indexes | Added 10 indexes on frequently filtered columns |
| `audit_logs.actor_user_id` had no FK | Now references `auth.users(id)` |
| `organizations` table created but never used | Removed to avoid confusion |
| No audit triggers | Auto-populate `audit_logs` on INSERT/UPDATE/DELETE on key tables |
| All UI data was demo/seed only | Live Supabase reads/writes wired in for bills, exceptions, collections, salesmen, products, states, distributors |
| Bill Import had no actual Supabase write | Now inserts a bill header row on file upload |
| Exception Center had no way to add new exceptions | Log exception form with Supabase write |
| Collections had no "Record" form | Add collection form with Supabase write |
| Demo/live mode not indicated | Status indicator in sidebar + "Demo data" badge in header |
| PDF worker version hardcoded but not matched in index.html | Version 5.4.149 consistent across index.html and main.tsx |
