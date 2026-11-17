import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabaseClient, type Prisma } from '@flowpilot/db';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/flowpilot_test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Use the dedicated local flowpilot_test database.');
}

test('Phase 2 booking persistence constraints', async (t) => {
  const db = createDatabaseClient(url);
  const tag = randomUUID();
  const businesses = await Promise.all(['a', 'b'].map((suffix) => db.business.create({ data: {
    slug: 'schema-' + tag + suffix, name: 'Synthetic schema fixture',
  } })));
  const a = businesses[0]!;
  const b = businesses[1]!;
  const businessIds = businesses.map((business) => business.id);
  t.after(async () => {
    try {
      await db.$transaction(async (tx) => {
        await tx.bookingAction.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.bookingSlot.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.booking.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.bookingProposal.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.customerSession.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.availabilitySlot.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.staff.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.service.deleteMany({ where: { businessId: { in: businessIds } } });
        await tx.business.deleteMany({ where: { id: { in: businessIds } } });
      });
    } finally { await db.$disconnect(); }
  });
  const staff = await db.staff.create({ data: { businessId: a.id, slug: 'alex', displayName: 'Alex' } });
  const otherStaff = await db.staff.create({ data: { businessId: a.id, slug: 'jamie', displayName: 'Jamie' } });
  const service = await db.service.create({ data: { businessId: a.id, slug: 'consultation', name: 'Consultation' } });
  const foreignService = await db.service.create({ data: { businessId: b.id, slug: 'other', name: 'Other' } });
  const sessionData = (businessId: string) => ({ businessId,
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date('2031-01-01T00:00:00Z') });
  const session = await db.customerSession.create({ data: sessionData(a.id) });
  const otherSession = await db.customerSession.create({ data: sessionData(a.id) });
  const foreignSession = await db.customerSession.create({ data: sessionData(b.id) });
  const slots = await Promise.all(Array.from({ length: 8 }, (_, index) => db.availabilitySlot.create({ data: {
    businessId: a.id, staffId: staff.id,
    startAt: new Date(Date.parse('2030-01-07T23:00:00Z') + index * 1800000),
    endAt: new Date(Date.parse('2030-01-07T23:30:00Z') + index * 1800000),
  } })));
  const wrongStaffSlot = await db.availabilitySlot.create({ data: {
    businessId: a.id, staffId: otherStaff.id, startAt: slots[1]!.startAt, endAt: slots[1]!.endAt,
  } });
  const proposalData = (index = 0, durationMinutes = 60) => ({
    businessId: a.id, sessionId: session.id, serviceId: service.id, staffId: staff.id,
    slotId: slots[index]!.id, durationMinutes, startAt: slots[index]!.startAt,
    endAt: new Date(+slots[index]!.startAt + durationMinutes * 60000),
    timezone: a.timezone, staffName: staff.displayName, serviceName: service.name,
    expiresAt: new Date('2031-01-01T00:00:00Z'),
  });
  const bookingData = (proposalId: string) => ({ businessId: a.id, sessionId: session.id, proposalId,
    reference: 'FP-' + randomUUID().toUpperCase(), customerName: 'Synthetic Customer', customerEmail: 'demo@example.test' });
  const claim = async (tx: Prisma.TransactionClient, proposalId: string, indices: number[]) => {
    const slotIds = indices.map((index) => slots[index]!.id);
    const result = await tx.availabilitySlot.updateMany({ where: { id: { in: slotIds }, state: 'AVAILABLE' }, data: { state: 'RESERVED' } });
    if (result.count !== slotIds.length) throw new Error('SLOT_UNAVAILABLE');
    const booking = await tx.booking.create({ data: bookingData(proposalId) });
    await tx.bookingSlot.createMany({ data: slotIds.map((slotId) => ({ businessId: a.id, staffId: staff.id, bookingId: booking.id, slotId })) });
    return booking;
  };

  await t.test('business limits, session hashes and composite ownership are enforced', async () => {
    assert.equal(a.maxBookingDurationMinutes, 120);
    for (const maximum of [0, 45, 1470]) {
      await assert.rejects(db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: maximum } }));
    }
    await assert.rejects(db.customerSession.create({ data: { ...sessionData(a.id), tokenHash: 'raw-token' } }));
    for (const patch of [{ sessionId: foreignSession.id }, { serviceId: foreignService.id }, { staffId: otherStaff.id }, { durationMinutes: 150, endAt: new Date(+slots[0]!.startAt + 150 * 60000) }]) {
      await assert.rejects(db.bookingProposal.create({ data: { ...proposalData(), ...patch } }));
    }
  });

  await t.test('proposals are immutable and bookings require full contiguous same-staff coverage', async () => {
    const proposal = await db.bookingProposal.create({ data: proposalData() });
    await assert.rejects(db.bookingProposal.update({ where: { id: proposal.id }, data: { durationMinutes: 30 } }));
    await assert.rejects(db.booking.create({ data: { ...bookingData(proposal.id), sessionId: otherSession.id } }));
    for (const indices of [[], [0], [0, 2]]) {
      await assert.rejects(db.$transaction((tx) => claim(tx, proposal.id, indices)));
    }
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.availabilitySlot.updateMany({ where: { id: { in: [slots[0]!.id, wrongStaffSlot.id] } }, data: { state: 'RESERVED' } });
      const booking = await tx.booking.create({ data: bookingData(proposal.id) });
      await tx.bookingSlot.createMany({ data: [
        { businessId: a.id, bookingId: booking.id, staffId: staff.id, slotId: slots[0]!.id },
        { businessId: a.id, bookingId: booking.id, staffId: otherStaff.id, slotId: wrongStaffSlot.id },
      ] });
    }));
    assert.equal(await db.booking.count({ where: { proposalId: proposal.id } }), 0);
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[0]!.id } })).state, 'AVAILABLE');
  });

  await t.test('a two-hour booking claims four slots and survives a lower future limit', async () => {
    const proposal = await db.bookingProposal.create({ data: proposalData(0, 120) });
    const booking = await db.$transaction((tx) => claim(tx, proposal.id, [0, 1, 2, 3]));
    await assert.rejects(db.availabilitySlot.update({ where: { id: slots[1]!.id }, data: { state: 'AVAILABLE' } }));
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.bookingSlot.updateMany({ where: { bookingId: booking.id }, data: { releasedAt: new Date() } });
    }));
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 60 } });
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'CONFIRMED');
    // Cancellation is exercised at the database boundary only; no cancellation API exists.
    await db.$transaction(async (tx) => {
      await tx.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await tx.bookingSlot.updateMany({ where: { bookingId: booking.id }, data: { releasedAt: new Date() } });
      await tx.availabilitySlot.updateMany({ where: { id: { in: slots.slice(0, 4).map((slot) => slot.id) } }, data: { state: 'AVAILABLE' } });
    });
    const newProposal = await db.bookingProposal.create({ data: proposalData() });
    const replacement = await db.$transaction((tx) => claim(tx, newProposal.id, [0, 1]));
    assert.notEqual(replacement.id, booking.id);
    assert.equal(await db.bookingSlot.count({ where: { slotId: slots[0]!.id } }), 2);
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 120 } });
  });

  await t.test('confirmation rechecks a reduced maximum against an older proposal', async () => {
    const proposal = await db.bookingProposal.create({ data: proposalData(4, 120) });
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 60 } });
    await assert.rejects(db.$transaction((tx) => claim(tx, proposal.id, [4, 5, 6, 7])));
    assert.equal((await db.availabilitySlot.findUniqueOrThrow({ where: { id: slots[4]!.id } })).state, 'AVAILABLE');
    await db.business.update({ where: { id: a.id }, data: { maxBookingDurationMinutes: 120 } });
  });

  await t.test('overlapping one-hour and half-hour transactions have one winner', async () => {
    const first = await db.bookingProposal.create({ data: proposalData(4, 60) });
    const second = await db.bookingProposal.create({ data: proposalData(5, 30) });
    const results = await Promise.allSettled([
      db.$transaction((tx) => claim(tx, first.id, [4, 5])),
      db.$transaction((tx) => claim(tx, second.id, [5])),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(await db.booking.count({ where: { proposalId: { in: [first.id, second.id] } } }), 1);
    // Bypass the conditional claim to prove uniqueness independently of service code.
    const winner = results.find((result) => result.status === 'fulfilled');
    assert.ok(winner?.status === 'fulfilled');
    const losingProposal = winner.value.proposalId === first.id ? second : first;
    await assert.rejects(db.$transaction(async (tx) => {
      const booking = await tx.booking.create({ data: bookingData(losingProposal.id) });
      await tx.bookingSlot.create({ data: { businessId: a.id, bookingId: booking.id, staffId: staff.id, slotId: slots[5]!.id } });
    }));
  });

  await t.test('action keys are scoped, constrained and bind the result to its owner/proposal', async () => {
    const proposal = await db.bookingProposal.create({ data: proposalData(6, 30) });
    const action = { businessId: a.id, sessionId: session.id, operation: 'PROPOSE' as const,
      idempotencyKey: 'demo-retry', requestFingerprint: 'a'.repeat(64), proposalId: proposal.id, response: { id: proposal.id } };
    await db.bookingAction.create({ data: action });
    await assert.rejects(db.bookingAction.create({ data: action }));
    await assert.rejects(db.bookingAction.create({ data: { ...action, idempotencyKey: 'foreign', sessionId: otherSession.id } }));
    await assert.rejects(db.bookingAction.create({ data: { ...action, idempotencyKey: 'confirm', operation: 'CONFIRM' } }));
    await assert.rejects(db.bookingAction.create({ data: { ...action, idempotencyKey: 'bad-hash', requestFingerprint: 'raw input' } }));
    const otherProposal = await db.bookingProposal.create({ data: { ...proposalData(6, 30), sessionId: otherSession.id } });
    await db.bookingAction.create({ data: { ...action, sessionId: otherSession.id, proposalId: otherProposal.id } });
  });
});
