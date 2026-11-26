BEGIN;

-- Block concurrent product writes while assigning serials to existing records.
ALTER TABLE "Product" ADD COLUMN "serialNumber" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Category" ADD COLUMN "lastProductSerial" INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "categoryId" ORDER BY "createdAt", "id")::integer AS serial
  FROM "Product"
)
UPDATE "Product" p SET "serialNumber" = ranked.serial FROM ranked WHERE p."id" = ranked."id";

UPDATE "Category" c SET "lastProductSerial" = totals.serial
FROM (
  SELECT "categoryId", MAX("serialNumber") AS serial FROM "Product" GROUP BY "categoryId"
) totals WHERE c."id" = totals."categoryId";

ALTER TABLE "Product" ADD CONSTRAINT "Product_serial_positive" CHECK ("serialNumber" > 0);
CREATE UNIQUE INDEX "Product_categoryId_serialNumber_key" ON "Product"("categoryId", "serialNumber");

CREATE FUNCTION assign_product_serial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."categoryId" = OLD."categoryId" THEN
      NEW."serialNumber" := OLD."serialNumber";
      RETURN NEW;
    END IF;
  END IF;
  UPDATE "Category" SET "lastProductSerial" = "lastProductSerial" + 1
    WHERE "id" = NEW."categoryId" RETURNING "lastProductSerial" INTO NEW."serialNumber";
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_serial_assignment
BEFORE INSERT OR UPDATE OF "categoryId", "serialNumber" ON "Product"
FOR EACH ROW EXECUTE FUNCTION assign_product_serial();

CREATE TABLE "ProductImage" (
  "productId" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("productId"),
  CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

COMMIT;
