ALTER TABLE "StaffUser" ADD COLUMN "signupPending" BOOLEAN NOT NULL DEFAULT false;
UPDATE "StaffUser" AS staff
SET "signupPending" = true
WHERE NOT staff."active" AND staff."permissions" = '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM "ActivityLog" AS entry
    WHERE entry."entityId" = staff."id" AND entry."action" = 'Created staff account' AND entry."actorId" IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ActivityLog" AS entry
    WHERE entry."entityId" = staff."id" AND entry."action" = 'Updated staff account'
  );
CREATE INDEX "StaffUser_signupPending_createdAt_idx" ON "StaffUser"("signupPending", "createdAt");
