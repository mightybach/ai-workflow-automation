-- CreateEnum
CREATE TYPE "BusinessWorkflowTemplate" AS ENUM ('PREPARE_APPOINTMENT');

-- CreateEnum
CREATE TYPE "BusinessWorkflowRunStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'SUPPRESSED', 'DEAD');

-- CreateEnum
CREATE TYPE "BusinessTaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BusinessWorkflowOperation" AS ENUM ('SET_POLICY', 'COMPLETE_TASK');

-- CreateTable
CREATE TABLE "BusinessWorkflowDefinition" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "template" "BusinessWorkflowTemplate" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "activationId" UUID,
    "enabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessWorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessWorkflowRun" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "triggerEventId" UUID NOT NULL,
    "activationId" UUID NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "status" "BusinessWorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "resultCode" VARCHAR(64),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BusinessWorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessTask" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "kind" "BusinessWorkflowTemplate" NOT NULL,
    "status" "BusinessTaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "completedByMembershipId" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "invalidatedAt" TIMESTAMPTZ(3),
    "invalidationReason" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessWorkflowAction" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "taskId" UUID,
    "operation" "BusinessWorkflowOperation" NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessWorkflowAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessWorkflowDefinition_businessId_template_key" ON "BusinessWorkflowDefinition"("businessId", "template");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessWorkflowDefinition_businessId_id_key" ON "BusinessWorkflowDefinition"("businessId", "id");

-- CreateIndex
CREATE INDEX "BusinessWorkflowRun_status_availableAt_id_idx" ON "BusinessWorkflowRun"("status", "availableAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessWorkflowRun_businessId_definitionId_bookingId_key" ON "BusinessWorkflowRun"("businessId", "definitionId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessWorkflowRun_businessId_definitionId_triggerEventId_key" ON "BusinessWorkflowRun"("businessId", "definitionId", "triggerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessWorkflowRun_businessId_definitionId_bookingId_id_key" ON "BusinessWorkflowRun"("businessId", "definitionId", "bookingId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessTask_runId_key" ON "BusinessTask"("runId");

-- CreateIndex
CREATE INDEX "BusinessTask_businessId_status_dueAt_id_idx" ON "BusinessTask"("businessId", "status", "dueAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessTask_businessId_definitionId_bookingId_key" ON "BusinessTask"("businessId", "definitionId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessTask_businessId_definitionId_id_key" ON "BusinessTask"("businessId", "definitionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessTask_businessId_definitionId_bookingId_runId_key" ON "BusinessTask"("businessId", "definitionId", "bookingId", "runId");

-- CreateIndex
CREATE INDEX "BusinessWorkflowAction_businessId_createdAt_id_idx" ON "BusinessWorkflowAction"("businessId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessWorkflowAction_businessId_membershipId_operation_id_key" ON "BusinessWorkflowAction"("businessId", "membershipId", "operation", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessMembership_businessId_id_key" ON "BusinessMembership"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_businessId_bookingId_id_key" ON "NotificationOutbox"("businessId", "bookingId", "id");

-- AddForeignKey
ALTER TABLE "BusinessWorkflowDefinition" ADD CONSTRAINT "BusinessWorkflowDefinition_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowRun" ADD CONSTRAINT "BusinessWorkflowRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowRun" ADD CONSTRAINT "BusinessWorkflowRun_businessId_definitionId_fkey" FOREIGN KEY ("businessId", "definitionId") REFERENCES "BusinessWorkflowDefinition"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowRun" ADD CONSTRAINT "BusinessWorkflowRun_businessId_bookingId_fkey" FOREIGN KEY ("businessId", "bookingId") REFERENCES "Booking"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowRun" ADD CONSTRAINT "BusinessWorkflowRun_businessId_bookingId_triggerEventId_fkey" FOREIGN KEY ("businessId", "bookingId", "triggerEventId") REFERENCES "NotificationOutbox"("businessId", "bookingId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_businessId_definitionId_fkey" FOREIGN KEY ("businessId", "definitionId") REFERENCES "BusinessWorkflowDefinition"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_businessId_bookingId_fkey" FOREIGN KEY ("businessId", "bookingId") REFERENCES "Booking"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_businessId_definitionId_bookingId_runId_fkey" FOREIGN KEY ("businessId", "definitionId", "bookingId", "runId") REFERENCES "BusinessWorkflowRun"("businessId", "definitionId", "bookingId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_businessId_completedByMembershipId_fkey" FOREIGN KEY ("businessId", "completedByMembershipId") REFERENCES "BusinessMembership"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowAction" ADD CONSTRAINT "BusinessWorkflowAction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowAction" ADD CONSTRAINT "BusinessWorkflowAction_businessId_membershipId_fkey" FOREIGN KEY ("businessId", "membershipId") REFERENCES "BusinessMembership"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowAction" ADD CONSTRAINT "BusinessWorkflowAction_businessId_definitionId_fkey" FOREIGN KEY ("businessId", "definitionId") REFERENCES "BusinessWorkflowDefinition"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWorkflowAction" ADD CONSTRAINT "BusinessWorkflowAction_businessId_definitionId_taskId_fkey" FOREIGN KEY ("businessId", "definitionId", "taskId") REFERENCES "BusinessTask"("businessId", "definitionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma cannot express these state and history invariants.
ALTER TABLE "BusinessWorkflowDefinition" ADD CONSTRAINT workflow_definition_state CHECK (
  revision > 0 AND "updatedAt" >= "createdAt"
  AND (("activationId" IS NULL AND "enabledAt" IS NULL AND NOT enabled)
    OR ("activationId" IS NOT NULL AND "enabledAt" IS NOT NULL AND "enabledAt" >= "createdAt"))
);
ALTER TABLE "BusinessWorkflowRun" ADD CONSTRAINT workflow_run_state CHECK (
  "policyRevision" > 0 AND attempts BETWEEN 0 AND 5 AND "availableAt" >= "createdAt"
  AND ("finishedAt" IS NULL OR "finishedAt" >= "createdAt")
  AND ("lastErrorCode" IS NULL OR "lastErrorCode" IN ('PROCESSING_FAILED','ATTEMPTS_EXHAUSTED'))
  AND (("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
    OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND status = 'PENDING' AND attempts > 0 AND "leaseExpiresAt" > "availableAt"))
  AND ((status = 'PENDING' AND "finishedAt" IS NULL AND "resultCode" IS NULL)
    OR (status = 'SUCCEEDED' AND "finishedAt" IS NOT NULL AND attempts > 0 AND "resultCode" IS NOT NULL AND "resultCode" = 'TASK_CREATED' AND "lastErrorCode" IS NULL AND "leaseToken" IS NULL)
    OR (status = 'SUPPRESSED' AND "finishedAt" IS NOT NULL AND "resultCode" IS NOT NULL AND "resultCode" IN ('WORKFLOW_DISABLED','BUSINESS_INACTIVE','BOOKING_CHANGED','APPOINTMENT_STARTED','ACTIVATION_CHANGED') AND "lastErrorCode" IS NULL AND "leaseToken" IS NULL)
    OR (status = 'DEAD' AND "finishedAt" IS NOT NULL AND attempts = 5 AND "resultCode" IS NULL AND "lastErrorCode" IS NOT NULL AND "leaseToken" IS NULL))
);
ALTER TABLE "BusinessTask" ADD CONSTRAINT business_task_state CHECK (
  revision > 0 AND "dueAt" > "createdAt" AND "updatedAt" >= "createdAt"
  AND ((status = 'COMPLETED' AND "completedByMembershipId" IS NOT NULL AND "completedAt" IS NOT NULL AND "completedAt" >= "createdAt" AND "completedAt" < "dueAt" AND "closedAt" IS NULL)
    OR (status <> 'COMPLETED' AND "completedByMembershipId" IS NULL AND "completedAt" IS NULL))
  AND ((status IN ('CANCELLED','EXPIRED') AND "closedAt" IS NOT NULL AND "closedAt" >= "createdAt") OR (status IN ('OPEN','COMPLETED') AND "closedAt" IS NULL))
  AND (status <> 'EXPIRED' OR "closedAt" >= "dueAt")
  AND (("invalidatedAt" IS NULL AND "invalidationReason" IS NULL)
    OR (status = 'COMPLETED' AND "invalidatedAt" IS NOT NULL AND "invalidationReason" IS NOT NULL AND "invalidatedAt" >= "completedAt" AND "invalidationReason" IN ('BOOKING_CANCELLED','BOOKING_RESCHEDULED','WORKFLOW_DISABLED')))
);
ALTER TABLE "BusinessWorkflowAction" ADD CONSTRAINT workflow_action_state CHECK (
  "idempotencyKey" ~ '^[!-~]{1,128}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 16384
  AND ((operation = 'SET_POLICY' AND "taskId" IS NULL) OR (operation = 'COMPLETE_TASK' AND "taskId" IS NOT NULL))
);

CREATE FUNCTION business_workflow_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.enabled OR NEW.revision <> 1 OR NEW."activationId" IS NOT NULL OR NEW."enabledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Workflow definitions start disabled' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW IS DISTINCT FROM OLD THEN
    IF (NEW.id,NEW."businessId",NEW.template,NEW."createdAt") IS DISTINCT FROM (OLD.id,OLD."businessId",OLD.template,OLD."createdAt")
      OR NEW.revision <> OLD.revision + 1 OR NEW."updatedAt" < OLD."updatedAt" OR NEW.enabled = OLD.enabled
      OR (NEW.enabled AND (NEW."activationId" IS NOT DISTINCT FROM OLD."activationId" OR NEW."enabledAt" < OLD."updatedAt"))
      OR (NOT NEW.enabled AND (NEW."activationId",NEW."enabledAt") IS DISTINCT FROM (OLD."activationId",OLD."enabledAt")) THEN
      RAISE EXCEPTION 'Invalid workflow policy transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_definition_guard BEFORE INSERT OR UPDATE ON "BusinessWorkflowDefinition"
FOR EACH ROW EXECUTE FUNCTION business_workflow_definition_guard();

CREATE FUNCTION business_workflow_run_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
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
  SELECT d.enabled,d."activationId",d.revision,d."enabledAt",b.active,k.status,p."startAt",e."eventType",e."occurredAt"
    INTO target FROM "BusinessWorkflowDefinition" d JOIN "Business" b ON b.id = d."businessId"
    JOIN "Booking" k ON k.id = NEW."bookingId" AND k."businessId" = d."businessId"
    JOIN "BookingProposal" p ON p.id = k."proposalId"
    JOIN "NotificationOutbox" e ON e.id = NEW."triggerEventId" AND e."businessId" = d."businessId" AND e."bookingId" = k.id
    WHERE d.id = NEW."definitionId" AND d."businessId" = NEW."businessId";
  IF NOT FOUND OR NOT target.enabled OR NOT target.active OR target.status <> 'CONFIRMED'
    OR target."eventType" NOT IN ('BOOKING_CONFIRMED','BOOKING_RESCHEDULED')
    OR NEW."activationId" <> target."activationId" OR NEW."policyRevision" <> target.revision
    OR NEW."createdAt" <> target."occurredAt" OR NEW."createdAt" < target."enabledAt" OR NEW."createdAt" >= target."startAt"
    OR NEW.status <> 'PENDING' OR NEW.attempts <> 0 OR NEW."leaseToken" IS NOT NULL OR NEW."lastErrorCode" IS NOT NULL
    OR NEW."availableAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'Workflow enrollment requires current owned opt-in and booking event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_run_guard BEFORE INSERT OR UPDATE ON "BusinessWorkflowRun"
FOR EACH ROW EXECUTE FUNCTION business_workflow_run_guard();

CREATE FUNCTION business_task_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE target record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW."businessId",NEW."definitionId",NEW."runId",NEW."bookingId",NEW.kind,NEW."dueAt",NEW."createdAt") IS DISTINCT FROM
       (OLD.id,OLD."businessId",OLD."definitionId",OLD."runId",OLD."bookingId",OLD.kind,OLD."dueAt",OLD."createdAt")
      OR NEW.revision <> OLD.revision + 1 OR NEW."updatedAt" < OLD."updatedAt" OR OLD.status IN ('CANCELLED','EXPIRED')
      OR (OLD.status = 'OPEN' AND NEW.status = 'OPEN')
      OR (OLD.status = 'COMPLETED' AND (NEW.status <> 'COMPLETED' OR OLD."invalidatedAt" IS NOT NULL OR NEW."invalidatedAt" IS NULL
        OR (NEW."completedAt",NEW."completedByMembershipId") IS DISTINCT FROM (OLD."completedAt",OLD."completedByMembershipId"))) THEN
      RAISE EXCEPTION 'Task identity and terminal history are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM id FROM "Business" WHERE id = NEW."businessId" FOR SHARE;
  SELECT r.status AS "runStatus",r."leaseToken",r."leaseExpiresAt",r."activationId",d."activationId" AS "currentActivation",d.enabled,d.template,b.active,k.status,p."startAt"
    INTO target FROM "BusinessWorkflowRun" r JOIN "BusinessWorkflowDefinition" d ON d.id = r."definitionId"
    JOIN "Business" b ON b.id = r."businessId" JOIN "Booking" k ON k.id = r."bookingId"
    JOIN "BookingProposal" p ON p.id = k."proposalId"
    WHERE r.id = NEW."runId" AND r."businessId" = NEW."businessId" AND r."definitionId" = NEW."definitionId" AND r."bookingId" = NEW."bookingId";
  IF NOT FOUND OR NEW."dueAt" <> target."startAt" OR NEW.kind <> target.template THEN
    RAISE EXCEPTION 'Task requires its owned execution and trusted due time' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'OPEN' OR NEW.revision <> 1 OR target."runStatus" <> 'PENDING'
    OR target."leaseToken" IS NULL OR target."leaseExpiresAt" <= NEW."createdAt" OR NOT target.enabled OR NOT target.active
    OR target."activationId" <> target."currentActivation" OR target.status <> 'CONFIRMED') THEN
    RAISE EXCEPTION 'Task creation requires a leased current execution' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD.status = 'OPEN') THEN
    IF NOT target.active OR NOT target.enabled OR target."activationId" <> target."currentActivation" OR target.status <> 'CONFIRMED'
      OR NOT EXISTS (SELECT 1 FROM "BusinessMembership" m JOIN "User" u ON u.id = m."userId"
        WHERE m.id = NEW."completedByMembershipId" AND m."businessId" = NEW."businessId" AND m.active AND u."isActive") THEN
      RAISE EXCEPTION 'Task completion requires current membership and booking' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_task_guard BEFORE INSERT OR UPDATE ON "BusinessTask"
FOR EACH ROW EXECUTE FUNCTION business_task_guard();

CREATE FUNCTION workflow_task_coverage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_id uuid; state "BusinessWorkflowRunStatus"; count_tasks integer;
BEGIN
  IF TG_TABLE_NAME = 'BusinessTask' THEN
    IF TG_OP = 'DELETE' THEN run_id := OLD."runId"; ELSE run_id := NEW."runId"; END IF;
  ELSE run_id := NEW.id; END IF;
  SELECT status INTO state FROM "BusinessWorkflowRun" WHERE id = run_id;
  SELECT count(*) INTO count_tasks FROM "BusinessTask" WHERE "runId" = run_id;
  IF (state = 'SUCCEEDED' AND count_tasks <> 1) OR (state <> 'SUCCEEDED' AND count_tasks <> 0) THEN
    RAISE EXCEPTION 'Successful run and unique task must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workflow_run_task_coverage AFTER INSERT OR UPDATE ON "BusinessWorkflowRun"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_task_coverage_guard();
CREATE CONSTRAINT TRIGGER workflow_task_run_coverage AFTER INSERT OR UPDATE OR DELETE ON "BusinessTask"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_task_coverage_guard();

CREATE FUNCTION business_workflow_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Successful workflow actions are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "BusinessMembership" m JOIN "User" u ON u.id = m."userId"
    JOIN "Business" b ON b.id = m."businessId"
    WHERE m.id = NEW."membershipId" AND m."businessId" = NEW."businessId" AND m.active AND u."isActive" AND b.active
      AND (NEW.operation <> 'SET_POLICY' OR m.role = 'OWNER')) THEN
    RAISE EXCEPTION 'Workflow action requires an authorized business member' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_action_guard BEFORE INSERT OR UPDATE ON "BusinessWorkflowAction"
FOR EACH ROW EXECUTE FUNCTION business_workflow_action_guard();
