# Deployment Package Audit

## v11 (26 Sep 2026) — run `supabase/migrations/012_distributor_status.sql` after 011
- Every confirmation (save stock, move stock, delete, undo, merge, import, testing mode) is now asked inside the page. Browser pop-ups were blocked in some windows, so Save Stock Count and other buttons did nothing there.
- A stock count can be saved again from the same file any number of times (it sets stock to the counted figures, so nothing is counted twice). Purchase and sales files still warn before being counted twice.
- The details block above a closing stock table (SS/DB name, town, SO or ASE, HQ, month, stock taking date) is read and shown. It picks the distributor, can add a distributor that is not listed (with town, HQ and SO filled in), and sets the distributor's SO if it has none.
- If a stock file would create new product names while DSR products are missing from the product list, the page offers to add the DSR products first.
- Distributors: Active / Dormant status (click to change, filter, import column). Re-importing a list matches rows by code, then name and town, then name alone when unique, and updates them; only new rows are added (re-importing the DB List: 151 updates, 0 new).
- SO Reports: clicking a person (tree or table) opens their report: summary figures (this month, last month, MoM and YoY, strike rate, days worked, distributors, last report) and closed sections for month by month, attendance, distributors worked, products, recent days and team; Present, Print, Export Chart.

## v10 (25 Sep 2026) — run `supabase/migrations/011_products_stock_checks_merge.sql` after 010
- Closing stock statements with two product tables side by side are read in full (the right-hand table was being dropped). Category subtotal lines ("Compact Total", "Grand Total") are left out; blank or dash stock counts as none; the stock date comes from "Stock taking Date" (spaces allowed) or "Month:". Products with their own rate are never mistaken for group totals. Tested on 11 distributor statements: every product line read, Rajkumar Traders adds up to the sheet's Grand Total of 53,780.
- The distributor is found from the file name and heading even when spelled differently, helped by the town. A closing stock heading now wins over an SO/ASE name in the heading.
- Products named slightly differently in a file ("Waaah" / "Waah") are matched when the rate agrees, and remembered. Each line's rate is checked against the product's SS rate and differences are shown.
- Pricing: Add DSR Products builds the product list from the DSR price list (SS rate per dozen; stock statements use dozens too).
- SO Reports reorganised into tabs (Overview, Team, Stock Checks, Attendance, Daily Log, Products, Upload DSR, Sales Team) under one filter bar. The team tree starts closed, hides people with no reports unless asked, and shows each person's distributors worked. Stock Checks compares what SOs booked at each distributor, product by product, with what the distributor had before the period plus what it received, and with how much its stock went down when a stock count was posted.
- Sales Team: entries that look like the same person are listed with a Merge button (reports, distributors and team move over; the other spelling is kept).
- Charts label their peak values. A clear (✕) button appears in any text box with something in it. Long lists (distributors, collections, payments, staff, SO logs) scroll inside the table with the headings kept on top. The stock upload's "left out" list no longer pushes the page sideways, and its Add Back buttons line up.

## v9 (25 Sep 2026) — run `supabase/migrations/010_staff_dsr_logbook.sql` after 009
- Sales team: posts ASM, ASE, SO, ISR, SR with reports-to, zone, HQ and areas. The staff list imports from Excel, PDF or Word; people are matched by name, including shorter spellings ("Amiya Kumar" and "Amiya Kumar Mohapatra"), which are kept as other names. Where a zone has one ASE (or ASM), the people below are linked to them; the DSR's reporting manager becomes a senior and is added as an ASM if new.
- DSR uploads: several workbooks at once, any states. Every sheet is listed with how it was read (SO daily, state total, summary). New days are added; days already logged stay as they are; a person's day logged with different figures is flagged as a discrepancy and only replaced if you tick it; the same person twice on one day in an upload is flagged and kept once. State total sheets are stored and compared with the SO sheets.
- SO Reports: the latest day (who worked, calls, secondary, who didn't report), a zone → ASM → ASE → SO tree with totals, search by person, HQ, area or town (brings in seniors and their teams), charts (daily secondary, top people, products, categories) with export, checks of SO bookings against each distributor's billing, stock and collection, and DB names not in the distributor list.
- Dashboard: running totals at the top (stock, secondary this month, latest day, collected this year, outstanding); new charts for secondary sales, best and weakest staff, products, days worked and collection %; the 10 key charts to start with, 4 pinned; unpinned and remaining charts rotate every 20 seconds (paused under the mouse); the pin keeps a chart in place. Old layouts move once to this set.
- Several files at once everywhere files are uploaded: stock files (opened one after another), distributors, retailers, payments, price lists, staff lists and DSRs. Word (.docx) files are read (tables, or text). Payments and price lists read every sheet of every file.
- Retailers tree: a search box on each state and super stockist branch.
- Log book (Settings, HO admins): each sign-in, how long the app stayed open, and how much of that time it was actively used.

## v8 (25 Sep 2026) — run `supabase/migrations/009_collections_dsr_reports.sql` after 008
- Collections page: record payments (distributor to super stockist, super stockist to company) or import them from Excel; billing vs collection per party with collection %, outstanding, last bill and payment, and flags (heavy orders with low payment, under half paid, no payment in 45+ days). Billing is stock received from the supplier at the invoice rate, or the SS rate plus margins.
- SO Reports page: upload the whole DSR workbook daily; each SO sheet's days replace what was there. Attendance comes from an Attendance column if present, otherwise from the remark and calls. Per-SO summary (present, leave, off, calls, productive calls, strike rate, secondary sales, sales per call and per working day, flags against the team average), an attendance grid, the daily log and products sold. The DSR product list and SS rates per dozen are stored.
- Distributor report (click any name): contact details, stock, last bill and sale, MoM and YoY, collection %, monthly chart and table; Present (full screen), Print and Export Chart (PNG).
- Excel-style column filters and sorting on the distributor list, collections, SO reports and payments.
- Comments open in a centred dialog; the location picker panel stays on screen in any window size.
- Super stockists outside the chosen state or region are greyed out in the filter bar and the distributor form.
- Retailers tree: distributor counts per state and SS; retailer counts hidden until retailer data exists; cards show stock, billing and collection %, sortable best to worst.
- Sheets with a stray value in the last Excel row (row 1,048,575) no longer freeze uploads; only cells with content are read.
- Tested with the real Odisha DSR (857 SO-days, 6 SOs, 151 products, 51.5 lakh), a payment, the report, comments and column filters at 900 px.

## v7 (25 Sep 2026) — run `supabase/migrations/008_pricing_lock_contacts_reminders.sql` after 007, then set up reminders (DEPLOY-STEPS 1.3g)
- The distributor import reads the DB List sheet as the template: DB Name is the distributor and its company name, DB Town its city, HQ its region, SS Name and SS Town its super stockist (created if new), SO/ASE Name its SO (created if new), Contact.No its phone, Contact Person its owner, and an optional Email column. Before, SO/ASE Name was read as the distributor's name and DB Name was skipped, so every row looked incomplete and nothing imported.
- Phone numbers lose a leading 91 (or 0); two numbers in one cell are both kept, separated by a comma.
- The sheet is the master list: the import preview lists distributors in the app that aren't in the sheet and can remove the ones without stock. "Download DB List template" gives the sheet's layout.
- Pricing page and pricing data are locked to logins in `pricing_access` (only the owner to start); other logins, HO admins included, don't see the page and can't change prices, margins or schemes.
- Monthly stock reminders by email (Resend) and WhatsApp (Business Cloud API) from a Supabase Edge Function run daily by pg_cron: the first on a set day, follow-ups every few days after the due day until a file from that distributor is posted. Settings shows who has sent last month's stock, who was reminded, and any sending errors.
- Dropdowns are drawn by the page, so they open under their field in any window (native dropdowns opened on the wrong side of the screen in split and embedded windows). Long lists can be searched by typing.
- Dashboard charts enlarge on click only (no hover); close with ✕, Esc or a click outside. The chart editor panel no longer inherits the sidebar's fixed position, which caused the glitch in the enlarged view. A second "Add a chart" button sits at the end of the dashboard.
- Retailers tree: state → super stockist → distributor cards with retailer counts and names; a card opens to the full list. SO checks: seven summary tiles, one panel with the chosen check, thresholds shown only on the checks that use them. Reports bar labels no longer overlap in narrow windows. Header buttons wrap instead of spilling; form rows keep inputs aligned; messages under forms have reserved space so the page doesn't jump.
- Names typed or imported are written like Excel PROPER ("SHARMA TRADERS pvt ltd" → "Sharma Traders Pvt Ltd"; two-letter capitals such as SS stay). Button labels are in Title Case. Import previews say "Ready" or "Needs …" in a Check column instead of a tick under "Missing".
- Once a type has records, the Distributors page shows the list first and the add/import form below it; Edit and a new import scroll down to the form.
- Tested in the browser with the real DB List (151 distributors, 23 SOs), move stock (479 units from one location to another), reminders timing, the pricing lock, and every page at 600, 960 and 1100 px wide with no overflow.

## v6 pricing (25 Sep 2026) — run `supabase/migrations/007_pricing_margins_schemes.sql` after 006, before pushing the code
- Stock is valued at the SS rate (what you bill super stockists) on every page, chart, alert and download. A product without an SS rate is valued at its last purchase rate and flagged on the Pricing page.
- The SS rate fills in by itself the first time a godown dispatch to a super stockist carries a rate (the scheme discount running that day is added back). After that it only changes on the Pricing page.
- Pricing page: standard margins for super stockists and distributors (10% and 15% to start; ₹100 → ₹110 → ₹126.50); schemes with dates, a billing discount for super stockists and/or different margins, covering all super stockists or chosen ones; a product table with SS rate and MRP editable, the price to distributors and retailers, MRP ÷ SS rate, a warning when the retailer price passes MRP, and price-list download and upload.
- "Stock sent out vs stock sold" values godown dispatches at what you bill: the SS rate less any scheme discount for super stockists, the SS rate plus the SS margin for distributors supplied directly.
- Where schemes overlap, the biggest discount applies and the scheme that started last sets the margins. Prices on the Pricing page use margins from schemes that cover every super stockist.
- Tested: 007 on Postgres (PGlite) with 13 checks, plus the 006 checks; the app in a browser with test data (SS rates filled from dispatches, saving prices, adding a scheme for one super stockist, changing margins, dashboard totals at SS rate).

## v5 (25 Sep 2026) — run `supabase/migrations/006_delete_testing_dashboard.sql` before pushing the code
- Dashboard is charts only: ten insight charts, the first three large at the top. Each has a plain title saying what it shows, a one-line explanation, a summary sentence with the key number, and values on the chart. Charts: stock held week by week; stock piling up unsold; SOs reporting far more than usual; reordering stock they already hold; stock sent out vs stock sold; SO sales without stock behind them; fast sellers about to run out; where stock is sitting; distributors gone quiet; stock missing at counts. Four more can be added: best-selling products, products not moving, SO sales the distributor's data doesn't show, unverified outlets in SO reports.
- Resting the mouse on a chart for half a second enlarges it to fill the screen with a gap round the edge; moving into the gap shrinks it back (Esc and ✕ work too; tap on phones). The enlarged chart has Customize: name, measure (₹ or units), period and thresholds, what each bar stands for, how bars are split, which lines show, which locations (the filter bar), how many bars, values on or off, show large at the top, move up or down, remove. Each user's layout is saved to their account.
- Alerts bell in the header: SO days far above their usual, SO sales beyond the distributor's stock, reorders while holding plenty, stock unsold for 3+ months, fast sellers running out, distributors quiet for 15+ days, stock missing at counts, locations with empty details. Each opens the chart that explains it.
- Delete any godown, super stockist or distributor, even with stock: move its stock to another location first or delete it with it; a super stockist's distributors can be moved to another one. Transfers it was part of stay at the other end, with its name on them.
- Move stock between any two locations from the Inventory page ("Move everything it holds" fills in all of it).
- Settings page (replaces Team): testing mode switch; while it's on, HO admins can clear all data (type DELETE); delete unused products.
- Stock count gaps (SO checks) and the dashboard leave out each location's opening count. "Gone quiet" counts any file posted as the location's own, so super stockists that send dispatch registers aren't flagged.
- Tested: 006 twice on Postgres (PGlite) with 34 checks, plus the 57 v4 checks; the whole app in a browser against the real SQL with four months of generated activity (all ten charts, the bell, hover-enlarge, customize and save, move stock, deleting with stock and with distributors moved, testing mode, clear all data).

## v4 (24 Sep 2026, later) — run `supabase/migrations/005_locations_transfers_so_checks.sql` before pushing the code
- Stock locations: godowns, super stockists and distributors live in one list with a type, state and region; each distributor links to its super stockist. v3's free-text super stockist names were turned into super stockist records.
- Transfers: stock sent to, or received from, one of your own locations moves at both ends (godown → SS → distributor, or godown → distributor directly). Receiving the same goods from the other side's file is spotted ("already recorded") and skipped. "Don't reduce the sender's stock" covers senders whose stock isn't in the app yet.
- One upload box: the app works out whether a file is closing stock, stock received, stock sent out or an SO daily report, and whose stock it is, from the heading, file name, columns and parties. It says why, and the user can change it. The count date is read from Tally headings ("1-Apr-26 to 24-Sep-26" → 24 Sep).
- Stock download (replaces the template button): one location typed by name, or any filtered set; latest stock, or a date range with opening, received, sent / sold and closing, plus Summary and Movements sheets.
- SO daily reports and the SO checks page: sold without stock, stock to clear (unsold over N days, FIFO), SO vs distributor sales (over the days the distributor's data covers), retailer problems, running low, no recent data, stock count gaps. Each list downloads to Excel. SO list with other names; SO reports can be removed.
- Distributors page: tabs for distributors, super stockists and godowns; every field required except other names (region is optional for SS and godowns); incomplete records are marked. Import creates missing super stockists, normalises states ("RJ", "U.P." → Rajasthan, Uttar Pradesh) and skips incomplete rows unless told otherwise. Comments on every location. The grey example names in the form (which looked like saved data) are gone.
- Filter bar on Distributors, Retailers, Reports, SO checks and the download: state, region, super stockist, pick any locations, quick picks (top 10 by stock value, no stock) and saved selections.
- Reports: stock by state / region / super stockist / location / product as a bar chart split by godown, SS and distributor; clicking a bar drills down. Dashboard shows stock across India, split the same way, and by state.
- Retailers: tree (state → super stockist → distributor → retailers) and table views, add / edit / delete, Excel import and export.
- Fixed: every list was cut off at 1,000 rows (Supabase's per-request limit); lists now load in pages. A register line equal to the sum of the next lines was left out as a "group total"; that rule now only applies to stock summaries. "Today" was yesterday before 5:30 am (UTC).
- Tested: migrations 002–005 twice on Postgres (PGlite) with 57 checks (transfers, receipt-only, oversell block, counts, period stock, aged stock, all SO checks, comment authorship, permissions, undo). Detection and parsing on 6 realistic files. The full app in a browser against the real SQL: godown, SS and distributor setup and import, comments, all four upload types, duplicate transfers, stock download files, SO checks, reports, retailers.

## v3 (24 Sep 2026) — run `supabase/migrations/004_super_stockist_formats_aliases.sql` after 003
- Fixed: "Save stock count" looked dead when rows had problems (usually an unknown distributor) because the message showed at the top of the page. Problems now show next to the Save button, the first bad row is scrolled into view, and an unknown distributor can be fixed in one click (add as new, or save the file's name as another name of an existing distributor).
- Distributors: owner name, company name and super stockist (with suggestions). Company name also counts for matching files. Filter by super stockist.
- Distributor import: finds the heading row, recognises Distributor / Company / Owner / Super Stockist / City / Mobile / Other names columns, shows a preview with editable column choices, updates existing distributors (same code or name) and keeps values where the sheet is blank.
- Remembered formats: when a file is saved, its column setup is stored by its headings; the next file with the same headings is read the same way automatically.
- Product names: "Same as" lets you say that a distributor's product name is one of your products; the app remembers it (product_aliases) and matches it automatically in future files, in the browser and in the database.
- Stock statements with Opening / Receipt / Sales / Closing columns are recognised (Closing for stock count, Receipt for stock IN, Sales for stock OUT).
- Reports: stock by super stockist, super stockist column and filter, included in the Excel export.

## v2 (24 Sep 2026, later) — run `supabase/migrations/003_distributors_tally_history.sql` after 002
- Distributors page: add / edit / delete, alternative names (as printed on Tally reports), Excel import. Only HO admins and state managers can change them (enforced in the database).
- Matching by name: distributors match on code, name or any alternative name; products match on SKU or name. "M/S", "Pvt Ltd", capitals and punctuation are ignored.
- One upload box reads Excel (xlsx/xls/xlsm/xlsb/ods), CSV/TSV, Tally exports (Excel, XML incl. UTF-16, JSON, HTML, ASCII/TXT, PDF), scanned PDFs and photos (OCR).
- Header detection finds the column row anywhere in the first 40 lines, including Tally's two-line headers (Closing Balance → Quantity / Rate / Value), and picks Inwards / Outwards / Closing by mode. Every column can be re-assigned in the app.
- Tally group lines, totals and blank rows are left out automatically and listed under "Left out" with a reason and an "Add back" button.
- The distributor is detected from the report heading or file name.
- New "Stock count" mode sets a distributor's stock to Tally closing quantities and records the difference.
- The same file can't be posted twice by accident (SHA-256 fingerprint).
- History page lists every posting with its lines; managers can undo a posting (blocked if that stock was already sold).
- Review table flags problems before posting: unknown distributor, product never stocked in, not enough stock, missing retailer, bad date.
- Removed the empty Sales and Collections pages (nothing wrote to those tables); Reports now has stock by distributor and value, exported to Excel.
- Tested: parser against 9 sample formats; database functions on Postgres; the full upload → review → post flow in a real browser.

## v1 (24 Sep 2026)

`npm install` and `npm run build` (tsc + vite) pass. The SQL migration was run twice against Postgres with stubbed Supabase auth and tested for stock-in, stock-out, oversell blocking, unknown SKU and unknown distributor.

## Fixed in this pass
- styles.css did not match the class names used in App.tsx (login card, sidebar buttons, metric cards, upload grid were unstyled). Rewritten.
- Excel dates arrived as serial numbers (e.g. 45567) and failed on posting. Dates now parse from Excel serials, dd-mm-yyyy, dd/mm/yyyy and yyyy-mm-dd.
- Excel headers now match regardless of case/extra spaces; quantities like "1,200" parse correctly.
- Public "Create account" removed. Anyone could self-register and post stock.
- OUTPUT rows used to create products and overwrite product names/prices with sale values. OUTPUT now requires an existing SKU and never edits the product master.
- Two users posting OUTPUT at the same moment could oversell. Stock-outs are now serialised per distributor + SKU.
- Distributor, SKU and retailer matching is case- and space-insensitive.
- Stock view no longer multiplies every distributor by every product (zero rows); it shows lines that have movements.
- PDF text is rebuilt line by line before row detection (fewer junk matches); pdf.js runs with isEvalSupported:false (CVE-2024-4367).
- PDF.js and Tesseract load only when a PDF is imported. Main bundle went from 997 KB to 144 KB.
- Preview: "set distributor/date for all rows", add row, delete row, clear, and a confirm before posting.
- Re-selecting the same file now re-imports it; unused imports and duplicate CSS import removed; React list keys added.
- Existing auth users get a profile row when the migration runs.

## Known limits
- xlsx 0.18.5 is the last npm release of SheetJS and has published advisories (prototype pollution / ReDoS on malicious files). Risk is low while only staff upload their own files. To upgrade: `npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
- Sales, Collections and Team pages are read-only views. Role-based restrictions (per territory/distributor) are not enforced yet: every signed-in user can see all data and post inventory.
