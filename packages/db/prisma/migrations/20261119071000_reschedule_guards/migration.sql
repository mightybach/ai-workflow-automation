-- Keep one replacement successor and require the source's historical release
-- before creating a linked replacement. Complete claims are checked at commit.
CREATE FUNCTION reschedule_booking_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE source_id uuid; source_row record;
BEGIN
  SELECT "rescheduleOfId" INTO source_id FROM "BookingProposal" WHERE id = NEW."proposalId";
  IF source_id IS NULL THEN RETURN NEW; END IF;
  PERFORM id FROM "Business" WHERE id = NEW."businessId" FOR UPDATE;
  SELECT "businessId", "sessionId", status INTO source_row FROM "Booking" WHERE id = source_id FOR UPDATE;
  IF NOT FOUND OR source_row."businessId" <> NEW."businessId" OR source_row."sessionId" <> NEW."sessionId" OR source_row.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Rescheduling requires a released owned source' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "Booking" b JOIN "BookingProposal" p ON p.id = b."proposalId" WHERE p."rescheduleOfId" = source_id) THEN
    RAISE EXCEPTION 'A booking can have only one replacement successor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Booking_reschedule_guard" BEFORE INSERT ON "Booking" FOR EACH ROW EXECUTE FUNCTION reschedule_booking_guard();
