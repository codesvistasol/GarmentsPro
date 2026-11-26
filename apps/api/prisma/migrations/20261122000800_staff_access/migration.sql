BEGIN;
CREATE TYPE "StaffRole" AS ENUM ('ADMIN','WAREHOUSE','SALES','FINANCE');
CREATE TABLE "StaffUser" (
  "id" TEXT PRIMARY KEY, "username" TEXT NOT NULL UNIQUE, "displayName" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL, "role" "StaffRole" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "StaffSession" (
  "tokenHash" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "StaffSession_userId_idx" ON "StaffSession"("userId");
CREATE INDEX "StaffSession_expiresAt_idx" ON "StaffSession"("expiresAt");
CREATE TABLE "BusinessSettings" (
  "id" TEXT PRIMARY KEY, "companyName" TEXT NOT NULL DEFAULT 'GarmentPro',
  "address" TEXT NOT NULL DEFAULT '', "phone" TEXT NOT NULL DEFAULT '', "email" TEXT NOT NULL DEFAULT '',
  "invoiceFooter" TEXT NOT NULL DEFAULT ''
);
ALTER TABLE "ActivityLog" ADD COLUMN "actorId" TEXT, ADD COLUMN "actorName" TEXT;
ALTER TABLE "SalesDispatch" ADD COLUMN "issuer" JSONB;

CREATE FUNCTION attribute_operation_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."actorId" := NULLIF(current_setting('garmentpro.actor_id', true),'');
  NEW."actorName" := NULLIF(current_setting('garmentpro.actor_name', true),'');
  RETURN NEW;
END;
$$;
CREATE TRIGGER activity_actor BEFORE INSERT ON "ActivityLog"
FOR EACH ROW EXECUTE FUNCTION attribute_operation_activity();

-- Authentication changes log the public staff identity only. Secret hashes stay in StaffUser.
CREATE FUNCTION record_settings_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry jsonb := to_jsonb(NEW);
BEGIN
  INSERT INTO "ActivityLog" ("area","action","entityId","reference")
  VALUES ('Settings', CASE WHEN TG_TABLE_NAME='StaffUser' THEN
    CASE WHEN TG_OP='INSERT' THEN 'Created staff account' ELSE 'Updated staff account' END
    ELSE 'Updated business settings' END,
    entry->>'id', COALESCE(entry->>'username',entry->>'companyName'));
  RETURN NULL;
END;
$$;
CREATE TRIGGER activity_staff AFTER INSERT OR UPDATE ON "StaffUser"
FOR EACH ROW EXECUTE FUNCTION record_settings_activity();
CREATE TRIGGER activity_business AFTER INSERT OR UPDATE ON "BusinessSettings"
FOR EACH ROW EXECUTE FUNCTION record_settings_activity();
COMMIT;
