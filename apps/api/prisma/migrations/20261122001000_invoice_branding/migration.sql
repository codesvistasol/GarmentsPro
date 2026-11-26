ALTER TABLE "BusinessSettings"
  ADD COLUMN "invoiceLogo" TEXT,
  ADD COLUMN "invoiceLogoPlacement" TEXT NOT NULL DEFAULT 'HEADER'
    CHECK ("invoiceLogoPlacement" IN ('HEADER', 'WATERMARK', 'BOTH')),
  ADD COLUMN "invoiceTimeZone" TEXT NOT NULL DEFAULT 'Asia/Karachi';
