ALTER TYPE "BookingOperation" ADD VALUE 'RESCHEDULE';
ALTER TABLE "BookingAction" DROP CONSTRAINT "BookingAction_valid_check";
ALTER TABLE "BookingAction" ADD CONSTRAINT "BookingAction_valid_check"
  CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("response") = 'object'
    AND (("operation"::text = 'PROPOSE' AND "bookingId" IS NULL)
      OR ("operation"::text IN ('CONFIRM','CANCEL','RESCHEDULE') AND "bookingId" IS NOT NULL)));
CREATE UNIQUE INDEX "Booking_businessId_sessionId_id_key" ON "Booking"("businessId","sessionId",id);
ALTER TABLE "BookingProposal" ADD COLUMN "rescheduleOfId" uuid;
ALTER TABLE "BookingProposal" ADD CONSTRAINT "BookingProposal_reschedule_source_fkey"
  FOREIGN KEY ("businessId","sessionId","rescheduleOfId") REFERENCES "Booking"("businessId","sessionId",id)
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "BookingProposal_rescheduleOfId_idx" ON "BookingProposal"("rescheduleOfId");
