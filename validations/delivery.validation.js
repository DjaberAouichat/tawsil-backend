import { z } from "zod"

const coordinatesSchema = z
  .array(z.number())
  .length(2, "Coordinates must contain [lng, lat]")
  .refine(
    ([lng, lat]) => Math.abs(lng) <= 180 && Math.abs(lat) <= 90,
    "Coordinates must be valid [lng, lat]",
  )

const locationPointSchema = z.object({
  address: z.string().min(3),
  location: z.object({
    coordinates: coordinatesSchema,
  }),
})

const packageSchema = z.object({
  type: z.string().min(2),
  description: z.string().min(3).max(500),
  weightKg: z.number().min(0).optional(),
  dimensionsCm: z
    .object({
      length: z.number().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  volumeM3: z.number().positive().optional(),
  sizeCategory: z.enum(["small", "medium", "large", "xlarge"]),
})

export const estimateDeliveryPriceSchema = z.object({
  pickup: locationPointSchema,
  dropoff: locationPointSchema,
  package: packageSchema,
  isUrgent: z.boolean().optional(),
})

export const createDeliverySchema = z.object({
  pickup: locationPointSchema,
  dropoff: locationPointSchema,
  recipient: z.object({
    name: z.string().min(2).max(120),
    phone: z.string().regex(/^(?:\+213[5-7]\d{8}|0[5-7]\d{8})$/, "Format de numéro de téléphone algérien invalide"),
  }),
  package: packageSchema,
  packageImageUrl: z.string().url().optional(),
  deliveryNote: z.string().max(500).optional(),
  paymentMethod: z.enum(["card", "cash", "paypal"]).optional(),
  tripId: z.string().optional(),
  isUrgent: z.boolean().optional(),
  estimateId: z.string().uuid().optional(),
  publishNow: z.boolean().optional(),
})

export const createDraftDeliverySchema = z.object({
  pickup: locationPointSchema,
  dropoff: locationPointSchema,
  recipient: z.object({
    name: z.string().min(2).max(120),
    phone: z.string().regex(/^(?:\+213[5-7]\d{8}|0[5-7]\d{8})$/, "Format de numéro de téléphone algérien invalide"),
  }),
  package: packageSchema,
  packageImageUrl: z.string().url().optional(),
  deliveryNote: z.string().max(500).optional(),
  paymentMethod: z.enum(["card", "cash", "paypal"]).optional(),
  tripId: z.string().optional(),
  isUrgent: z.boolean().optional(),
  estimateId: z.string().uuid().optional(),
})

export const publishDraftDeliverySchema = z.object({
  estimateId: z.string().uuid().optional(),
})

export const attachDeliveryToTripSchema = z.object({
  tripId: z.string(),
})

export const cancelDeliverySchema = z.object({
  reason: z.string().max(300).optional(),
})

export const acceptDeliverySchema = z.object({
  tripId: z.string().optional(),
})

export const rejectDeliverySchema = z.object({
  reason: z.string().max(300).optional(),
})

export const markDeliveredSchema = z.object({
  proofOfDelivery: z.object({
    photoUrl: z.string().url().optional(),
    recipientName: z.string().min(2).max(120).optional(),
    recipientSignature: z.string().max(2000).optional(),
    recipientCode: z.string().min(1).max(40),
    notes: z.string().max(300).optional(),
  }),
  finalPrice: z.number().min(0).optional(),
})

export const updateDeliveryProgressSchema = z.object({
  status: z.enum([
    "DriverArrivedPickup",
    "PickedUp",
    "InTransit",
    "ArrivedDropoff",
    "FailedDelivery",
  ]),
})

export const updatePaymentStatusSchema = z.object({
  status: z.enum(["pending", "completed", "failed", "refunded", "cash_pending", "cash_received"]),
  transactionId: z.string().max(120).optional(),
})

export const updateDriverLocationSchema = z.object({
  coordinates: coordinatesSchema,
})
