BEGIN;

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('OPENING', 'RECEIPT', 'STOCK_IN', 'STOCK_OUT', 'RETURN_IN', 'RETURN_TO_SUPPLIER', 'DAMAGE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "taxNumber" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "orderDate" DATE NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "variantSku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "destination" TEXT,
    "reference" TEXT,
    "requestKey" TEXT,
    "receiptLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_reference_key" ON "PurchaseOrder"("reference");

-- CreateIndex
CREATE INDEX "PurchaseItem_variantId_idx" ON "PurchaseItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_orderId_variantId_key" ON "PurchaseItem"("orderId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_reference_key" ON "GoodsReceipt"("reference");

-- CreateIndex
CREATE INDEX "GoodsReceipt_orderId_idx" ON "GoodsReceipt"("orderId");

-- CreateIndex
CREATE INDEX "ReceiptLine_itemId_idx" ON "ReceiptLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptLine_receiptId_itemId_key" ON "ReceiptLine"("receiptId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_requestKey_key" ON "StockMovement"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_receiptLineId_key" ON "StockMovement"("receiptLineId");

-- CreateIndex
CREATE INDEX "StockMovement_variantId_createdAt_idx" ON "StockMovement"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_createdAt_id_idx" ON "StockMovement"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PurchaseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "ReceiptLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve existing balances as opening entries before enforcing ledger writes.
INSERT INTO "StockMovement" ("id", "variantId", "type", "quantity", "balanceAfter", "reason")
SELECT 'opening-' || "id", "id", 'OPENING', "availableQty", "availableQty", 'Phase 1 opening balance'
FROM "Variant" WHERE "availableQty" > 0;

ALTER TABLE "Variant" ADD CONSTRAINT "Variant_nonnegative_stock" CHECK ("availableQty" >= 0);
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_nonnegative_threshold" CHECK ("reorderPoint" >= 0);
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_valid_quantities"
  CHECK ("quantity" > 0 AND "receivedQty" BETWEEN 0 AND "quantity" AND "unitPrice" >= 0);
ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_positive_quantity" CHECK ("quantity" > 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_valid_quantity"
  CHECK (("type" IN ('OPENING', 'RECEIPT', 'STOCK_IN', 'RETURN_IN') AND "quantity" > 0)
      OR ("type" IN ('STOCK_OUT', 'RETURN_TO_SUPPLIER', 'DAMAGE') AND "quantity" < 0)
      OR ("type" = 'ADJUSTMENT' AND "quantity" <> 0));
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_receipt_link"
  CHECK (("type" = 'RECEIPT') = ("receiptLineId" IS NOT NULL));

CREATE FUNCTION protect_variant_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."availableQty" <> 0 THEN
      RAISE EXCEPTION 'New variants must start at zero';
    END IF;
  ELSIF NEW."availableQty" IS DISTINCT FROM OLD."availableQty" AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Inventory quantities must be changed through the stock ledger';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER variant_quantity_guard
BEFORE INSERT OR UPDATE OF "availableQty" ON "Variant"
FOR EACH ROW EXECUTE FUNCTION protect_variant_quantity();

CREATE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resulting_balance integer;
BEGIN
  UPDATE "Variant"
    SET "availableQty" = ("availableQty"::bigint + NEW."quantity")::integer
    WHERE "id" = NEW."variantId"
      AND "availableQty"::bigint + NEW."quantity" BETWEEN 0 AND 2147483647
    RETURNING "availableQty" INTO resulting_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Stock movement exceeds available stock or maximum balance';
  END IF;
  IF NEW."balanceAfter" <> resulting_balance THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Stock ledger balance does not match the movement';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_movement_apply
AFTER INSERT ON "StockMovement"
FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

CREATE FUNCTION reject_stock_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stock ledger entries are immutable';
END;
$$;

CREATE TRIGGER stock_movement_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON "StockMovement"
FOR EACH STATEMENT EXECUTE FUNCTION reject_stock_history_change();

COMMIT;
