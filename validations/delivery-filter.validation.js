import { z } from "zod"

const optionalNumber = () => z.coerce.number().optional()
const optionalString = () => z.string().max(100).optional()

export const driverAvailableDeliveriesQuerySchema = z.object({
  query: z.object({
    radius_km: z.coerce.number().positive().max(500).optional(),
    min_price: z.coerce.number().nonnegative().optional(),
    max_price: z.coerce.number().nonnegative().optional(),
    package_size: z.enum(["small", "medium", "large"]).optional(),
    wilaya_pickup: optionalString(),
    wilaya_dropoff: optionalString(),
    max_weight_kg: z.coerce.number().positive().optional(),
    sort_by: z.enum(["price_desc", "price_asc", "distance_asc", "newest"]).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
})

export const saveFilterPreferencesSchema = z.object({
  body: z.object({
    radius_km: z.number().positive().max(500).optional(),
    min_price: z.number().nonnegative().optional(),
    max_price: z.number().nonnegative().optional(),
    package_size: z.enum(["small", "medium", "large"]).optional(),
    wilaya_pickup: z.string().max(100).optional(),
    wilaya_dropoff: z.string().max(100).optional(),
    max_weight_kg: z.number().positive().optional(),
    sort_by: z.enum(["price_desc", "price_asc", "distance_asc", "newest"]).optional(),
    default_radius_km: z.number().positive().max(500).optional(),
  }).optional().default({}),
})
