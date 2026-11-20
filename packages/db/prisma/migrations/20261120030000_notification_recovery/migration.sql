CREATE TABLE "MockNotificationRejection" (
  fingerprint VARCHAR(64) PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  reason VARCHAR(32) NOT NULL CHECK (reason IN ('INVALID_NOTIFICATION', 'PROCESSING_EXHAUSTED')),
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER "mock_rejection_immutable" BEFORE UPDATE ON "MockNotificationRejection"
FOR EACH ROW EXECUTE FUNCTION protect_mock_receipt();
