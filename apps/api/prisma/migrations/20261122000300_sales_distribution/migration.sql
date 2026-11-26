BEGIN;
-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('CUSTOMER', 'SHOP', 'WHOLESALE');

-- CreateEnum
CREATE TYPE "SalesStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "ReturnCondition" AS ENUM ('SALEABLE', 'DAMAGED');

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "reservedQty" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "creditLimit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "creditDays" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerContact" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "customerAddress" TEXT,
    "status" "SalesStatus" NOT NULL DEFAULT 'DRAFT',
    "reserveStock" BOOLEAN NOT NULL DEFAULT true,
    "dueDate" DATE NOT NULL,
    "subtotal" DECIMAL(24,2) NOT NULL,
    "total" DECIMAL(24,2) NOT NULL,
    "billed" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "credited" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "paid" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "refunded" DECIMAL(24,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "variantSku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "dispatched" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(16,2) NOT NULL,
    "discount" DECIMAL(24,2) NOT NULL,
    "total" DECIMAL(24,2) NOT NULL,

    CONSTRAINT "SalesItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDispatch" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "total" DECIMAL(24,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDispatchLine" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,

    CONSTRAINT "SalesDispatchLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesPayment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReturn" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "credit" DECIMAL(24,2) NOT NULL,
    "refunded" DECIMAL(24,2) NOT NULL,
    "refundMethod" "PaymentMethod",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReturnLine" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition" "ReturnCondition" NOT NULL,
    "credit" DECIMAL(24,2) NOT NULL,

    CONSTRAINT "SalesReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_number_key" ON "SalesOrder"("number");

-- CreateIndex
CREATE INDEX "SalesOrder_customerId_idx" ON "SalesOrder"("customerId");

-- CreateIndex
CREATE INDEX "SalesOrder_createdAt_idx" ON "SalesOrder"("createdAt");

-- CreateIndex
CREATE INDEX "SalesItem_variantId_idx" ON "SalesItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesItem_orderId_variantId_key" ON "SalesItem"("orderId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDispatch_reference_key" ON "SalesDispatch"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDispatch_requestKey_key" ON "SalesDispatch"("requestKey");

-- CreateIndex
CREATE INDEX "SalesDispatch_orderId_idx" ON "SalesDispatch"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDispatchLine_dispatchId_itemId_key" ON "SalesDispatchLine"("dispatchId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPayment_reference_key" ON "SalesPayment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPayment_requestKey_key" ON "SalesPayment"("requestKey");

-- CreateIndex
CREATE INDEX "SalesPayment_orderId_idx" ON "SalesPayment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReturn_reference_key" ON "SalesReturn"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReturn_requestKey_key" ON "SalesReturn"("requestKey");

-- CreateIndex
CREATE INDEX "SalesReturn_orderId_idx" ON "SalesReturn"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReturnLine_returnId_itemId_key" ON "SalesReturnLine"("returnId", "itemId");

-- CreateIndex
CREATE INDEX "SalesEvent_orderId_createdAt_idx" ON "SalesEvent"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesItem" ADD CONSTRAINT "SalesItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesItem" ADD CONSTRAINT "SalesItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDispatch" ADD CONSTRAINT "SalesDispatch_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDispatchLine" ADD CONSTRAINT "SalesDispatchLine_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "SalesDispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDispatchLine" ADD CONSTRAINT "SalesDispatchLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "SalesItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesPayment" ADD CONSTRAINT "SalesPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReturn" ADD CONSTRAINT "SalesReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReturnLine" ADD CONSTRAINT "SalesReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "SalesReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReturnLine" ADD CONSTRAINT "SalesReturnLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "SalesItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesEvent" ADD CONSTRAINT "SalesEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Variant" ADD CONSTRAINT "Variant_valid_reservation"
  CHECK ("reservedQty" BETWEEN 0 AND "availableQty");
ALTER TABLE "SalesItem" ADD CONSTRAINT "SalesItem_valid_quantities"
  CHECK ("quantity" > 0 AND "dispatched" BETWEEN 0 AND "quantity" AND "returned" BETWEEN 0 AND "dispatched");
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_valid_balances"
  CHECK ("subtotal" >= "total" AND "total" >= "billed" AND "billed" >= "credited"
  AND "credited" >= "refunded" AND "refunded" >= 0 AND "paid" >= "refunded"
  AND "paid" - "refunded" <= "billed" - "credited");

CREATE FUNCTION reject_sales_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Posted sales history is immutable';
END;
$$;

CREATE TRIGGER sales_dispatch_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "SalesDispatch"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();
CREATE TRIGGER sales_dispatch_line_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "SalesDispatchLine"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();
CREATE TRIGGER sales_payment_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "SalesPayment"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();
CREATE TRIGGER sales_return_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "SalesReturn"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();
CREATE TRIGGER sales_return_line_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "SalesReturnLine"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();
CREATE TRIGGER sales_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "SalesEvent"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();

COMMIT;
