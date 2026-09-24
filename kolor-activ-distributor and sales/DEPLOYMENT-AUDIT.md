# Deployment Package Audit

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
