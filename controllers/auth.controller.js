import path from "path"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import jwt from "jsonwebtoken"
import { getPool, withTransaction } from "../lib/db.js"
import {
  consumeUserToken,
  createUser,
  createUserToken,
  findUserByEmail,
  findUserById,
  findUserByPhone,
  getUserRole,
  updateUserEmailVerified,
  updateUserPassword,
  updateUserProfile,
} from "../models/user.model.js"
import {
  createDriverProfile,
  createRequesterProfile,
  createVehicle,
  ensureParticipant,
  findDriverByUserId,
  createDriverDocument,
  findDriverDocumentsByDriverId,
} from "../models/driver.model.js"
import { listDriverVerificationTimeline, addDriverVerificationTimelineEvent } from "../models/driver.model.js"
import { createError, sendSuccess } from "../utils/response.js"
import { toSqlDateTime } from "../utils/helpers.js"
import { deleteLocalUploadFile, buildPublicUploadUrl } from "../utils/profile-picture.utils.js"
import { sendPasswordResetEmail, sendVerificationEmail } from "../utils/email.utils.js"

const normalizeEmail = (email) => String(email || "").trim().toLowerCase()

const ADMIN_BOOTSTRAP_EMAIL = process.env.ADMIN_BOOTSTRAP_EMAIL
const ADMIN_BOOTSTRAP_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD

const normalizeName = (value) => String(value || "").trim().replace(/\s+/g, " ")

const normalizeProfileNamePair = (firstName, lastName) => {
  const first = normalizeName(firstName)
  const last = normalizeName(lastName)

  if (!first && !last) {
    return { firstName: "", lastName: "" }
  }

  if (!first) {
    return { firstName: last, lastName: "" }
  }

  if (!last) {
    return { firstName: first, lastName: "" }
  }

  const firstLower = first.toLowerCase()
  const lastLower = last.toLowerCase()

  if (firstLower === lastLower) {
    return { firstName: first, lastName: "" }
  }

  if (firstLower.includes(lastLower)) {
    return { firstName: first, lastName: "" }
  }

  if (lastLower.includes(firstLower)) {
    return { firstName: last, lastName: "" }
  }

  return { firstName: first, lastName: last }
}

const normalizePhone = (phone) =>
  String(phone || "")
    .trim()
    .replace(/[\s-]+/g, "")

const ALGERIA_MOBILE_LOCAL = /^0[5-7]\d{8}$/
const ALGERIA_MOBILE_E164 = /^\+213[5-7]\d{8}$/
const ALGERIA_MOBILE_NO_PLUS = /^213[5-7]\d{8}$/

const toAlgeriaE164 = (phone) => {
  const normalized = normalizePhone(phone)
  if (!normalized) {
    return ""
  }

  if (ALGERIA_MOBILE_E164.test(normalized)) {
    return normalized
  }

  if (ALGERIA_MOBILE_NO_PLUS.test(normalized)) {
    return `+${normalized}`
  }

  if (ALGERIA_MOBILE_LOCAL.test(normalized)) {
    return `+213${normalized.slice(1)}`
  }

  return normalized
}

const toAlgeriaLocal = (phone) => {
  const normalized = normalizePhone(phone)
  if (!normalized) {
    return ""
  }

  if (ALGERIA_MOBILE_LOCAL.test(normalized)) {
    return normalized
  }

  if (ALGERIA_MOBILE_E164.test(normalized)) {
    return `0${normalized.slice(4)}`
  }

  if (ALGERIA_MOBILE_NO_PLUS.test(normalized)) {
    return `0${normalized.slice(3)}`
  }

  return normalized
}

const phoneVariants = (phone) => {
  const base = normalizePhone(phone)
  if (!base) {
    return []
  }

  const variants = new Set()
  variants.add(base)

  const e164 = toAlgeriaE164(base)
  if (e164) {
    variants.add(e164)
  }

  const local = toAlgeriaLocal(base)
  if (local) {
    variants.add(local)
  }

  if (e164) {
    variants.add(toAlgeriaLocal(e164))
  }
  if (local) {
    variants.add(toAlgeriaE164(local))
  }

  return Array.from(variants).filter(Boolean)
}

const isEmailLike = (value) => String(value || "").includes("@")

const sanitizeUser = (user) => {
  if (!user) {
    return null
  }

  const safe = { ...user }
  delete safe.passwordHash
  return safe
}

const hashToken = (value) => crypto.createHash("sha256").update(String(value)).digest("hex")

const buildVerificationCode = () => String(Math.floor(100000 + Math.random() * 900000))

const signJwt = ({ userId, role, tokenVersion = 0 }) => {
  const token = jwt.sign({ id: userId, role, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  })

  return token
}

const mapMySqlError = (error) => {
  if (error?.code === "ER_DUP_ENTRY") {
    return createError(409, "Duplicate value", {
      code: "DUPLICATE_ENTRY",
      message: error?.message,
    })
  }

  if (error?.code === "ER_NO_REFERENCED_ROW_2" || error?.code === "ER_ROW_IS_REFERENCED_2") {
    return createError(409, "Foreign key constraint failed", {
      code: "FK_CONSTRAINT",
      message: error?.message,
    })
  }

  return null
}

export const register = async (req, res, next) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      phone,
      role,
      licenseNumber,
      licenseExpiry,
      idCard,
      vehicleMake,
      vehicleModel,
      vehicleYear,
      vehicleColor,
      vehicleLicensePlate,
      vehicleInsuranceNumber,
      vehicleInsuranceExpiry,
    } = req.body

    const normalizedEmail = normalizeEmail(email)
    const normalizedPhone = normalizePhone(phone)
    const canonicalPhone = toAlgeriaE164(normalizedPhone)
    const requestedRole = String(role || "").trim().toLowerCase()

    if (!firstName || !lastName || !normalizedEmail || !password || !normalizedPhone || !requestedRole) {
      return next(createError(400, "Tous les champs sont obligatoires"))
    }

    const userId = crypto.randomUUID()
    const passwordHash = await bcrypt.hash(String(password), 10)

    const verificationCode = buildVerificationCode()
    const verificationExpiresAt = Date.now() + 15 * 60 * 1000
    const verificationTokenHash = hashToken(verificationCode)

    const createdUser = await withTransaction(async (connection) => {
      const existingEmail = await findUserByEmail(connection, normalizedEmail)
      if (existingEmail) {
        throw createError(409, "Un utilisateur avec cet email existe déjà")
      }

      for (const candidate of phoneVariants(canonicalPhone)) {
        const existingPhone = await findUserByPhone(connection, candidate)
        if (existingPhone) {
          throw createError(409, "Un utilisateur avec ce numéro existe déjà")
        }
      }

      const user = await createUser(connection, {
        id: userId,
        firstName,
        lastName,
        email: normalizedEmail,
        passwordHash,
        phone: canonicalPhone,
        profilePicture: "",
        isEmailVerified: false,
      })

      if (requestedRole === "driver") {
        // Defer full driver profile creation until after email verification and complete-profile
        // ensure Participant row exists so later driver creation can reference it
        await ensureParticipant(connection, userId)
      } else {
        await createRequesterProfile(connection, userId)
      }

      await createUserToken(connection, {
        id: crypto.randomUUID(),
        userId,
        type: "EMAIL_VERIFICATION",
        tokenHash: verificationTokenHash,
        expiresAt: verificationExpiresAt,
      })

      return user
    })

    let emailSent = false
    try {
      const codeSent = await sendVerificationEmail(createdUser.email, verificationCode)
      if (!codeSent) {
        console.warn("Registration verification email was not delivered, continuing with auto-login flow")
      } else {
        emailSent = true
      }
    } catch (emailError) {
      console.error("Registration email send failed", emailError?.message || emailError)
    }

    const token = signJwt({
      userId,
      role: requestedRole,
      tokenVersion: createdUser.tokenVersion,
    })

    const responseData = {
      token,
      user: {
        ...sanitizeUser(createdUser),
        role: requestedRole,
      },
    }

    // DEV MODE: return OTP code so Flutter can display it
    if (process.env.NODE_ENV !== 'production') {
      responseData._dev = {
        otp: verificationCode,
        emailSent,
      }
    }

    return sendSuccess(
      res,
      201,
      "Registration successful",
      responseData,
    )
  } catch (error) {
    console.error("register failed", error?.message || error)
    const mapped = mapMySqlError(error)
    next(mapped || error)
  }
}

export const login = async (req, res, next) => {
  try {
    const { identifier, email, phone, password } = req.body
    const rawIdentifier = identifier ?? email ?? phone
    const normalizedIdentifier = String(rawIdentifier || "").trim()
    const requestedIdentifier = normalizedIdentifier.toLowerCase()

    if (!normalizedIdentifier || !password) {
      return next(createError(400, "All fields are required"))
    }

    let lookupUser = null

    if (isEmailLike(normalizedIdentifier)) {
      lookupUser = await findUserByEmail(null, normalizeEmail(normalizedIdentifier), { includePassword: true })
    } else {
      for (const candidate of phoneVariants(normalizedIdentifier)) {
        lookupUser = await findUserByPhone(null, candidate, { includePassword: true })
        if (lookupUser) {
          break
        }
      }
    }

    if (!lookupUser) {
      return next(createError(401, "Invalid email or password"))
    }

    if (!lookupUser.isEmailVerified) {
      return next(createError(403, "Please verify your email before logging in"))
    }

    if (lookupUser.isBlocked) {
      return next(createError(403, "This account is blocked"))
    }

    if (lookupUser.isSuspended) {
      return next(createError(403, "This account is suspended"))
    }

    const isPasswordValid = await bcrypt.compare(String(password), lookupUser.passwordHash)
    if (!isPasswordValid) {
      return next(createError(401, "Invalid email or password"))
    }

    const role = await getUserRole(null, lookupUser.id)
    const driverInfo = role === "driver" ? await findDriverByUserId(null, lookupUser.id) : null
    const driverStatus = driverInfo?.reviewStatus || (driverInfo?.isDocumentsVerified ? "approved" : null)
    const token = signJwt({
      userId: lookupUser.id,
      role,
      tokenVersion: lookupUser.tokenVersion,
    })

    const accountActive = !lookupUser.isBlocked && !lookupUser.isSuspended

    if (role === "driver") {
      console.log(`[Login] Driver login userId=${lookupUser.id}`)
      console.log(`  verificationStatus= ${driverInfo?.reviewStatus}`)
      console.log(`  approvalWelcomeShown= ${!!driverInfo?.approvalWelcomeShown}`)
      console.log(`  isDocumentsVerified= ${!!driverInfo?.isDocumentsVerified}`)
      console.log(`  accountActive= ${accountActive}`)
      console.log(`  Decision: ${
        driverInfo?.reviewStatus === "approved" && !!driverInfo?.isDocumentsVerified && accountActive
          ? !!driverInfo?.approvalWelcomeShown ? "Go Dashboard" : "Show Welcome"
          : driverInfo?.reviewStatus === "rejected" ? "Go Rejected Screen"
          : driverInfo?.reviewStatus === "blocked" ? "Go Blocked Screen"
          : "Go Pending Screen"
      }`)
    }

    return sendSuccess(res, 200, "Login successful", {
      token,
      user: {
        ...sanitizeUser(lookupUser),
        role,
        ...(role === "driver"
          ? {
              driverStatus,
              driverReviewReason: driverInfo?.reviewReason || null,
              driverApprovedBy: driverInfo?.reviewedBy || null,
              driverApprovedAt: driverInfo?.reviewedAt || null,
              driverIsVerified: driverStatus === "approved" && !!driverInfo?.isDocumentsVerified,
              approvalWelcomeShown: !!driverInfo?.approvalWelcomeShown,
              isDocumentsVerified: !!driverInfo?.isDocumentsVerified,
              accountActive,
            }
          : {}),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const verifyEmail = async (req, res, next) => {
  try {
    const { email, code } = req.body
    const normalizedEmail = normalizeEmail(email)
    const cleanCode = String(code || "").trim()
    const tokenHash = hashToken(cleanCode)

    const user = await findUserByEmail(null, normalizedEmail)
    if (!user) {
      return next(createError(404, "EMAIL_NOT_FOUND"))
    }

    const consumed = await withTransaction(async (connection) => {
      const token = await consumeUserToken(connection, {
        type: "EMAIL_VERIFICATION",
        tokenHash,
      })

      if (!token || token.userId !== user.id) {
        return null
      }

      await updateUserEmailVerified(connection, user.id, true)
      return token
    })

    if (!consumed) {
      return next(createError(400, "Invalid or expired verification code"))
    }

    return sendSuccess(res, 200, "Email verified successfully")
  } catch (error) {
    console.error("verifyEmail failed", error?.message || error)
    next(error)
  }
}

export const resendVerificationEmail = async (req, res, next) => {
  try {
    const { email } = req.body
    const normalizedEmail = normalizeEmail(email)

    if (!normalizedEmail) {
      return next(createError(400, "EMAIL_REQUIRED"))
    }

    const user = await findUserByEmail(null, normalizedEmail)
    if (!user) {
      return next(createError(404, "EMAIL_NOT_FOUND"))
    }

    if (user.isEmailVerified) {
      return sendSuccess(res, 200, "Email already verified")
    }

    const verificationCode = buildVerificationCode()
    const verificationExpiresAt = Date.now() + 15 * 60 * 1000
    const verificationTokenHash = hashToken(verificationCode)

    await createUserToken(null, {
      id: crypto.randomUUID(),
      userId: user.id,
      type: "EMAIL_VERIFICATION",
      tokenHash: verificationTokenHash,
      expiresAt: verificationExpiresAt,
    })

    let emailSent = false
    try {
      const codeSent = await sendVerificationEmail(user.email, verificationCode)
      if (codeSent) {
        emailSent = true
      } else {
        console.error("resendVerificationEmail failed")
        return next(createError(503, "Unable to send verification code. Please try again later."))
      }
    } catch (emailError) {
      console.error("resendVerificationEmail send error", emailError?.message || emailError)
      if (process.env.NODE_ENV === 'production') {
        return next(createError(503, "Unable to send verification code. Please try again later."))
      }
    }

    const responseData = { message: "Verification code sent" }

    // DEV MODE: return OTP code so Flutter can display it
    if (process.env.NODE_ENV !== 'production') {
      responseData._dev = {
        otp: verificationCode,
        emailSent,
      }
    }

    return sendSuccess(res, 200, "Verification code sent", responseData)
  } catch (error) {
    const mapped = mapMySqlError(error)
    next(mapped || error)
  }
}

export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body
    const normalizedEmail = normalizeEmail(email)

    if (!normalizedEmail) {
      return next(createError(400, "EMAIL_REQUIRED"))
    }

    const user = await findUserByEmail(null, normalizedEmail)
    if (!user) {
      return next(createError(404, "EMAIL_NOT_FOUND"))
    }

    const rawToken = crypto.randomBytes(32).toString("hex")
    const tokenHash = hashToken(rawToken)
    const expiresAt = Date.now() + 60 * 60 * 1000

    await createUserToken(null, {
      id: crypto.randomUUID(),
      userId: user.id,
      type: "PASSWORD_RESET",
      tokenHash,
      expiresAt,
    })

    const sent = await sendPasswordResetEmail(user.email, rawToken)
    if (!sent) {
      return next(createError(503, "Unable to send password reset email. Please retry."))
    }

    return sendSuccess(res, 200, "Password reset email sent")
  } catch (error) {
    const mapped = mapMySqlError(error)
    next(mapped || error)
  }
}

export const resetPassword = async (req, res, next) => {
  try {
    const token = String(req.params.token || "").trim()
    const { password } = req.body

    if (!token) {
      return next(createError(400, "Token invalide"))
    }

    const passwordHash = await bcrypt.hash(String(password), 10)
    const tokenHash = hashToken(token)

    const consumed = await withTransaction(async (connection) => {
      const consumedToken = await consumeUserToken(connection, {
        type: "PASSWORD_RESET",
        tokenHash,
      })

      if (!consumedToken) {
        return null
      }

      await updateUserPassword(connection, consumedToken.userId, passwordHash)
      return consumedToken
    })

    if (!consumed) {
      return next(createError(400, "Token invalide"))
    }

    return sendSuccess(res, 200, "Password reset successfully")
  } catch (error) {
    next(error)
  }
}

export const getCurrentUser = async (req, res, next) => {
  try {
    if (!req.user) {
      return next(createError(401, "Authentication required"))
    }

    const userId = req.user.id
    const role = req.user.role || (await getUserRole(null, userId))

    let driverStatus = null
    let driverInfo = null
    let verification = null
    if (role === "driver") {
      driverInfo = await findDriverByUserId(null, userId)
      if (driverInfo) {
        driverStatus = driverInfo.reviewStatus || (driverInfo.isDocumentsVerified ? "approved" : "pending")
        const docs = await findDriverDocumentsByDriverId(null, userId)
        const totalDocuments = Array.isArray(docs) ? docs.length : 0
        const verifiedDocuments = Array.isArray(docs)
          ? docs.filter((doc) => !!doc.isVerified).length
          : 0

        verification = {
          reviewStatus: driverStatus,
          isDocumentsVerified: !!driverInfo.isDocumentsVerified,
          needsResubmission: driverStatus === "rejected",
          reviewReason: driverInfo.reviewReason || null,
          reviewedBy: driverInfo.reviewedBy || null,
          reviewedAt: driverInfo.reviewedAt || null,
           approvedBy: driverInfo.reviewedBy || null,
           approvedAt: driverInfo.reviewedAt || null,
          documents: {
            total: totalDocuments,
            verified: verifiedDocuments,
            pending: Math.max(0, totalDocuments - verifiedDocuments),
            rejected: Array.isArray(docs) ? docs.filter((doc) => doc.reviewStatus === "rejected").length : 0,
            latest: Array.isArray(docs)
              ? docs.slice(0, 10).map((doc) => ({
                  id: doc.id,
                  type: doc.type,
                  isVerified: !!doc.isVerified,
                  reviewStatus: doc.reviewStatus || (doc.isVerified ? "approved" : "pending"),
                  reviewReason: doc.reviewReason || null,
                  reviewedBy: doc.reviewedBy || null,
                  reviewedAt: doc.reviewedAt || null,
                  createdAt: doc.created_at || null,
                }))
              : [],
          },
        }
      }
    }

    const accountActive = role === "driver"
      ? !req.user?.isBlocked && !req.user?.isSuspended
      : true

    if (role === "driver") {
      console.log(`[GetCurrentUser] Driver userId=${userId}`)
      console.log(`  verificationStatus= ${driverInfo?.reviewStatus}`)
      console.log(`  approvalWelcomeShown= ${!!driverInfo?.approvalWelcomeShown}`)
      console.log(`  isDocumentsVerified= ${!!driverInfo?.isDocumentsVerified}`)
      console.log(`  accountActive= ${accountActive}`)
    }

    return sendSuccess(res, 200, "Current user fetched successfully", {
      user: {
        ...req.user,
        role,
        driverStatus,
        driverReviewReason: role === "driver" ? driverInfo?.reviewReason || null : null,
        driverIsVerified: role === "driver" ? driverStatus === "approved" : null,
        driverApprovedBy: role === "driver" ? driverInfo?.reviewedBy || null : null,
        driverApprovedAt: role === "driver" ? driverInfo?.reviewedAt || null : null,
        approvalWelcomeShown: role === "driver" ? !!driverInfo?.approvalWelcomeShown : null,
        isDocumentsVerified: role === "driver" ? !!driverInfo?.isDocumentsVerified : null,
        accountActive,
        verification,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const completeProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) return next(createError(401, "Authentication required"))

    const role = req.user.role || (await getUserRole(null, userId))
    const requestedAccountType = String(req.body.accountType || "").trim().toLowerCase()
    const hasDriverPayload =
      (requestedAccountType && requestedAccountType !== "client") ||
      Boolean(
        req.body.licenseNumber ||
        req.body.licenseExpiry ||
        req.body.idCard ||
        req.body.vehicle ||
        req.body.vehicleType ||
        req.body.vehicleMake ||
        req.body.vehicleModel ||
        req.body.vehicleYear ||
        req.body.vehicleColor ||
        req.body.vehicleLicensePlate ||
        req.body.vehicleInsuranceNumber ||
        req.body.vehicleInsuranceExpiry ||
        (Array.isArray(req.body.documents) && req.body.documents.length > 0),
      )

    if (role === "client") {
      const normalizedNames = normalizeProfileNamePair(req.body.firstName, req.body.lastName)
      await updateUserProfile(null, userId, {
        firstName: normalizedNames.firstName,
        lastName: normalizedNames.lastName,
        phone: req.body.phone !== undefined ? toAlgeriaE164(req.body.phone) : undefined,
        profilePicture: req.body.profilePicture,
        city: req.body.city,
        address: req.body.address,
        isOnboarded: true,
      })

      const updated = await findUserById(null, userId)
      const newRole = await getUserRole(null, userId)
      return sendSuccess(res, 200, "Profile completed", {
        user: {
          ...sanitizeUser(updated),
          role: newRole,
        },
      })
    }

    if (role === "driver" || hasDriverPayload) {
      const {
        licenseNumber,
        licenseExpiry,
        idCard,
        vehicle,
        documents,
      } = req.body
      if (process.env.NODE_ENV !== 'production') {
        console.log("completeProfile driver payload:", JSON.stringify({
          licenseNumber,
          licenseExpiry,
          idCard,
          documentsCount: Array.isArray(documents) ? documents.length : 0,
        }))
      }

      // ── Validate vehicle type against driver type ──
      const rawVehicleType = (vehicle?.type || req.body.vehicleType || '').trim().toLowerCase()
      const driverAccountType = req.body.driverType || 'normal_driver'
      let validatedVehicle = null
      if (rawVehicleType) {
        const { validateVehicleType } = await import('../vehicle_capacities.js')
        const validation = validateVehicleType(rawVehicleType, driverAccountType)
        if (!validation.valid) {
          return next(createError(400, validation.error))
        }
        validatedVehicle = validation.vehicle
      }

      const vehiclePayload = vehicle || {
        type: rawVehicleType || null,
        make: req.body.vehicleMake ?? null,
        model: req.body.vehicleModel ?? null,
        year: req.body.vehicleYear ?? null,
        color: req.body.vehicleColor ?? null,
        licensePlate: req.body.vehicleLicensePlate ?? null,
        insuranceNumber: req.body.vehicleInsuranceNumber ?? null,
        insuranceExpiry: req.body.vehicleInsuranceExpiry ?? null,
      }

      const result = await withTransaction(async (connection) => {
        await ensureParticipant(connection, userId)

        const existingDriver = await findDriverByUserId(connection, userId)
        if (!existingDriver) {
          await createDriverProfile(connection, {
            userId,
            licenseNumber: licenseNumber ?? null,
            licenseExpiry: licenseExpiry ? toSqlDateTime(licenseExpiry)?.slice(0, 10) : null,
            idCard: idCard ?? null,
            isDocumentsVerified: false,
            isAvailable: false,
          })
        }

        // Store vehicle type and auto-computed capacities on Drivers
        if (validatedVehicle) {
          const maxVolumeM3 = validatedVehicle.maxVolumeL ? validatedVehicle.maxVolumeL / 1000 : null
          const { updateDriverVehicleType } = await import('../models/driver.model.js')
          await updateDriverVehicleType(connection, {
            driverId: userId,
            vehicleType: validatedVehicle.id,
            maxWeightKg: validatedVehicle.maxWeightKg,
            maxVolumeM3,
            maxSizeCategory: validatedVehicle.maxSizeLabel,
          })
        }

        if (vehiclePayload) {
          await createVehicle(connection, {
            id: crypto.randomUUID(),
            driverId: userId,
            type: rawVehicleType || null,
            make: vehiclePayload.make ?? null,
            model: vehiclePayload.model ?? null,
            year: vehiclePayload.year != null ? (Number(vehiclePayload.year) || null) : null,
            color: vehiclePayload.color ?? null,
            licensePlate: vehiclePayload.licensePlate ?? null,
            insuranceNumber: vehiclePayload.insuranceNumber ?? null,
            insuranceExpiry: vehiclePayload.insuranceExpiry != null
                ? (toSqlDateTime(vehiclePayload.insuranceExpiry)?.slice(0, 10) ?? null)
                : null,
            isVerified: false,
          })
        }

        if (Array.isArray(documents)) {
          const VALID_DOC_TYPES = ["ID_CARD", "LICENSE", "INSURANCE", "VEHICLE_REG", "RC"]
          for (const doc of documents) {
            if (!doc || !doc.url) continue
            const docType = doc.type || "ID_CARD"
            if (!VALID_DOC_TYPES.includes(docType)) {
              throw createError(400, `Invalid document type: "${docType}". Must be one of: ${VALID_DOC_TYPES.join(", ")}`)
            }
            await createDriverDocument(connection, {
              id: crypto.randomUUID(),
              driverId: userId,
              type: docType,
              url: doc.url,
              expiryDate: doc.expiryDate || null,
              isVerified: false,
            })
          }
        }

        // update user basic fields and mark onboarded
        await updateUserProfile(connection, userId, {
          ...normalizeProfileNamePair(req.body.firstName, req.body.lastName),
          phone: req.body.phone !== undefined ? toAlgeriaE164(req.body.phone) : undefined,
          profilePicture: req.body.profilePicture,
          city: req.body.city,
          address: req.body.address,
          isOnboarded: true,
        })

        return true
      })

      if (!result) return next(createError(500, "Unable to complete driver profile"))

      const updated = await findUserById(null, userId)
      const newRole = await getUserRole(null, userId)
      const driverInfo = await findDriverByUserId(null, userId)

      if (process.env.NODE_ENV !== 'production') {
        console.log('DRIVER SUBMITTED')
        console.log('USERID  =', userId)
        console.log('STATUS  =', driverInfo?.reviewStatus || 'pending')
        console.log('DOCS    =', Array.isArray(req.body.documents) ? `${req.body.documents.length} file(s)` : '0')
      }

      await addDriverVerificationTimelineEvent(null, {
        driverId: userId,
        eventType: "driver_review_updated",
        entityType: "driver",
        entityId: userId,
        status: driverInfo?.reviewStatus || "pending",
        actorId: userId,
        reason: null,
        metadata: {
          source: "complete_profile",
        },
      })

      return sendSuccess(res, 200, "Driver profile submitted for review", {
        user: {
          ...sanitizeUser(updated),
          role: newRole,
          driverStatus: driverInfo?.reviewStatus || (driverInfo ? "pending" : null),
        },
      })
    }

    return next(createError(400, "Unsupported role for complete-profile"))
  } catch (error) {
    const mapped = mapMySqlError(error)
    next(mapped || error)
  }
}

export const updateProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return next(createError(401, "Authentication required"))
    }

    await updateUserProfile(null, userId, {
      phone: req.body.phone !== undefined ? toAlgeriaE164(req.body.phone) : undefined,
      profilePicture: req.body.profilePicture,
    })

    const updated = await findUserById(null, userId)
    const role = await getUserRole(null, userId)

    return sendSuccess(res, 200, "Profile updated successfully", {
      user: {
        ...sanitizeUser(updated),
        role,
      },
    })
  } catch (error) {
    const mapped = mapMySqlError(error)
    next(mapped || error)
  }
}

export const updateProfilePicture = async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return next(createError(401, "Authentication required"))
    }

    if (!req.file) {
      return next(createError(400, "No image file provided"))
    }

    const currentUser = await findUserById(null, userId)
    if (!currentUser) {
      return next(createError(404, "User not found"))
    }

    const fallbackRelativePath = path.posix.join("uploads", path.basename(req.file.path || ""))
    const imageRelativePath = req.uploadRelativePath || fallbackRelativePath
    const imageUrl = buildPublicUploadUrl(req, imageRelativePath)
    const previousProfilePicture = currentUser.profilePicture || ""

    try {
      await updateUserProfile(null, userId, {
        profilePicture: imageUrl,
      })
    } catch (error) {
      await deleteLocalUploadFile(imageUrl).catch(() => {})
      const mapped = mapMySqlError(error)
      return next(mapped || error)
    }

    if (previousProfilePicture && previousProfilePicture !== imageUrl) {
      await deleteLocalUploadFile(previousProfilePicture).catch(() => {})
    }

    const updated = await findUserById(null, userId)
    const role = await getUserRole(null, userId)

    return sendSuccess(res, 200, "Profile picture updated successfully", {
      imageUrl,
      user: {
        ...sanitizeUser(updated),
        role,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const removeProfilePicture = async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return next(createError(401, "Authentication required"))
    }

    const currentUser = await findUserById(null, userId)
    if (!currentUser) {
      return next(createError(404, "User not found"))
    }

    const previousProfilePicture = currentUser.profilePicture || ""
    await updateUserProfile(null, userId, {
      profilePicture: null,
    })

    if (previousProfilePicture) {
      await deleteLocalUploadFile(previousProfilePicture).catch(() => {})
    }

    const updated = await findUserById(null, userId)
    const role = await getUserRole(null, userId)

    return sendSuccess(res, 200, "Profile picture removed successfully", {
      user: {
        ...sanitizeUser(updated),
        role,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const changePassword = async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return next(createError(401, "Authentication required"))
    }

    const { currentPassword, newPassword } = req.body

    const user = await findUserById(null, userId, { includePassword: true })
    if (!user) {
      return next(createError(404, "User not found"))
    }

    const passwordOk = await bcrypt.compare(String(currentPassword), user.passwordHash)
    if (!passwordOk) {
      return next(createError(401, "Invalid current password"))
    }

    const nextHash = await bcrypt.hash(String(newPassword), 10)
    await updateUserPassword(null, userId, nextHash)

    return sendSuccess(res, 200, "Password changed successfully")
  } catch (error) {
    next(error)
  }
}

export const logout = async (_req, res, next) => {
  try {
    return sendSuccess(res, 200, "Logged out successfully")
  } catch (error) {
    next(error)
  }
}

export const getDriverVerificationTimeline = async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return next(createError(401, "Authentication required"))
    }

    if (req.user.role !== "driver") {
      return next(createError(403, "Only drivers can access verification timeline"))
    }

    const driver = await findDriverByUserId(null, userId)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200)
    const offset = parseInt(req.query.offset, 10) || 0

    const timeline = await listDriverVerificationTimeline(null, userId, {
      limit,
      offset,
    })

    return sendSuccess(res, 200, "Driver verification timeline fetched successfully", {
      driverId: userId,
      reviewStatus: driver.reviewStatus || (driver.isDocumentsVerified ? "approved" : "pending"),
      reviewReason: driver.reviewReason || null,
      timeline,
      pagination: {
        limit,
        offset,
      },
    })
  } catch (error) {
    next(error)
  }
}
