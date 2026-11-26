BEGIN;
ALTER TABLE "SalesOrder" ADD COLUMN "pendingRefund" DECIMAL(24,2) NOT NULL DEFAULT 0;
ALTER TABLE "SalesReturn" ADD COLUMN "refundDue" DECIMAL(24,2) NOT NULL DEFAULT 0;
ALTER TABLE "SalesOrder" DROP CONSTRAINT "SalesOrder_valid_balances";
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_valid_balances"
  CHECK ("subtotal" >= "total" AND "total" >= "billed" AND "billed" >= "credited"
    AND "refunded" >= 0 AND "pendingRefund" >= 0
    AND "credited" >= "refunded" + "pendingRefund"
    AND "paid" >= "refunded" + "pendingRefund"
    AND "paid" - "refunded" - "pendingRefund" <= "billed" - "credited");
CREATE TABLE "RefundSettlement" (
  "id" TEXT PRIMARY KEY,
  "returnId" TEXT NOT NULL REFERENCES "SalesReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reference" TEXT NOT NULL UNIQUE,
  "requestKey" TEXT NOT NULL UNIQUE,
  "method" "PaymentMethod" NOT NULL,
  "amount" DECIMAL(24,2) NOT NULL CHECK ("amount" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RefundSettlement_returnId_idx" ON "RefundSettlement"("returnId");
CREATE INDEX "RefundSettlement_createdAt_idx" ON "RefundSettlement"("createdAt");
CREATE TRIGGER refund_settlement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "RefundSettlement"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();
CREATE TRIGGER activity_refund_settlement AFTER INSERT ON "RefundSettlement"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Payments','reference','Recorded refund settlement');
COMMIT;
