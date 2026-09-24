# Kolor Activ Distributor Sales & Inventory Control — Rebuilt

This release fixes the previously audited problems:
- All sidebar navigation buttons now change real application modules.
- Inventory Input and Inventory Output are separate.
- Excel/XLSX/CSV imports are parsed into an editable preview.
- PDF selectable text is extracted first. If the PDF is scanned/image-only, the app automatically renders the pages and runs browser-side Tesseract OCR, then sends the OCR text through the same row-detection and editable preview workflow.
- Post Inventory uses an atomic Supabase RPC.
- OUTPUT is blocked when requested quantity exceeds calculated distributor stock.
- Stock is calculated from transactions: INPUT - OUTPUT.
- Stock report can be exported to Excel.
- Templates can be downloaded.
- Login and sign-out are wired to Supabase Auth. Public sign-up is removed; the admin creates accounts in Supabase.
- Dashboard, Distributors, Retailers, Sales, Collections, Inventory, Reports and Team pages are real routes inside the SPA.

## Deploy
See `DEPLOY-STEPS.md` for the full step-by-step (Supabase, GitHub, Vercel).

## Deployment status
This package is deployable as the **Distributor Sales & Inventory Control foundation** after Supabase setup and Vercel environment variables.

Before calling it a complete sales ERP, the following are still intentionally not implemented in this package:
- Sales invoice create/edit/delete workflow
- Collection create/edit/delete workflow
- Admin team invitation UI
- Distributor assignment UI
- Full audit-log screen
- Supabase Storage upload of original source documents
- Territory/role-scoped UI and row-level access beyond the authenticated foundation

Do not treat the Sales, Collections, or Team pages as complete CRUD modules yet; they are database-backed views/instructions.


## Scanned PDF OCR
The app automatically detects low/no selectable text and runs Tesseract.js OCR page-by-page in the browser. OCR results are never posted directly: extracted rows must pass validation and be reviewed in the editable preview first. Clear, high-resolution scans give better results. For difficult handwriting or poor scans, Excel/manual correction remains recommended.
