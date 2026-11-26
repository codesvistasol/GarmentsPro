BEGIN;
CREATE TABLE "ActivityLog" (
  id BIGSERIAL PRIMARY KEY,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "area" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "reference" TEXT NOT NULL
);
CREATE INDEX "ActivityLog_createdAt_id_idx" ON "ActivityLog" ("createdAt", id);
CREATE INDEX "ActivityLog_area_createdAt_idx" ON "ActivityLog" ("area", "createdAt");

CREATE FUNCTION record_operation_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item jsonb;
  prior jsonb;
  verb text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    item := to_jsonb(OLD);
    verb := 'Deleted';
  ELSE
    item := to_jsonb(NEW);
    verb := CASE WHEN TG_OP = 'INSERT' THEN TG_ARGV[2] ELSE 'Updated' END;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    prior := to_jsonb(OLD);
    -- Serial counters and timestamp-only writes are internal and do not describe user activity.
    IF (item - ARRAY['lastProductSerial','updatedAt']) = (prior - ARRAY['lastProductSerial','updatedAt']) THEN
      RETURN NULL;
    END IF;
    IF item->>'archived' = 'true' AND prior->>'archived' = 'false' THEN
      verb := 'Archived';
    ELSIF item->>'active' IS DISTINCT FROM prior->>'active' THEN
      verb := CASE WHEN item->>'active' = 'true' THEN 'Activated' ELSE 'Deactivated' END;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'SalesEvent' THEN
    IF item->>'action' NOT IN ('CONFIRMED', 'CANCELLED') THEN RETURN NULL; END IF;
    verb := initcap(item->>'action');
  ELSIF TG_TABLE_NAME = 'StockMovement' THEN
    verb := initcap(replace(item->>'type','_',' '));
  END IF;
  INSERT INTO "ActivityLog" ("area","action","entityId","reference")
  VALUES (TG_ARGV[0], verb, COALESCE(item->>'id', item->>'productId'),
    COALESCE(NULLIF(item->>TG_ARGV[1],''), item->>'variantId', item->>'id', item->>'productId'));
  RETURN NULL;
END;
$$;

CREATE TRIGGER activity_category AFTER INSERT OR UPDATE OR DELETE ON "Category"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Catalogue','name','Created category');
CREATE TRIGGER activity_product AFTER INSERT OR UPDATE ON "Product"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Catalogue','sku','Created product');
CREATE TRIGGER activity_product_image AFTER INSERT OR UPDATE OR DELETE ON "ProductImage"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Catalogue','productId','Added product photo');
CREATE TRIGGER activity_variant AFTER INSERT OR UPDATE OF "sku","size","color","reorderPoint" ON "Variant"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Catalogue','sku','Created variant');
CREATE TRIGGER activity_supplier AFTER INSERT OR UPDATE ON "Supplier"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Purchases','company','Created supplier');
CREATE TRIGGER activity_purchase AFTER INSERT ON "PurchaseOrder"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Purchases','reference','Created purchase order');
CREATE TRIGGER activity_receipt AFTER INSERT ON "GoodsReceipt"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Purchases','reference','Received goods');
CREATE TRIGGER activity_stock AFTER INSERT ON "StockMovement"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Inventory','reference','Posted movement');
CREATE TRIGGER activity_customer AFTER INSERT OR UPDATE ON "Customer"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Customers','businessName','Created customer');
CREATE TRIGGER activity_sale AFTER INSERT ON "SalesOrder"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Sales','number','Created sales order');
CREATE TRIGGER activity_sale_status AFTER INSERT ON "SalesEvent"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Sales','reference','Updated sales order');
CREATE TRIGGER activity_dispatch AFTER INSERT ON "SalesDispatch"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Sales','reference','Posted dispatch');
CREATE TRIGGER activity_return AFTER INSERT ON "SalesReturn"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Sales','reference','Posted return');
CREATE TRIGGER activity_payment AFTER INSERT ON "SalesPayment"
FOR EACH ROW EXECUTE FUNCTION record_operation_activity('Payments','reference','Recorded payment');

CREATE TRIGGER activity_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ActivityLog"
FOR EACH STATEMENT EXECUTE FUNCTION reject_sales_history_change();
COMMIT;
