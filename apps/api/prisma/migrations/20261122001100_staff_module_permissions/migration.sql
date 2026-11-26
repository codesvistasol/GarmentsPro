ALTER TABLE "StaffUser"
  ADD COLUMN "permissions" JSONB,
  ADD COLUMN "resetHash" TEXT,
  ADD COLUMN "resetExpires" TIMESTAMP(3);
CREATE UNIQUE INDEX "StaffUser_resetHash_key" ON "StaffUser"("resetHash");
