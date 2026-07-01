import { z } from "zod"

export const submitRatingSchema = z.object({
  body: z.object({
    communicationRating: z.number().int().min(1).max(5),
    packageRating: z.number().int().min(1).max(5),
    deliveryTimeRating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  }),
})

export const submitClientRatingSchema = z.object({
  body: z.object({
    communicationRating: z.number().int().min(1).max(5),
    flexibilityRating: z.number().int().min(1).max(5),
    meetingRespectRating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  }),
})
