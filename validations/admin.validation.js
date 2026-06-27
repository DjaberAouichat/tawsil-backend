import { z } from "zod"

export const updateDriverReviewStatusAdminSchema = z.object({
  params: z.object({
    driverId: z.string().min(1),
  }),
  body: z.object({
    reviewStatus: z.enum(["pending", "approved", "rejected", "blocked"]),
    reason: z.string().max(500).optional(),
  }),
})

export const getDriverVerificationTimelineAdminSchema = z.object({
  params: z.object({
    driverId: z.string().min(1),
  }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const listAdminTripsSchema = z.object({
  query: z.object({
    status: z.enum(["planned", "active", "completed", "cancelled"]).optional(),
    driverId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const listAdminDriverReviewsSchema = z.object({
  query: z.object({
    reviewStatus: z.enum(["pending", "approved", "rejected", "blocked"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    search: z.string().trim().max(200).optional(),
  }),
})

