ALTER TABLE "BusinessWorkflowAction" ADD COLUMN "runId" uuid;
CREATE UNIQUE INDEX "BusinessWorkflowRun_businessId_definitionId_id_key" ON "BusinessWorkflowRun"("businessId","definitionId",id);
ALTER TABLE "BusinessWorkflowAction" ADD CONSTRAINT "BusinessWorkflowAction_businessId_definitionId_runId_fkey"
FOREIGN KEY ("businessId","definitionId","runId") REFERENCES "BusinessWorkflowRun"("businessId","definitionId",id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BusinessWorkflowAction" DROP CONSTRAINT workflow_action_state;
ALTER TABLE "BusinessWorkflowAction" ADD CONSTRAINT workflow_action_state CHECK (
  "idempotencyKey" ~ '^[!-~]{1,128}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 16384
  AND ((operation = 'SET_POLICY' AND "taskId" IS NULL AND "runId" IS NULL)
    OR (operation = 'COMPLETE_TASK' AND "taskId" IS NOT NULL AND "runId" IS NULL)
    OR (operation = 'RECORD_ENQUIRY' AND "taskId" IS NULL AND "runId" IS NOT NULL))
);

CREATE OR REPLACE FUNCTION business_workflow_run_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE target record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW."businessId",NEW."definitionId",NEW."bookingId",NEW."triggerEventId",NEW."activationId",NEW."policyRevision",NEW."createdAt") IS DISTINCT FROM
       (OLD.id,OLD."businessId",OLD."definitionId",OLD."bookingId",OLD."triggerEventId",OLD."activationId",OLD."policyRevision",OLD."createdAt")
      OR NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 OR (OLD.status <> 'PENDING' AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Workflow enrollment and terminal history are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'SUCCEEDED' AND (OLD."leaseToken" IS NULL OR OLD."leaseExpiresAt" <= NEW."finishedAt") THEN
      RAISE EXCEPTION 'Successful execution requires an unexpired lease' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM id FROM "Business" WHERE id = NEW."businessId" FOR SHARE;
  SELECT d.template,d.enabled,d."activationId",d.revision,d."enabledAt",b.active,k.status,p."startAt",e."eventType",e."occurredAt"
    INTO target FROM "BusinessWorkflowDefinition" d JOIN "Business" b ON b.id = d."businessId"
    JOIN "Booking" k ON k.id = NEW."bookingId" AND k."businessId" = d."businessId"
    JOIN "BookingProposal" p ON p.id = k."proposalId"
    JOIN "NotificationOutbox" e ON e.id = NEW."triggerEventId" AND e."businessId" = d."businessId" AND e."bookingId" = k.id
    WHERE d.id = NEW."definitionId" AND d."businessId" = NEW."businessId";
  IF NOT FOUND OR NOT target.enabled OR NOT target.active OR target.status <> 'CONFIRMED'
    OR target."eventType" NOT IN ('BOOKING_CONFIRMED','BOOKING_RESCHEDULED')
    OR NEW."activationId" <> target."activationId" OR NEW."policyRevision" <> target.revision
    OR (target.template = 'PREPARE_APPOINTMENT' AND NEW."createdAt" <> target."occurredAt") OR NEW."createdAt" < target."occurredAt" OR NEW."createdAt" < target."enabledAt" OR NEW."createdAt" >= target."startAt"
    OR NEW.status <> 'PENDING' OR NEW.attempts <> 0 OR NEW."leaseToken" IS NOT NULL OR NEW."lastErrorCode" IS NOT NULL
    OR NEW."availableAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'Workflow enrollment requires current owned opt-in and booking event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
