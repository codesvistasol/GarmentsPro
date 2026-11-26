# Codex handoff: Phase 1 → Phase 2

1. Review README and run the starter locally; do not replace architecture without reason.
2. Validate API input handling, React build, and Prisma migration. Fix build issues first.
3. Add authentication with roles: Owner, Warehouse Manager, Salesperson, Accountant. Enforce API authorization.
4. Replace opening stock-only model with immutable StockMovement ledger (RECEIVE, DISPATCH, RETURN, DAMAGE, ADJUSTMENT), with transactional inventory updates and concurrency-safe quantities.
5. Add Supplier, Customer, PurchaseOrder, GoodsReceipt, SalesOrder, Dispatch, Invoice and Payment tables. Use decimal money and immutable records.
6. Build product variants CRUD UI, category edit UI, CSV import/export, pagination and robust error UX.
7. Implement automated tests for stock conservation, duplicate SKU, negative stock, permissions and payment balance.
8. Only after QA, add production Docker / Nginx / HTTPS, backups and recovery.

**Important:** The demo dashboard does NOT contain real sales metrics, revenue, best sellers, or purchase transactions. Do not show invented values as live data.
