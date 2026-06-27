import { z } from "zod"

const incidentSeveritySchema = z.enum(["low", "medium", "high", "critical"])
const incidentStatusSchema = z.enum(["open", "in_review", "resolved", "dismissed"])

const complaintCategorySchema = z.enum(["driver_behavior", "delay", "damage", "payment", "fraud", "other"])
const complaintStatusSchema = z.enum(["new", "in_review", "resolved", "rejected"])

const reportTypeSchema = z.enum(["daily", "weekly", "monthly", "incident", "custom"])
const reportStatusSchema = z.enum(["draft", "published", "archived"])

export const authorityListQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const listDriverReviewQueueSchema = z.object({
  query: z.object({
    reviewStatus: z.enum(["pending", "approved", "rejected"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const updateDriverReviewDecisionSchema = z.object({
  params: z.object({
    driverId: z.string().min(1),
  }),
  body: z.object({
    reviewStatus: z.enum(["pending", "approved", "rejected"]),
    reason: z.string().max(500).optional(),
  }),
})

export const getDriverReviewTimelineSchema = z.object({
  params: z.object({
    driverId: z.string().min(1),
  }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const createIncidentSchema = z.object({
  body: z.object({
    deliveryId: z.string().optional(),
    tripId: z.string().optional(),
    reportedByUserId: z.string().optional(),
    assignedToAuthorityId: z.string().optional(),
    severity: incidentSeveritySchema.optional(),
    status: incidentStatusSchema.optional(),
    title: z.string().min(3).max(160),
    description: z.string().min(3).max(2000),
    resolutionNotes: z.string().max(2000).optional(),
    occurredAt: z.string().datetime().optional(),
    resolvedAt: z.string().datetime().optional(),
  }),
})

export const listIncidentsSchema = z.object({
  query: z.object({
    status: incidentStatusSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    deliveryId: z.string().optional(),
    assignedToAuthorityId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const authorityIncidentIdSchema = z.object({
  params: z.object({
    incidentId: z.string().min(1),
  }),
})

export const updateIncidentSchema = z.object({
  params: z.object({
    incidentId: z.string().min(1),
  }),
  body: z
    .object({
      assignedToAuthorityId: z.string().nullable().optional(),
      severity: incidentSeveritySchema.optional(),
      status: incidentStatusSchema.optional(),
      title: z.string().min(3).max(160).optional(),
      description: z.string().min(3).max(2000).optional(),
      resolutionNotes: z.string().max(2000).optional(),
      occurredAt: z.string().datetime().nullable().optional(),
      resolvedAt: z.string().datetime().nullable().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
      path: ["status"],
    }),
})

export const createComplaintSchema = z.object({
  body: z.object({
    complainantUserId: z.string().min(1),
    targetUserId: z.string().optional(),
    deliveryId: z.string().optional(),
    tripId: z.string().optional(),
    handledByAuthorityId: z.string().optional(),
    category: complaintCategorySchema,
    status: complaintStatusSchema.optional(),
    description: z.string().min(3).max(2000),
    resolutionNotes: z.string().max(2000).optional(),
  }),
})

export const listComplaintsSchema = z.object({
  query: z.object({
    status: complaintStatusSchema.optional(),
    category: complaintCategorySchema.optional(),
    complainantUserId: z.string().optional(),
    deliveryId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const authorityComplaintIdSchema = z.object({
  params: z.object({
    complaintId: z.string().min(1),
  }),
})

export const updateComplaintSchema = z.object({
  params: z.object({
    complaintId: z.string().min(1),
  }),
  body: z
    .object({
      targetUserId: z.string().nullable().optional(),
      deliveryId: z.string().nullable().optional(),
      tripId: z.string().nullable().optional(),
      handledByAuthorityId: z.string().nullable().optional(),
      category: complaintCategorySchema.optional(),
      status: complaintStatusSchema.optional(),
      description: z.string().min(3).max(2000).optional(),
      resolutionNotes: z.string().max(2000).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
      path: ["status"],
    }),
})

export const createComplianceReportSchema = z.object({
  body: z.object({
    type: reportTypeSchema,
    status: reportStatusSchema.optional(),
    generatedBy: z.string().optional(),
    periodStart: z.string().datetime().optional(),
    periodEnd: z.string().datetime().optional(),
    summary: z.string().max(5000).optional(),
    reportJson: z.record(z.any()).optional(),
  }),
})

export const listComplianceReportsSchema = z.object({
  query: z.object({
    status: reportStatusSchema.optional(),
    type: reportTypeSchema.optional(),
    generatedBy: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const authorityClientsQuerySchema = z.object({
  query: z.object({
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const authorityClientIdSchema = z.object({
  params: z.object({
    clientId: z.string().min(1),
  }),
})

export const authorityDriversQuerySchema = z.object({
  query: z.object({
    type: z.enum(["normal", "pro_transporter"]).optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const authorityDriverIdSchema = z.object({
  params: z.object({
    driverId: z.string().min(1),
  }),
})

export const authorityDeliveriesQuerySchema = z.object({
  query: z.object({
    status: z.enum(["active", "completed", "cancelled"]).optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

export const authorityDeliveryIdSchema = z.object({
  params: z.object({
    deliveryId: z.string().min(1),
  }),
})

export const authorityComplianceReportIdSchema = z.object({
  params: z.object({
    reportId: z.string().min(1),
  }),
})

export const updateComplianceReportSchema = z.object({
  params: z.object({
    reportId: z.string().min(1),
  }),
  body: z
    .object({
      type: reportTypeSchema.optional(),
      status: reportStatusSchema.optional(),
      generatedBy: z.string().nullable().optional(),
      periodStart: z.string().datetime().nullable().optional(),
      periodEnd: z.string().datetime().nullable().optional(),
      summary: z.string().max(5000).nullable().optional(),
      reportJson: z.record(z.any()).nullable().optional(),
      publishedAt: z.string().datetime().nullable().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
      path: ["status"],
    }),
})
