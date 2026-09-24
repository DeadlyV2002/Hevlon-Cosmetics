# Deploy steps — Kolor Activ Distributor Control (click by click)

Do the parts in this order: Supabase, then Vercel, then GitHub. Uploading to GitHub triggers the Vercel build, so Vercel settings must be ready first.

---

## PART 1 — Supabase

Open https://supabase.com/dashboard and click your project (DeadlyV2002's Project, org Hevlon Cosmetics). The icons down the left edge are the main menu; hover over one to see its name.

### Step 1.1 — Back up anything you want from the old app
1. Left menu → **Table Editor** (second icon, looks like a grid).
2. At the top of the table list, make sure the schema dropdown says **public**.
3. Write down the name of every table and view in the list. All of them belong to the old app.
4. For any table whose data you want to keep: hover its name → click the **⋯** next to it → **Export data** → **Export table as CSV**. The file downloads to your computer.

### Step 1.2 — Delete the old tables
1. Still in Table Editor, hover the first table → **⋯** → **Delete table**.
2. In the pop-up, tick **Drop table with cascade** → click **Delete**.
3. Repeat for every table and view in the list until it is empty.
4. Left menu → **Database** (cylinder icon) → **Functions** in the inner menu. If any functions are listed under schema **public**, click **⋯** next to each → **Delete function**.

Your login accounts (Authentication → Users) are not touched by this.

### Step 1.3 — Create the new tables
1. On your computer, open the folder `kolor-activ-distributor and sales` → `supabase` → `migrations`.
2. Right-click `002_remote_sales_inventory_fixed.sql` → **Open with** → **Notepad**.
3. Press **Ctrl+A**, then **Ctrl+C**.
4. In Supabase, left menu → **SQL Editor** (icon that looks like `>_`).
5. Click **+** (or **New query**) at the top.
6. Click inside the empty editor and press **Ctrl+V**.
7. Click **Run** (bottom right) or press **Ctrl+Enter**.
8. You should see **Success. No rows returned**. If a warning asks about destructive operations, click **Run this query**.
9. Check: Table Editor should now list `collections`, `distributors`, `inventory_batches`, `inventory_transactions`, `products`, `profiles`, `retailers`, `sales_invoices`, and the view `distributor_stock_summary`.

### Step 1.3b — Run the v2 update
SQL Editor → New query → paste all of `supabase/migrations/003_distributors_tally_history.sql` → Run. Safe to run more than once.

### Step 1.3c — Run the v3 update
SQL Editor → New query → paste all of `supabase/migrations/004_super_stockist_formats_aliases.sql` → Run.

### Step 1.3d — Run the v4 update (before the v4 code goes live)
SQL Editor → New query → paste all of `supabase/migrations/005_locations_transfers_so_checks.sql` → Run. It should end with **Success. No rows returned**. Supabase warns about destructive operations because the script drops and recreates views and functions; no data is deleted, so click **Run this query**. Safe to run more than once, and the v3 app keeps working after it runs.

### Step 1.4 — Make yourself admin
1. SQL Editor → **+** new query.
2. Paste and click **Run**:
```sql
update public.profiles set role = 'HO_ADMIN'
where id = (select id from auth.users where email = 'vedantdaga2002@gmail.com');
```
3. It should say **Success** with 1 row affected.

### Step 1.5 — Add your godown, super stockists and distributors (in the app)
Distributors page → **Godowns** tab: add your godown. Company = your company name exactly as it prints on your Tally reports, so the app recognises your own files.
Then **Distributors** tab → **Import from Excel** with your distributor list. A Super Stockist column creates the super stockists automatically; fill in their details on the **Super stockists** tab afterwards.

### Step 1.6 — Turn off public sign-up
1. Left menu → **Authentication** (padlock icon).
2. Inner menu → **Sign In / Providers**.
3. Under **User Signups**, switch **Allow new users to sign up** OFF.
4. Click **Save changes**.

### Step 1.7 — Set the site address
1. Authentication → **URL Configuration**.
2. **Site URL**: `https://salescontrolapp.vercel.app`
3. Click **Save changes**.

### Step 1.8 — Add staff logins (whenever needed)
1. Authentication → **Users** → green **Add user** → **Create new user**.
2. Enter email and a password. Tick **Auto Confirm User**.
3. Click **Create user**. Give the person their email and password.

### Step 1.9 — Copy the two keys for Vercel
1. Click the green **Connect** button at the top of the Supabase page.
2. Open the **App Frameworks** tab, choose **React** and **Vite**.
3. Copy the value after `VITE_SUPABASE_URL=` (starts with `https://kfqlpgvjokrdajivjwrb.supabase.co`) into Notepad.
4. Copy the value of the key line (starts with `sb_publishable_`, or a long `eyJ…` anon key) into Notepad.

Never copy the **secret** or **service_role** key.

---

## PART 2 — Vercel (before uploading code)

Open https://vercel.com/hevlon-cosmetics.

### Step 2.1 — Build settings
1. Click the **sales_control_app** card.
2. Top menu → **Settings**.
3. Left menu → **Build and Deployment**.
4. **Framework Preset**: choose **Vite**. Leave Build Command, Output Directory and Install Command on default (overrides off). Click **Save**.
5. **Root Directory**: delete whatever is in the box (e.g. `sales_app_fixed`) so it's empty. Click **Save**.

### Step 2.2 — Environment variables
1. Still in the project's Settings → left menu **Environment Variables**. (Use the project's page, not the team-level one on the main dashboard.)
2. If old variables exist from the previous app, click **⋯** → **Delete** on each.
3. Add the first variable: Key `VITE_SUPABASE_URL`, Value = the URL from step 1.9, tick **Production** and **Preview** → **Save**.
4. Add the second: Key `VITE_SUPABASE_PUBLISHABLE_KEY`, Value = the key from step 1.9, same environments → **Save**.

Spelling must be exact: all capitals, underscores.

### Step 2.3 — Delete the second project
The `sales_app_fixed` project builds from a folder that is about to be deleted, so it will fail on every upload.
1. Go back to the dashboard → click **sales_app_fixed**.
2. **Settings** → scroll to the bottom of **General** (in some layouts it's under **Advanced**) → **Delete Project**.
3. Type the project name when asked → **Delete**.

---

## PART 3 — GitHub (replace the old code)

Since v3 the code is pushed with git from `C:\Users\Samsung\Hevlon-Cosmetics` (a clone of the repo), which replaces the manual steps below. They are kept for reference.

Open https://github.com/DeadlyV2002/Hevlon-Cosmetics.

### Step 3.1 — Delete the old folder
1. Click the **sales_app_fixed** folder.
2. Click **⋯** at the top right of the file list → **Delete directory**.
3. Click the green **Commit changes…** → **Commit changes**.

### Step 3.2 — Delete the two zip files
1. Back on the repo home, click **Sales_Control app.zip**.
2. Click **⋯** at the top right → **Delete file** → **Commit changes…** → **Commit changes**.
3. Do the same for **Sales_Control_app_fixed.zip**.

### Step 3.3 — Upload the new code
1. Repo home → **Add file** → **Upload files**. (If the repo shows an empty-repo screen, click the **uploading an existing file** link.)
2. In File Explorer, open `kolor-activ-distributor and sales`.
3. Press **Ctrl+A** to select everything inside it: `src`, `supabase`, `.env.example`, `.gitignore`, `DEPLOY-STEPS.md`, `DEPLOYMENT-AUDIT.md`, `index.html`, `package.json`, `package-lock.json`, `README.md`, `tsconfig.json`, `vercel.json`, `vite.config.ts`.
4. Drag the selection onto the GitHub upload box. Wait until every file shows in the list.
5. Scroll down. In the message box type: `Replace with distributor inventory app v2`.
6. Keep **Commit directly to the main branch** selected → **Commit changes**.
7. Check the repo home: `package.json`, `index.html`, `src` and `supabase` must be at the top level, not inside another folder. If they ended up inside a folder, you dragged the folder itself; delete it and redo 3.3 selecting the contents.

Never upload a `.env` file, `node_modules` or `dist`.

---

## PART 4 — Check the deployment

1. Vercel → **sales_control_app** → **Deployments**. A new build started automatically from the GitHub commit.
2. Wait for **Ready** (green), usually 1–2 minutes.
3. If it shows **Error**, click it → open the **Building** logs → copy the red lines and send them to Claude.
4. If it built before you added the variables: on the newest deployment click **⋯** → **Redeploy** → **Redeploy**.

---

## PART 5 — Test the app

1. Open https://salescontrolapp.vercel.app. If you see **Setup needed**, the environment variables are missing or misspelled (step 2.2); fix them and redeploy.
2. Sign in with your email and password.
3. Inventory → upload your godown's Tally Stock Summary. The yellow or green box under the type buttons says what the app read the file as; check it, then **Save stock count**.
4. Upload a Tally sales register of dispatches to super stockists. The review table should say **transfer to …** on each row. Save it, then check the super stockist's stock on the Distributors page.
5. Undo any test posting on the **History** page.
