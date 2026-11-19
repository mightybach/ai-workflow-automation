import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { BookingDurationMinutesSchema } from './bookings.js';

export const BusinessBookingSettingsSchema = z.object({
  businessId: IdSchema,
  maxBookingDurationMinutes: BookingDurationMinutesSchema,
  updatedAt: TimestampSchema,
}).strict();

// Business/actor/role come from the authenticated membership, never this body.
// Require the last observed revision to prevent silently overwriting another edit.
export const UpdateBusinessBookingSettingsSchema = z.object({
  maxBookingDurationMinutes: BookingDurationMinutesSchema,
  expectedUpdatedAt: TimestampSchema,
}).strict();
export type BusinessBookingSettings = z.infer<typeof BusinessBookingSettingsSchema>;
export type UpdateBusinessBookingSettings = z.infer<typeof UpdateBusinessBookingSettingsSchema>;
