CREATE TABLE "MockNotificationReceipt" (
  "eventId" UUID PRIMARY KEY REFERENCES "NotificationOutbox"(id) ON DELETE CASCADE,
  "outcome" VARCHAR(24) NOT NULL,
  "reason" VARCHAR(32) NOT NULL,
  "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mock_receipt_outcome" CHECK (
    (outcome = 'MOCK_DELIVERED' AND reason = 'CURRENT_BOOKING') OR
    (outcome = 'SUPPRESSED' AND reason IN ('STALE_BOOKING', 'INACTIVE_BUSINESS'))
  )
);
CREATE FUNCTION protect_mock_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Mock notification receipts are immutable';
END;
$$;
CREATE TRIGGER "mock_receipt_immutable" BEFORE UPDATE ON "MockNotificationReceipt"
FOR EACH ROW EXECUTE FUNCTION protect_mock_receipt();
