import { z } from "zod"

// ── Document ───────────────────────────────────────────────────────────

export const addDocumentSchema = z.object({
  body: z.object({
    documentType: z.enum(["ID_CARD", "LICENSE", "INSURANCE", "VEHICLE_REG"]),
    documentUrl: z.string().url(),
    expiryDate: z.string().optional(),
  }),
})

export const modifyDocumentSchema = z.object({
  params: z.object({
    documentId: z.string().min(1),
  }),
  body: z
    .object({
      documentUrl: z.string().url().optional(),
      expiryDate: z.string().nullable().optional(),
    })
    .refine((data) => data.documentUrl !== undefined || data.expiryDate !== undefined, {
      message: "At least one field is required",
      path: ["documentUrl"],
    }),
})

export const reviewDocumentSchema = z.object({
  params: z.object({
    documentId: z.string().min(1),
  }),
  body: z
    .object({
      reason: z.string().max(500).optional(),
    })
    .optional(),
})

export const documentIdParamSchema = z.object({
  params: z.object({
    documentId: z.string().min(1),
  }),
})

// ── Vehicle ────────────────────────────────────────────────────────────

const vehicleTypeSchema = z.enum(["standard", "comfort", "premium", "van"])

export const addVehicleSchema = z.object({
  body: z.object({
    type: vehicleTypeSchema.optional(),
    make: z.string().min(2).max(50),
    model: z.string().min(2).max(50),
    year: z.number().int().min(1900).max(2100).optional(),
    color: z.string().max(30).optional(),
    licensePlate: z.string().max(20).optional(),
    insuranceNumber: z.string().max(50).optional(),
    insuranceExpiry: z.string().optional(),
  }),
})

export const updateVehicleSchema = z.object({
  params: z.object({
    vehicleId: z.string().min(1),
  }),
  body: z
    .object({
      type: vehicleTypeSchema.optional(),
      make: z.string().min(2).max(50).optional(),
      model: z.string().min(2).max(50).optional(),
      year: z.number().int().min(1900).max(2100).optional(),
      color: z.string().max(30).optional(),
      licensePlate: z.string().max(20).optional(),
      insuranceNumber: z.string().max(50).optional(),
      insuranceExpiry: z.string().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
      path: ["make"],
    }),
})

export const assignVehicleSchema = z.object({
  params: z.object({
    vehicleId: z.string().min(1),
  }),
  body: z.object({
    driverId: z.string().min(1),
  }),
})

export const verifyVehicleSchema = z.object({
  params: z.object({
    vehicleId: z.string().min(1),
  }),
  body: z.object({
    verified: z.boolean(),
  }),
})

export const vehicleIdParamSchema = z.object({
  params: z.object({
    vehicleId: z.string().min(1),
  }),
})
