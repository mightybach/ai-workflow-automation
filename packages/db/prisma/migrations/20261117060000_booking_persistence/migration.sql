-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingOperation" AS ENUM ('PROPOSE', 'CONFIRM');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "maxBookingDurationMinutes" INTEGER NOT NULL DEFAULT 120;

-- CreateTable
CREATE TABLE "CustomerSession" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CustomerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingProposal" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "slotId" UUID NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "timezone" VARCHAR(100) NOT NULL,
    "serviceName" VARCHAR(160) NOT NULL,
    "staffName" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookingProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "customerName" VARCHAR(120) NOT NULL,
    "customerEmail" VARCHAR(254) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingSlot" (
    "bookingId" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "slotId" UUID NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BookingSlot_pkey" PRIMARY KEY ("bookingId","slotId")
);

-- CreateTable
CREATE TABLE "BookingAction" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "operation" "BookingOperation" NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "proposalId" UUID NOT NULL,
    "bookingId" UUID,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSession_tokenHash_key" ON "CustomerSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerSession_expiresAt_idx" ON "CustomerSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSession_businessId_id_key" ON "CustomerSession"("businessId", "id");

-- CreateIndex
CREATE INDEX "BookingProposal_expiresAt_idx" ON "BookingProposal"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingProposal_businessId_sessionId_id_key" ON "BookingProposal"("businessId", "sessionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_proposalId_key" ON "Booking"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- CreateIndex
CREATE INDEX "Booking_businessId_createdAt_id_idx" ON "Booking"("businessId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_businessId_id_key" ON "Booking"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_businessId_sessionId_proposalId_id_key" ON "Booking"("businessId", "sessionId", "proposalId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_businessId_sessionId_proposalId_key" ON "Booking"("businessId", "sessionId", "proposalId");

-- CreateIndex
CREATE INDEX "BookingSlot_slotId_idx" ON "BookingSlot"("slotId");

-- CreateIndex
CREATE INDEX "BookingAction_proposalId_idx" ON "BookingAction"("proposalId");

-- CreateIndex
CREATE INDEX "BookingAction_bookingId_idx" ON "BookingAction"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAction_businessId_sessionId_operation_idempotencyKey_key" ON "BookingAction"("businessId", "sessionId", "operation", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilitySlot_businessId_staffId_id_key" ON "AvailabilitySlot"("businessId", "staffId", "id");

-- AddForeignKey
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProposal" ADD CONSTRAINT "BookingProposal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProposal" ADD CONSTRAINT "BookingProposal_businessId_sessionId_fkey" FOREIGN KEY ("businessId", "sessionId") REFERENCES "CustomerSession"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProposal" ADD CONSTRAINT "BookingProposal_businessId_serviceId_fkey" FOREIGN KEY ("businessId", "serviceId") REFERENCES "Service"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProposal" ADD CONSTRAINT "BookingProposal_businessId_staffId_fkey" FOREIGN KEY ("businessId", "staffId") REFERENCES "Staff"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProposal" ADD CONSTRAINT "BookingProposal_businessId_staffId_slotId_fkey" FOREIGN KEY ("businessId", "staffId", "slotId") REFERENCES "AvailabilitySlot"("businessId", "staffId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_businessId_sessionId_fkey" FOREIGN KEY ("businessId", "sessionId") REFERENCES "CustomerSession"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_businessId_sessionId_proposalId_fkey" FOREIGN KEY ("businessId", "sessionId", "proposalId") REFERENCES "BookingProposal"("businessId", "sessionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_businessId_bookingId_fkey" FOREIGN KEY ("businessId", "bookingId") REFERENCES "Booking"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_businessId_staffId_slotId_fkey" FOREIGN KEY ("businessId", "staffId", "slotId") REFERENCES "AvailabilitySlot"("businessId", "staffId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAction" ADD CONSTRAINT "BookingAction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAction" ADD CONSTRAINT "BookingAction_businessId_sessionId_fkey" FOREIGN KEY ("businessId", "sessionId") REFERENCES "CustomerSession"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAction" ADD CONSTRAINT "BookingAction_businessId_sessionId_proposalId_fkey" FOREIGN KEY ("businessId", "sessionId", "proposalId") REFERENCES "BookingProposal"("businessId", "sessionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAction" ADD CONSTRAINT "BookingAction_businessId_sessionId_proposalId_bookingId_fkey" FOREIGN KEY ("businessId", "sessionId", "proposalId", "bookingId") REFERENCES "Booking"("businessId", "sessionId", "proposalId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reviewed booking invariants beyond Prisma's declarative schema.
ALTER TABLE "Business" ADD CONSTRAINT "Business_booking_duration_check"
  CHECK ("maxBookingDurationMinutes" BETWEEN 30 AND 1440 AND "maxBookingDurationMinutes" % 30 = 0);
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_valid_check"
  CHECK ("tokenHash" ~ '^[a-f0-9]{64}$' AND "expiresAt" > "createdAt");
ALTER TABLE "BookingProposal" ADD CONSTRAINT "BookingProposal_duration_check"
  CHECK ("durationMinutes" BETWEEN 30 AND 1440 AND "durationMinutes" % 30 = 0
    AND "endAt" = "startAt" + "durationMinutes" * INTERVAL '1 minute'
    AND EXTRACT(EPOCH FROM "startAt") % 1800 = 0 AND "expiresAt" > "createdAt"
    AND length(trim("staffName")) > 0 AND length(trim("serviceName")) > 0);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customer_status_check"
  CHECK (length(trim("customerName")) > 0
    AND "customerEmail" ~ '^[^[:space:]@]+@example[.]test$'
    AND "reference" ~ '^[A-Z0-9-]+$'
    AND (("status" = 'CONFIRMED' AND "cancelledAt" IS NULL)
      OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)));
ALTER TABLE "BookingAction" ADD CONSTRAINT "BookingAction_valid_check"
  CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("response") = 'object'
    AND (("operation" = 'PROPOSE' AND "bookingId" IS NULL)
      OR ("operation" = 'CONFIRM' AND "bookingId" IS NOT NULL)));

-- Cancellation releases claims, without removing historical slot links.
CREATE UNIQUE INDEX "BookingSlot_one_active_claim" ON "BookingSlot" ("slotId") WHERE "releasedAt" IS NULL;

CREATE FUNCTION booking_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer; first_start timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Booking proposals are immutable' USING ERRCODE = '23514';
  END IF;
  -- Serializes insertion with future business policy updates.
  SELECT "maxBookingDurationMinutes" INTO maximum FROM "Business" WHERE id = NEW."businessId" FOR SHARE;
  SELECT "startAt" INTO first_start FROM "AvailabilitySlot" WHERE id = NEW."slotId";
  IF NEW."durationMinutes" > maximum OR NEW."startAt" IS DISTINCT FROM first_start THEN
    RAISE EXCEPTION 'Invalid proposal duration or starting slot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BookingProposal_guard" BEFORE INSERT OR UPDATE ON "BookingProposal"
  FOR EACH ROW EXECUTE FUNCTION booking_proposal_guard();

CREATE FUNCTION booking_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer; duration integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW."businessId", NEW."sessionId", NEW."proposalId", NEW.reference,
        NEW."customerName", NEW."customerEmail", NEW."createdAt") IS DISTINCT FROM
       (OLD.id, OLD."businessId", OLD."sessionId", OLD."proposalId", OLD.reference,
        OLD."customerName", OLD."customerEmail", OLD."createdAt")
       OR (OLD.status = 'CANCELLED' AND NEW.status <> OLD.status) THEN
      RAISE EXCEPTION 'Booking identity/history is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "maxBookingDurationMinutes" INTO maximum FROM "Business" WHERE id = NEW."businessId" FOR SHARE;
    SELECT "durationMinutes" INTO duration FROM "BookingProposal" WHERE id = NEW."proposalId";
    IF duration > maximum THEN
      RAISE EXCEPTION 'Booking exceeds current business duration limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Booking_insert_guard" BEFORE INSERT OR UPDATE ON "Booking"
  FOR EACH ROW EXECUTE FUNCTION booking_insert_guard();

-- Validate at commit, after all slots have been claimed/linked. This guards
-- partial appointments and gaps, not merely duplicate starting times.
CREATE FUNCTION check_booking_slots(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE appointment record; slot_count integer; invalid_count integer;
BEGIN
  SELECT b.status, p."durationMinutes", p."startAt", p."endAt", p."staffId"
    INTO appointment FROM "Booking" b JOIN "BookingProposal" p ON p.id = b."proposalId" WHERE b.id = target;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*), count(*) FILTER (WHERE s."staffId" <> appointment."staffId"
      OR s."startAt" < appointment."startAt" OR s."endAt" > appointment."endAt"
      OR (appointment.status = 'CONFIRMED' AND (bs."releasedAt" IS NOT NULL OR s.state <> 'RESERVED'))
      OR (appointment.status = 'CANCELLED' AND bs."releasedAt" IS NULL))
    INTO slot_count, invalid_count FROM "BookingSlot" bs JOIN "AvailabilitySlot" s ON s.id = bs."slotId"
    WHERE bs."bookingId" = target;
  -- Aligned non-overlapping base slots + exact count within the interval imply
  -- complete contiguous coverage, with no lunch/break gaps.
  IF slot_count <> appointment."durationMinutes" / 30 OR invalid_count <> 0 THEN
    RAISE EXCEPTION 'Booking requires complete consecutive same-staff slot coverage' USING ERRCODE = '23514';
  END IF;
END $$;
CREATE FUNCTION booking_coverage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Booking' THEN
    PERFORM check_booking_slots(NEW.id);
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM check_booking_slots(OLD."bookingId"); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM check_booking_slots(NEW."bookingId"); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Booking_complete_coverage" AFTER INSERT OR UPDATE ON "Booking"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_coverage_trigger();
CREATE CONSTRAINT TRIGGER "BookingSlot_complete_coverage" AFTER INSERT OR UPDATE OR DELETE ON "BookingSlot"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_coverage_trigger();

CREATE FUNCTION slot_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF (NEW."businessId", NEW."staffId", NEW."startAt", NEW."endAt") IS DISTINCT FROM
     (OLD."businessId", OLD."staffId", OLD."startAt", OLD."endAt") AND
     (EXISTS (SELECT 1 FROM "BookingProposal" WHERE "slotId" = OLD.id) OR
      EXISTS (SELECT 1 FROM "BookingSlot" WHERE "slotId" = OLD.id)) THEN
    RAISE EXCEPTION 'Referenced inventory coordinates are immutable' USING ERRCODE = '23514';
  END IF;
  FOR target IN SELECT "bookingId" FROM "BookingSlot" WHERE "slotId" = NEW.id LOOP
    PERFORM check_booking_slots(target);
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "AvailabilitySlot_booking_guard" AFTER UPDATE ON "AvailabilitySlot"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slot_booking_guard();
