# Deployment Package Audit

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
