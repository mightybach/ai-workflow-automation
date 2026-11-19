ALTER TYPE "BookingOperation" ADD VALUE 'CANCEL';

-- Compare text so this migration does not use a new enum value before commit.
ALTER TABLE "BookingAction" DROP CONSTRAINT "BookingAction_valid_check";
ALTER TABLE "BookingAction" ADD CONSTRAINT "BookingAction_valid_check"
  CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("response") = 'object'
    AND (("operation"::text = 'PROPOSE' AND "bookingId" IS NULL)
      OR ("operation"::text IN ('CONFIRM', 'CANCEL') AND "bookingId" IS NOT NULL)));
