import crypto from "crypto"
import {
  createDocument,
  findDocumentById,
  findDocumentsByDriverId,
  updateDocument,
  verifyDocument,
  rejectDocument,
  deleteDocument,
} from "../models/document.model.js"
import { findDriverByUserId } from "../models/driver.model.js"
import { addDriverVerificationTimelineEvent } from "../models/driver.model.js"
import { sendSuccess, createError } from "../utils/response.js"

const VALID_TYPES = ["ID_CARD", "LICENSE", "INSURANCE", "VEHICLE_REG", "RC"]

export const addDocument = async (req, res, next) => {
  try {
    const driverId = req.user.id
    const driver = await findDriverByUserId(null, driverId)
    if (!driver) return next(createError(404, "Driver profile not found"))

    const { documentType, documentUrl, expiryDate } = req.body

    if (!documentType || !documentUrl) {
      return next(createError(400, "documentType and documentUrl are required"))
    }

    if (!VALID_TYPES.includes(documentType)) {
      return next(createError(400, `documentType must be one of: ${VALID_TYPES.join(", ")}`))
    }

    const doc = await createDocument(null, {
      id: crypto.randomUUID(),
      driverId,
      documentType,
      documentUrl,
      expiryDate: expiryDate || null,
    })

    await addDriverVerificationTimelineEvent(null, {
      driverId,
      eventType: "document_added",
      entityType: "document",
      entityId: doc.id,
      status: "pending",
      actorId: req.user.id,
      metadata: {
        documentType,
      },
    })

    return sendSuccess(res, 201, "Document added successfully", { document: doc })
  } catch (error) {
    next(error)
  }
}

export const getMyDocuments = async (req, res, next) => {
  try {
    const documents = await findDocumentsByDriverId(null, req.user.id)
    return sendSuccess(res, 200, "Documents fetched successfully", { documents })
  } catch (error) {
    next(error)
  }
}

export const getDriverDocuments = async (req, res, next) => {
  try {
    const documents = await findDocumentsByDriverId(null, req.params.driverId)
    return sendSuccess(res, 200, "Documents fetched successfully", { documents })
  } catch (error) {
    next(error)
  }
}

export const modifyDocument = async (req, res, next) => {
  try {
    const doc = await findDocumentById(null, req.params.documentId)
    if (!doc) return next(createError(404, "Document not found"))

    const isAdmin = req.user.role === "admin" || req.user.role === "authority"
    if (doc.driverId !== req.user.id && !isAdmin) {
      return next(createError(403, "You can only modify your own documents"))
    }

    const updated = await updateDocument(null, req.params.documentId, req.body)

    await addDriverVerificationTimelineEvent(null, {
      driverId: doc.driverId,
      eventType: "document_updated",
      entityType: "document",
      entityId: updated.id,
      status: updated.reviewStatus || "pending",
      actorId: req.user.id,
      metadata: {
        documentType: updated.documentType,
      },
    })

    return sendSuccess(res, 200, "Document updated successfully", { document: updated })
  } catch (error) {
    next(error)
  }
}

export const verifyDocumentHandler = async (req, res, next) => {
  try {
    const doc = await findDocumentById(null, req.params.documentId)
    if (!doc) return next(createError(404, "Document not found"))

    const updated = await verifyDocument(null, req.params.documentId, {
      reviewerId: req.user.id,
    })

    await addDriverVerificationTimelineEvent(null, {
      driverId: doc.driverId,
      eventType: "document_reviewed",
      entityType: "document",
      entityId: updated.id,
      status: "approved",
      actorId: req.user.id,
      metadata: {
        documentType: updated.documentType,
      },
    })

    return sendSuccess(res, 200, "Document verified successfully", { document: updated })
  } catch (error) {
    next(error)
  }
}

export const rejectDocumentHandler = async (req, res, next) => {
  try {
    const doc = await findDocumentById(null, req.params.documentId)
    if (!doc) return next(createError(404, "Document not found"))

    const updated = await rejectDocument(null, req.params.documentId, {
      reviewerId: req.user.id,
      reason: req.body?.reason || null,
    })

    await addDriverVerificationTimelineEvent(null, {
      driverId: doc.driverId,
      eventType: "document_reviewed",
      entityType: "document",
      entityId: updated.id,
      status: "rejected",
      reason: req.body?.reason || null,
      actorId: req.user.id,
      metadata: {
        documentType: updated.documentType,
      },
    })

    return sendSuccess(res, 200, "Document rejected successfully", { document: updated })
  } catch (error) {
    next(error)
  }
}

export const deleteDocumentHandler = async (req, res, next) => {
  try {
    const doc = await findDocumentById(null, req.params.documentId)
    if (!doc) return next(createError(404, "Document not found"))

    const isAdmin = req.user.role === "admin" || req.user.role === "authority"
    if (doc.driverId !== req.user.id && !isAdmin) {
      return next(createError(403, "You can only delete your own documents"))
    }

    await deleteDocument(null, req.params.documentId)
    return sendSuccess(res, 200, "Document deleted successfully", { documentId: req.params.documentId })
  } catch (error) {
    next(error)
  }
}

