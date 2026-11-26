# GarmentPro — Codes TechVista

GarmentPro is a React and TypeScript warehouse management application with an Express API, Prisma, and PostgreSQL.

## Local setup

1. Install Node.js 20+ and npm. Start PostgreSQL 16 with `docker compose up -d` or use an existing local instance.
2. Copy `.env.example` to `apps/api/.env` and set `DATABASE_URL` for that instance.
3. Run `npm install` and `npm run db:generate`.
4. Apply the migrations with `npm exec -w apps/api -- prisma migrate deploy`.
5. Run `npm run db:seed` only if you want demo records, then run `npm run dev`.
6. Open http://localhost:5173. The API health endpoint is http://localhost:4000/api/health.

### Upgrading an existing Phase 1 database

Back up the database and stop writes before deploying. The first migration, `20261122000100_phase1`, is a baseline for the original Category, Product, and Variant schema. If those tables already exist and match the original Prisma schema, mark the baseline as applied before deploying:

```sh
npm exec -w apps/api -- prisma migrate resolve --applied 20261122000100_phase1
npm exec -w apps/api -- prisma migrate deploy
```

If the database already has a separate Prisma migration history, reconcile that history with the baseline before deploying. The second migration, `20261122000200_inventory_purchases`, adds the purchasing and ledger tables and records an opening movement for each existing nonzero variant balance. A database with invalid legacy stock or threshold values will fail the migration instead of silently changing those values.

### Build and tests

Run `npm run build` to type-check and build the API and frontend. To run `npm test`, migrate a disposable PostgreSQL database or schema, then set `GARMENTPRO_TEST_DATABASE_URL` to that database's URL. The integration tests create uniquely identified records and retain their ledger entries, so use a dedicated test database.

## Workflows

- **Suppliers** under **Customers / Suppliers** supports contact and company details, address, search, editing, and deactivation. Historical orders keep their original supplier name.
- **Purchases** supports purchase orders with a reference, date, and variant-level line quantities and prices. Receive selected quantities or fill all outstanding quantities. Each posted goods receipt has a printable view, and orders can be exported as CSV.
- **Inventory / Stock** supports additional variants, per-variant reorder thresholds, stock in and out, customer returns, supplier returns, damage write-offs, and signed adjustments. A reason and reference are required for all manual movements. Stock out and supplier returns also require a destination.
- **Stock history** provides product, variant, movement type, and UTC date filters. CSV export includes all matching entries across pages.
- **Dashboard** continues to show active catalogue stock, using ledger-backed balances and recorded product cost. Archived variants and their balances remain visible in Inventory / Stock and history.

Stock movement requests reject negative resulting balances. This release has no authorization workflow for overriding that rule. The API and PostgreSQL triggers commit movements and balance changes together and prohibit editing or deleting ledger entries. Account login and role-based permissions are outside the implemented modules. Product and category edits are available through the existing API.

The sample environment and Docker credentials are intended for local development.

## Sales and distribution

Migration `20261122000300_sales_distribution` adds customers, orders, reservations, dispatches, invoices, payments, return records, and sales events. It initializes reservations to zero and preserves existing stock and ledger records. Apply it with the same `prisma migrate deploy` command after backing up the target database.

- Under **Customers / Suppliers**, maintain customers, shops, and wholesale dealers. Archiving a customer preserves existing orders; orders retain a snapshot of the customer's details. Credit terms supply the default due date, and the credit limit is recorded for reference.
- Under **Sales & Distribution**, create a draft, confirm it, then dispatch selected quantities or fill the outstanding quantities. Reservations are optional per order. The Inventory page shows on-hand, reserved, and unreserved quantities. Cancelling releases reservations for the unshipped quantities.
- Each posted dispatch issues a sales invoice for the quantities shipped. Open the PDF to print it, or download it directly. Line discounts are allocated across partial dispatches with exact cent totals.
- **Payments** records cash or bank transfer against the invoiced balance. Both the request key and the payment reference must be unique. The selected order shows payments, credits, recorded refunds, and the balance due.
- **Returns** are available to Admin and Finance. Saleable units go back into available stock and damaged items remain in return history. Credits reduce the unpaid balance first. Any remaining credit becomes a pending refund. After the refund has actually been paid, record a cash or bank transfer settlement with its reference.
- **Dashboard** shows net invoiced sales and units after returns, outstanding payments, top-selling products, and recent dispatches.

Users sign in with an individual account. Admin manages staff and business settings.

## Local demo and verification

Use a dedicated development database. The **Demo workspace** label identifies the supplied local demo UI. The optional seed inserts five sample product styles and opening ledger balances. It does not insert sales or payments. Run the 500-unit integration test against a separate database or schema to exercise the complete workflow.

1. Start Node.js 20+ and PostgreSQL 16 locally. With Docker, run `docker compose up -d postgres`. Keep its port bound to loopback. The current Windows demo can also use an isolated PostgreSQL instance on `127.0.0.1:55432`.
2. Run `npm ci` and `npm run db:generate`. Copy `.env.example` to `apps/api/.env` and set `DATABASE_URL` to the demo database. Run `npm exec -w apps/api -- prisma migrate status` and `npm exec -w apps/api -- prisma migrate deploy`. Use the baseline instructions above for an existing Phase 1 database. Run `npm run db:seed` only for sample records.
3. In one terminal, run `npm run dev -w apps/api` and check [API and PostgreSQL health](http://localhost:4000/api/health). In another, run `npm run dev -w apps/web -- --host localhost --strictPort` and open the [GarmentPro dashboard](http://localhost:5173/). To start both with the defaults, run `npm run dev`.
4. On the first start, set GARMENTPRO_ADMIN_USERNAME and GARMENTPRO_ADMIN_PASSWORD in the API process environment and run npm run auth:bootstrap after applying migrations. Use a unique password of at least 12 characters. Clear the password environment variable after bootstrap and store the credential privately. Sign in and add individual accounts under Settings. Roles are Admin, Warehouse, Sales, and Finance.
5. In **Purchases**, add a supplier and purchase order, post a goods receipt, and check **Inventory / Stock** for on-hand and unreserved quantities. **Record movement** supports manual stock in, stock out, and damage. Review the corresponding immutable entries in **Stock history**. For sales, confirm an order, dispatch, then download its invoice PDF and post a payment under **Payments**. Use a separate reference for each transaction and verify the order's paid amount and balance due.
6. For repeatable tests, apply migrations to a disposable schema, set `GARMENTPRO_TEST_DATABASE_URL` to that schema, run `npm test`, and run `npm run build` for the API and frontend. The test suite writes records and is intended only for disposable environments. The demo and verification databases must use different schema names or database names.

### Current demo boundaries

The checkout has the Phase 1–3 modules described above and a local sales reconciliation report. Reports provides a read-only sales reconciliation with order and customer search, sorting, and pagination. Admin can manage staff and set invoice business details in Settings. Newly generated invoices preserve a snapshot of those details. Sales dashboard totals, invoice PDFs, purchase CSV, and inventory history CSV are available. Damage movements are separated in the ledger and deducted from saleable stock. The system has no damaged-stock bin balance. After partial dispatch, **Cancel remaining units** releases only the stock reserved for the unshipped balance and preserves posted transactions.

### Product photos, serials, and filters

Add a JPEG, PNG, or WebP photo in the product form. The browser prepares a compact thumbnail, and PostgreSQL stores the photo with its product. The catalogue and variant inventory show the photo, selling price, and category serial. SKU remains a separate identifier. The serial starts at 1 in each category and is assigned by PostgreSQL. Archiving does not recycle a serial, and moving a product to another category assigns its next serial. The migration fills serials for existing products. Existing products without photos show an empty photo cell.

Use **Search** to apply text and date filters. Date presets are Today, Last 7 days, This year, and Custom dates. Dates use UTC. Products and current stock filter by product creation date, while stock history filters by movement date. Purchases use order date, Sales uses order creation date, and Payments uses posted payment or return date. The Sales overview filters by actual dispatch and return dates, and shows the current outstanding balance separately across all dates.

### Expanded warehouse demo and pricing

Run `node scripts/seed-warehouse-demo.mjs` only against a local demo database. Set the local demo administrator credentials in the script process environment and clear them afterward. It adds twelve requested category groups, five subcategories and one demo style per subcategory, with two variants per style. Demo suppliers, receipts, sales, and payments use identifiable demo references. Repeat runs reuse those references. Illustrative sample photos are added only to designated demo products.

The dashboard shows on-hand inventory and an all-activity summary. Choose a date in Sales overview to narrow sales, net units, ledger stock in/out, and gross profit or loss to posted activity in that period. New sales snapshot the catalogue unit cost when created. Older orders without a snapshot use current catalogue cost as an estimate. Use Reports to inspect product-level gross profit or loss and to calculate estimated tax using an entered rate. The calculator does not change posted invoices or establish a tax rate.

### Quick Sale for the shop counter or warehouse

Open **Quick Sale** or use **New sale** on the dashboard. Search using a product name, SKU, or category, then add the required size and color. Select a customer for a sale on account, or leave the default Walk-in customer for a paid sale. Use the sale location to identify the counter or warehouse.

**Post sale & create invoice** posts a dispatch and reserves no additional stock. It deducts only stock that is not already reserved, creates the invoice, and records a full cash or bank payment when selected. On-account sales stay unpaid and can be settled in Payments. A failed checkout does not leave a partial sale, and resending the same checkout request returns the existing invoice.

Use **View & print** to open the invoice in the browser PDF viewer or **Download PDF** to save it. The invoice also remains accessible under Sales & Distribution. Use the regular sales order workflow to reserve stock or dispatch later.

### Catalogue actions, stock alerts and bulk import

Products and categories have View, Edit, Activate/Deactivate and Delete actions. Inactive products and products under an inactive category stay in stock history and are excluded from new sales. A product with no remaining stock can be removed from the catalogue without erasing its sales or ledger history. Delete is available only for empty categories. Physical zero stock displays as Coming Soon and appears in the in-app stock bell while the product is active.

In Products, choose **Import products** and download the CSV template. Upload an Excel .xlsx or CSV file, or paste rows from Google Sheets including the column headers. Use one row per size/color variant and repeat all product details for the same product SKU. Up to 500 variant rows are accepted. The import creates missing categories, rejects conflicting or existing SKUs, and writes opening balances to the ledger. The preview precedes a single atomic import.

### Staff sign-up and recovery

Staff can create an account with an email address from the sign-in screen. In **Staff & Permissions**, an administrator verifies the staff member’s identity, activates the account and selects the allowed modules. Roles provide suggested module permissions and control which sales actions a staff member can perform. The server checks permissions independently of the sidebar. Settings remains available for changing the signed-in user’s own password.

For password recovery, an administrator can generate a single-use code in **Staff & Permissions** and share it privately with the verified staff member. The code expires after 15 minutes. The staff member enters it under **Forgot password?**, sets a new password and signs in again.

### Day Look and Activity Logs

**Day Look** shows posted dispatches, return credits, recorded payments and refunds, receipts, and stock movements for one UTC date. It includes historical transactions already in the database. **Activity Logs** records committed catalogue, customer, supplier, order, receipt, stock, return, and payment changes from the activity migration onward. Entries are written in the same database transaction as the operation and cannot be edited or deleted through the application. Use module, date, and reference filters to find entries. New changes identify the signed-in staff member. Historical entries without an actor are marked Unattributed.

### Shops and branches

Open **Shops & Branches** as an administrator. Create a shop and at least one branch, then pick the branch from the top bar. The original workspace retains existing records. New branches start empty and use separate PostgreSQL schemas, including separate catalogues, customers, stock ledgers, invoices, payments and activity. Branch invoices start with the shop name and can be customized in Settings.

Approve staff with **Assigned branches only** enabled, then select the branch and grant module permissions in **Shops & Branches**. An administrator can assign the branch-manager flag. Branch managers can delegate their own modules to approved branch-only accounts. The shop finance view totals only branches the signed-in user can report on.

Prisma CLI and the checked-in migrations must be available to provision branches. The runtime PostgreSQL role needs schema creation rights. Before upgrading a workspace with branches, stop writes and take a PostgreSQL backup. With DATABASE_URL pointing to the original workspace, run `npm run db:migrate:all`. It applies pending migrations to the original schema and each ready branch. If any schema fails, resolve its Prisma migration error and rerun the command before restarting the API.
