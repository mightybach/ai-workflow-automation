ALTER TABLE "Business" ADD COLUMN "mockRemindersEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MockNotificationReceipt" DROP CONSTRAINT "mock_receipt_outcome";
ALTER TABLE "MockNotificationReceipt" ADD CONSTRAINT "mock_receipt_outcome" CHECK (
 (outcome = 'MOCK_DELIVERED' AND reason = 'CURRENT_BOOKING') OR
 (outcome = 'SUPPRESSED' AND reason IN ('STALE_BOOKING', 'INACTIVE_BUSINESS', 'REMINDERS_DISABLED'))
);
CREATE OR REPLACE FUNCTION notification_outbox_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE target record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW."schemaVersion",NEW."eventType",NEW."deliveryMode",NEW."businessId",NEW."bookingId",NEW."previousBookingId",NEW."occurredAt",NEW."traceId",NEW."createdAt") IS DISTINCT FROM
       (OLD.id,OLD."schemaVersion",OLD."eventType",OLD."deliveryMode",OLD."businessId",OLD."bookingId",OLD."previousBookingId",OLD."occurredAt",OLD."traceId",OLD."createdAt")
       OR NEW.attempts < OLD.attempts OR (OLD.status <> 'PENDING' AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Outbox event identity and terminal history are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM id FROM "Business" WHERE id = NEW."businessId" FOR SHARE;
  SELECT b.status,b."createdAt",b."cancelledAt",p."rescheduleOfId",p."startAt" INTO target
    FROM "Booking" b JOIN "BookingProposal" p ON p.id = b."proposalId"
    WHERE b.id = NEW."bookingId" AND b."businessId" = NEW."businessId";
  IF NOT FOUND OR NEW.status <> 'PENDING' OR NEW.attempts <> 0 OR NEW."leaseToken" IS NOT NULL
    OR NEW."publishedAt" IS NOT NULL OR NEW."lastErrorCode" IS NOT NULL OR NEW."availableAt" <> NEW."occurredAt" THEN
    RAISE EXCEPTION 'Outbox events require an owned booking and initial pending state' USING ERRCODE = '23514';
  END IF;
  IF (NEW."eventType" = 'BOOKING_CONFIRMED' AND (target.status <> 'CONFIRMED' OR target."rescheduleOfId" IS NOT NULL OR NEW."occurredAt" <> target."createdAt"))
    OR (NEW."eventType" = 'BOOKING_CANCELLED' AND (target.status <> 'CANCELLED' OR NEW."occurredAt" IS DISTINCT FROM target."cancelledAt"))
    OR (NEW."eventType" = 'BOOKING_RESCHEDULED' AND (target.status <> 'CONFIRMED' OR NEW."previousBookingId" IS DISTINCT FROM target."rescheduleOfId" OR NEW."occurredAt" <> target."createdAt")) THEN
    RAISE EXCEPTION 'Outbox event must match its committed booking transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."eventType" = 'BOOKING_REMINDER' AND (
    target.status <> 'CONFIRMED' OR NEW."occurredAt" < target."startAt" - interval '24 hours'
    OR NEW."occurredAt" >= target."startAt" OR NOT EXISTS (
      SELECT 1 FROM "Business" WHERE id = NEW."businessId" AND active AND "mockRemindersEnabled"
    )) THEN
    RAISE EXCEPTION 'Mock reminder requires persisted opt-in and a current due booking' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
