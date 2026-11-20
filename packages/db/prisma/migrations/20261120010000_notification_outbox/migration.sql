BEGIN;
CREATE TYPE "NotificationEventType" AS ENUM ('BOOKING_CONFIRMED','BOOKING_CANCELLED','BOOKING_RESCHEDULED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING','PUBLISHED','DEAD');
CREATE TABLE "NotificationOutbox" (
  id uuid PRIMARY KEY, "schemaVersion" integer NOT NULL DEFAULT 1,
  "eventType" "NotificationEventType" NOT NULL, "deliveryMode" varchar(16) NOT NULL DEFAULT 'MOCK',
  "businessId" uuid NOT NULL, "bookingId" uuid NOT NULL, "previousBookingId" uuid,
  "occurredAt" timestamptz(3) NOT NULL, "traceId" varchar(128) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status "OutboxStatus" NOT NULL DEFAULT 'PENDING', "availableAt" timestamptz(3) NOT NULL,
  attempts integer NOT NULL DEFAULT 0, "leaseToken" uuid, "leaseExpiresAt" timestamptz(3),
  "publishedAt" timestamptz(3), "lastErrorCode" varchar(64),
  CONSTRAINT "NotificationOutbox_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NotificationOutbox_businessId_bookingId_fkey" FOREIGN KEY ("businessId","bookingId") REFERENCES "Booking"("businessId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NotificationOutbox_businessId_previousBookingId_fkey" FOREIGN KEY ("businessId","previousBookingId") REFERENCES "Booking"("businessId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NotificationOutbox_event_check" CHECK ("schemaVersion" = 1 AND "deliveryMode" = 'MOCK'
    AND "traceId" ~ '^[A-Za-z0-9-]{1,128}$'
    AND (("eventType" = 'BOOKING_RESCHEDULED' AND "previousBookingId" IS NOT NULL AND "previousBookingId" <> "bookingId")
      OR ("eventType" <> 'BOOKING_RESCHEDULED' AND "previousBookingId" IS NULL))),
  CONSTRAINT "NotificationOutbox_publisher_check" CHECK (
    attempts BETWEEN 0 AND 5 AND "availableAt" >= "occurredAt"
    AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND (("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND status = 'PENDING' AND attempts > 0 AND "leaseExpiresAt" > "availableAt"))
    AND ((status = 'PENDING' AND "publishedAt" IS NULL)
      OR (status = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "publishedAt" >= "occurredAt" AND attempts > 0 AND "leaseToken" IS NULL AND "lastErrorCode" IS NULL)
      OR (status = 'DEAD' AND "publishedAt" IS NULL AND attempts = 5 AND "leaseToken" IS NULL AND "lastErrorCode" IS NOT NULL)))
);
CREATE UNIQUE INDEX "NotificationOutbox_businessId_bookingId_eventType_key" ON "NotificationOutbox"("businessId","bookingId","eventType");
CREATE INDEX "NotificationOutbox_status_availableAt_id_idx" ON "NotificationOutbox"(status,"availableAt",id);
CREATE INDEX "NotificationOutbox_businessId_occurredAt_id_idx" ON "NotificationOutbox"("businessId","occurredAt",id);
CREATE INDEX "NotificationOutbox_businessId_previousBookingId_idx" ON "NotificationOutbox"("businessId","previousBookingId");

CREATE FUNCTION notification_outbox_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
  SELECT b.status,b."createdAt",b."cancelledAt",p."rescheduleOfId" INTO target
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
  RETURN NEW;
END $$;
CREATE TRIGGER "NotificationOutbox_guard" BEFORE INSERT OR UPDATE ON "NotificationOutbox" FOR EACH ROW EXECUTE FUNCTION notification_outbox_guard();
COMMIT;
