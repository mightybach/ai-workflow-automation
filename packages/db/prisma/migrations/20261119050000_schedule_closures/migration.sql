BEGIN;
CREATE TABLE "ScheduleClosure" (
  id uuid PRIMARY KEY, "businessId" uuid NOT NULL, "staffId" uuid,
  "startAt" timestamptz(3) NOT NULL, "endAt" timestamptz(3) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "releasedAt" timestamptz(3),
  CONSTRAINT "ScheduleClosure_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScheduleClosure_businessId_staffId_fkey" FOREIGN KEY ("businessId", "staffId") REFERENCES "Staff"("businessId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScheduleClosure_interval_check" CHECK ("endAt" > "startAt" AND "endAt" - "startAt" <= INTERVAL '2 days'
    AND mod(extract(epoch FROM "startAt"),1800) = 0 AND mod(extract(epoch FROM "endAt"),1800) = 0),
  CONSTRAINT "ScheduleClosure_release_check" CHECK ("releasedAt" IS NULL OR "releasedAt" >= "createdAt")
);
CREATE INDEX "ScheduleClosure_businessId_startAt_endAt_idx" ON "ScheduleClosure"("businessId", "startAt", "endAt");
CREATE INDEX "ScheduleClosure_businessId_staffId_idx" ON "ScheduleClosure"("businessId", "staffId");
CREATE UNIQUE INDEX "ScheduleClosure_active_business_window" ON "ScheduleClosure"("businessId", "startAt", "endAt") WHERE "staffId" IS NULL AND "releasedAt" IS NULL;
CREATE UNIQUE INDEX "ScheduleClosure_active_staff_window" ON "ScheduleClosure"("businessId", "staffId", "startAt", "endAt") WHERE "staffId" IS NOT NULL AND "releasedAt" IS NULL;

-- VOLATILE trigger queries take fresh READ COMMITTED snapshots after lock waits.
-- Lock ordering matches application Business-first inventory/booking writes.
CREATE FUNCTION schedule_closure_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM id FROM "Business" WHERE id = NEW."businessId" FOR UPDATE;
  IF TG_OP = 'UPDATE' AND ((NEW.id,NEW."businessId",NEW."staffId",NEW."startAt",NEW."endAt",NEW."createdAt") IS DISTINCT FROM
      (OLD.id,OLD."businessId",OLD."staffId",OLD."startAt",OLD."endAt",OLD."createdAt") OR
      (OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt")) THEN
    RAISE EXCEPTION 'Closure identity/history is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."releasedAt" IS NULL AND EXISTS (SELECT 1 FROM "AvailabilitySlot" s
      WHERE s."businessId" = NEW."businessId" AND (NEW."staffId" IS NULL OR s."staffId" = NEW."staffId")
      AND s."startAt" < NEW."endAt" AND s."endAt" > NEW."startAt" AND s.state <> 'BLOCKED') THEN
    RAISE EXCEPTION 'An active closure requires all overlapping inventory blocked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ScheduleClosure_guard" BEFORE INSERT OR UPDATE ON "ScheduleClosure" FOR EACH ROW EXECUTE FUNCTION schedule_closure_guard();

CREATE FUNCTION inventory_closure_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM id FROM "Business" WHERE id = NEW."businessId" FOR SHARE;
  IF NEW.state <> 'BLOCKED' AND EXISTS (SELECT 1 FROM "ScheduleClosure" c
      WHERE c."businessId" = NEW."businessId" AND c."releasedAt" IS NULL AND (c."staffId" IS NULL OR c."staffId" = NEW."staffId")
      AND c."startAt" < NEW."endAt" AND c."endAt" > NEW."startAt") THEN
    RAISE EXCEPTION 'Inventory overlapping an active closure must remain blocked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AvailabilitySlot_closure_guard" BEFORE INSERT OR UPDATE ON "AvailabilitySlot" FOR EACH ROW EXECUTE FUNCTION inventory_closure_guard();
COMMIT;
