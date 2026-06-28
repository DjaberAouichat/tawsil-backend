import { z } from "zod"

export const submitRatingSchema = z.object({
  body: z.object({
    communicationRating: z.number({ required_error: "communicationRating is required" }).int().min(1).max(5),
    packageRating: z.number({ required_error: "packageRating is required" }).int().min(1).max(5),
    deliveryTimeRating: z.number({ required_error: "deliveryTimeRating is required" }).int().min(1).max(5),
    comment: z.string().max(500).optional(),
  }),
})
