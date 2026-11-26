# GarmentPro QA Audit Report

**Date** 2026-11-22  
**Scope** Phase 1 catalogue and dashboard, Phase 2 purchasing and inventory, Phase 3 customers, sales, dispatch, invoices, payments, and returns.  
**Disposition** Production release blocked by one Critical and five High application findings. Two additional High upstream advisories affect the locked Prisma toolchain, with application reachability unverified.

## Verification performed

- Reviewed the Express entry point, route registration, input validation, Prisma schema, all three migrations, and the corresponding React screens. Application findings below were confirmed by tracing the executable code and, where indicated, existing test behavior. No adversarial payloads or live-system probes were used.
- The production build passed. Vite reported a JavaScript chunk above its 500 kB warning threshold.
- All 15 existing tests passed against disposable PostgreSQL 16 after the three committed migrations were applied. The suite covered catalogue creation, edit, search and archive, purchase and partial receipt handling, concurrent receipts, ledger protections, reservations and dispatch, duplicate requests, partial payments, returns, and dashboard reconciliation.
- Ran a read-only npm advisory scan on the lockfile. This was a source and isolated test database audit. Production network controls, deployment configuration, production data, and browser behavior were outside this run.

## Critical

### GP-C01 — Warehouse and financial writes lack access control

**Confirmed by route and listener inspection.** The Express bootstrap mounts the warehouse and sales routers without authentication or role checks. Purchase receipts, inventory movements, dispatches, and payments accept requests without a trusted operator identity. The sales return route has a separate shared-key check. The API listener supplies a port without restricting the bind address; the CORS configuration governs browser access and supplies no access control over the API itself. The existing integration tests successfully post those records without credentials, confirming the behavior in the application. No assumption is made about an external proxy or firewall. [API bootstrap](../apps/api/src/index.ts#L8) · [Listener](../apps/api/src/server.ts#L4) · [Purchase receipts](../apps/api/src/warehouse.ts#L187) · [Stock movements](../apps/api/src/warehouse.ts#L231) · [Dispatch](../apps/api/src/sales.ts#L179) · [Payments](../apps/api/src/sales.ts#L225)

**Impact.** Any caller with network access to the API can post valid-looking, durable stock or financial transactions. Ledger immutability preserves those entries and cannot attribute them to an operator. The sales event schema records the action, reference, and time but has no operator identity. [Sales event model](../apps/api/prisma/schema.prisma#L305)

**Remediation and regression.** Introduce server-verified identities and operation-level permissions for mutations. Persist authenticated actor identifiers with new audit entries. Preserve historical entries without inventing actors. Cover unauthenticated, insufficient-role, and authorized requests for receiving, inventory adjustments, dispatch, and payments. Verify rejected requests leave quantities, financial balances, and audit records unchanged.

## High

### GP-H01 — Customer, supplier, and commercial records lack read authorization

**Confirmed by response and route inspection.** Customer list responses include contact details, address, and credit information. Sales order reads include customer snapshots, payments and returns. An invoice download includes customer contact and address data. Supplier lists and purchase exports also expose business contact or purchasing details without a verified reader. These routes rely on the same unguarded application mount. [Customer and order reads](../apps/api/src/sales.ts#L84) · [Invoice route](../apps/api/src/sales.ts#L282) · [Invoice content](../apps/api/src/invoice.ts#L22) · [Supplier and purchase reads](../apps/api/src/warehouse.ts#L117)

**Impact.** A caller that can reach the API can read customer information, prices, payment history, and invoices without being granted that access. Exposure through an external deployment was not evaluated.

**Remediation and regression.** Enforce permissions on lists, direct lookups, PDFs and CSV exports, including record-level restrictions where roles require them. Verify allowed readers retain existing screens and exports while other callers receive no protected records.

### GP-H02 — Manual customer returns bypass the sales return workflow

**Confirmed by validating the two route paths.** Inventory labels its generic `RETURN_IN` movement as a customer return. The warehouse route accepts it with a generic reference and reason, immediately posts stock, and does not validate a dispatched order line or enforce the return key. The linked sales workflow checks authorization, limits returns to already-dispatched quantities, distinguishes damage, and posts credits. Both workflows can appear to accept the same physical customer return, with no shared uniqueness or linkage between them. [Inventory movement UI](../apps/web/src/Inventory.tsx#L6) · [Warehouse movement types](../apps/api/src/warehouse.ts#L53) · [Warehouse posting](../apps/api/src/warehouse.ts#L231) · [Sales returns](../apps/api/src/sales.ts#L241)

**Impact.** Staff can unintentionally restock a sales return without adjusting the order, or post the same physical return through both workflows. This may overstate sellable stock and leave the customer's balance incorrect.

**Remediation and regression.** Retain the linked sales return as the customer return workflow. Define a separately named and permissioned process if standalone returns are required for legacy sales. Preserve existing ledger entries. Verify authorized returns post one stock change and one financial adjustment, and that generic inventory operations cannot post the same sales return as an unlinked movement.

### GP-H03 — Unshipped reservations cannot be released after a partial dispatch

**Confirmed by status transition and reservation inspection.** Cancellation accepts only Draft and Confirmed orders. The React screen hides cancellation for Partially Dispatched orders. A partial dispatch releases the reservation only for the shipped quantity. The remaining reservation reduces usable stock for other warehouse and dispatch operations, and no route releases the unshipped remainder without shipping it. [Cancellation](../apps/api/src/sales.ts#L153) · [Reservation decrement](../apps/api/src/sales.ts#L202) · [Warehouse stock guard](../apps/api/src/warehouse.ts#L81) · [Sales actions](../apps/web/src/Sales.tsx#L70)

**Impact.** If a customer cancels the balance after a partial shipment, the warehouse cannot release the remaining units through the application. Those units become unavailable for other orders despite being physically present.

**Remediation and regression.** Add a transactional way to close or cancel the remaining quantity and release only the unshipped reservation. Keep dispatched quantities, invoices, ledger entries, and payments intact. Verify repeated or concurrent cancellation and dispatch cannot release reservations twice or deduct unshipped stock.

### GP-H04 — Return credit immediately appears as settled cash or bank refund

**Confirmed by the sales transaction, UI, and existing return test.** If a return credit exceeds the outstanding balance, choosing a method causes the return transaction to increment the order's `refunded` amount immediately. The UI labels that money as refunded. The application workflow has no pending refund state or separate settlement confirmation. The README specifies external settlement, and the test asserts the refund amount as soon as the return posts. [Return transaction](../apps/api/src/sales.ts#L241) · [Payment history and return editor](../apps/web/src/Sales.tsx#L95) · [Documentation](../README.md#L49) · [Return test](../apps/api/test/sales.test.mjs#L175)

**Impact.** A posted return can make the customer account show money as paid back before cash is handed over or a bank transfer clears. The system then offers no distinction between a refund that remains payable and one already settled. This does not imply that integrating a payment processor is required.

**Remediation and regression.** Record the credit and outstanding refund obligation separately from settlement. A manual settlement should capture its method, reference, and operator, and be idempotent. Reconcile existing historical refunds against settlement evidence without assuming their status. Verify unpaid credits, pending refunds, and confirmed manual refunds produce distinct and correct account balances.

### GP-H05 — The HTTP validator is on an affected Zod version

**Confirmed by lockfile, route use, and npm advisory.** The lockfile resolves Zod 3.25.76. The advisory covers versions below 4.6.6. The API uses this runtime package for arrays in purchase orders, inventory input, receipts, sales orders, dispatches, and returns. The Express body limit constrains request size, so the actual service availability impact at that limit was not measured. [Lockfile](../package-lock.json) · [Body limit](../apps/api/src/index.ts#L9) · [Warehouse validation](../apps/api/src/warehouse.ts#L30) · [Sales validation](../apps/api/src/sales.ts#L24) · [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)

**Remediation and regression.** Update to a patched release and verify request compatibility across every route group. Retain the request size limit and validate collection bounds before expensive per-item work where practical. Regression-test valid maximum-sized requests and clean rejection of over-limit input without persisting records.

## Additional High upstream advisories

The full npm scan and the scan with development dependencies omitted each returned five High package entries and zero Critical entries. Four entries map to two transitive advisories in the Prisma configuration dependency tree. The two direct advisory packages are `deepmerge-ts` 7.1.5 and `effect` 3.21.0, pulled in by `@prisma/config` 6.19.3 through Prisma CLI 6.19.3. The remaining entry is Zod, covered by GP-H05. The affected versions are confirmed in the lockfile. This audit did not establish that the Prisma configuration paths are reachable from GarmentPro HTTP requests. Track the Prisma advisories as a separate dependency group. Verify client generation, fresh migration, and upgrade with representative existing data before accepting any Prisma upgrade. [Lockfile](../package-lock.json) · [deepmerge-ts advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) · [Effect advisory](https://github.com/advisories/GHSA-7589-6fvf-x4pw)

## Recommended order for the remediation pass

1. Establish mutation and read authorization, then add regression coverage for protected operations and actor attribution.
2. Address sales returns and settlement records as one group, while preserving legacy ledger entries.
3. Implement safe release of unshipped reservations with dispatch and cancellation concurrency tests.
4. Patch Zod and the Prisma dependency chain in separate changes, then rerun migration, build, purchasing, inventory, sales, and payment checks.

The report is the only authored project change. No fixes or new migrations were applied. Production data was not accessed or modified, and nothing was deployed.
