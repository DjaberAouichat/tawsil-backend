import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import PDFDocument from "pdfkit"
import { findDeliveryById } from "../models/delivery.model.js"
import { findTripById } from "../models/trip.model.js"
import { execute } from "../lib/db.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const VALUE_NOT_AVAILABLE = "غير متوفر"
const DRIVER_NOT_ASSIGNED = "غير معين بعد"

const COLORS = {
  page: "#FFFDFC",
  panel: "#FFFFFF",
  border: "#E7E5E4",
  accent: "#F97316",
  accentSoft: "#FFF4EA",
  accentText: "#9A3412",
  text: "#111827",
  subtle: "#6B7280",
}

const DELIVERY_STATUS_AR = {
  Draft: "مسودة",
  Pending: "قيد الانتظار",
  Accepted: "مقبولة",
  DriverArrivedPickup: "السائق وصل لنقطة الاستلام",
  PickedUp: "تم الاستلام",
  InTransit: "في الطريق",
  ArrivedDropoff: "وصل لنقطة التسليم",
  Delivered: "تم التسليم",
  CancelledByUser: "ألغيت من العميل",
  CancelledByDriver: "ألغيت من السائق",
  Rejected: "مرفوضة",
  FailedDelivery: "فشل التسليم",
  Refunded: "تم الاسترجاع",
}

const TRIP_STATUS_AR = {
  planned: "مجدولة",
  active: "نشطة",
  completed: "مكتملة",
  cancelled: "ملغاة",
}

const PAYMENT_METHOD_AR = {
  card: "بطاقة",
  cash: "نقدا",
  paypal: "باي بال",
}

const PAYMENT_STATUS_AR = {
  pending: "قيد المعالجة",
  completed: "مكتمل",
  failed: "فشل",
  refunded: "مسترجع",
  cash_pending: "بانتظار الدفع النقدي",
  cash_received: "تم استلام النقد",
}

const PACKAGE_SIZE_AR = {
  small: "صغير",
  medium: "متوسط",
  large: "كبير",
  xlarge: "كبير جدا",
}

const VEHICLE_TYPE_AR = {
  standard: "عادية",
  comfort: "مريحة",
  premium: "فاخرة",
  van: "فان",
}

const REGULAR_FONT_CANDIDATES = [
  process.env.PDF_ARABIC_FONT_PATH,
  path.join(__dirname, "../assets/fonts/NotoNaskhArabic-Regular.ttf"),
  "C:/Windows/Fonts/tahoma.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "C:/Windows/Fonts/segoeui.ttf",
  "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
].filter(Boolean)

const BOLD_FONT_CANDIDATES = [
  process.env.PDF_ARABIC_FONT_BOLD_PATH,
  path.join(__dirname, "../assets/fonts/NotoNaskhArabic-Bold.ttf"),
  "C:/Windows/Fonts/tahomabd.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/seguisb.ttf",
  "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
].filter(Boolean)

const resolveExistingPath = (candidates) => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

const configureDocumentFonts = (doc) => {
  const regularPath = resolveExistingPath(REGULAR_FONT_CANDIDATES)
  const boldPath = resolveExistingPath(BOLD_FONT_CANDIDATES)

  let regularFontName = "Helvetica"
  let boldFontName = "Helvetica-Bold"

  if (regularPath) {
    regularFontName = "ArabicRegular"
    doc.registerFont(regularFontName, regularPath)
  }

  if (boldPath) {
    boldFontName = "ArabicBold"
    doc.registerFont(boldFontName, boldPath)
  } else if (regularPath) {
    boldFontName = regularFontName
  }

  return { regularFontName, boldFontName }
}

const safeString = (value, fallback = VALUE_NOT_AVAILABLE) => {
  if (value === null || value === undefined) {
    return fallback
  }

  const normalized = String(value).trim()
  return normalized.length > 0 ? normalized : fallback
}

const translate = (dictionary, value, fallback = VALUE_NOT_AVAILABLE) => {
  const key = safeString(value, "")
  if (!key) {
    return fallback
  }

  return dictionary[key] || key
}

const formatDateTime = (value) => {
  if (!value) {
    return VALUE_NOT_AVAILABLE
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return VALUE_NOT_AVAILABLE
  }

  return date.toLocaleString("ar-DZ-u-nu-latn", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

const formatCoordinates = (coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    return VALUE_NOT_AVAILABLE
  }

  const lng = Number(coordinates[0])
  const lat = Number(coordinates[1])

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return VALUE_NOT_AVAILABLE
  }

  return `${lat.toFixed(6)}، ${lng.toFixed(6)}`
}

const formatMoney = (amount, currency = "DZD") => {
  if (amount === null || amount === undefined || amount === "") {
    return VALUE_NOT_AVAILABLE
  }

  const numericAmount = Number(amount)
  if (!Number.isFinite(numericAmount)) {
    return VALUE_NOT_AVAILABLE
  }

  return `${numericAmount.toFixed(2)} ${safeString(currency, "DZD")}`
}

const formatRating = (value) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return VALUE_NOT_AVAILABLE
  }

  return `${numeric.toFixed(1)} / 5`
}

const getFullName = (userLike) => {
  if (!userLike) {
    return VALUE_NOT_AVAILABLE
  }

  const firstName = safeString(userLike.firstName, "")
  const lastName = safeString(userLike.lastName, "")
  const fullName = `${firstName} ${lastName}`.trim()

  return fullName || VALUE_NOT_AVAILABLE
}

const getInnerWidth = (doc) => {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right
}

const ensureVerticalSpace = (doc, required = 40) => {
  const limit = doc.page.height - doc.page.margins.bottom - required
  if (doc.y > limit) {
    doc.addPage()
  }
}

const drawPageHeader = (doc, fonts, { title, subtitle, refLabel }) => {
  const left = doc.page.margins.left
  const width = getInnerWidth(doc)
  const top = doc.page.margins.top - 16

  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.page)

  doc.save()
  doc.roundedRect(left, top, width, 92, 14).fill(COLORS.accentSoft)
  doc.roundedRect(left, top, 9, 92, 5).fill(COLORS.accent)

  doc.fillColor(COLORS.text)
  doc.font(fonts.boldFontName).fontSize(20).text(title, left + 18, top + 14, {
    width: width - 28,
    align: "right",
  })

  doc.font(fonts.regularFontName).fontSize(10).fillColor(COLORS.subtle).text(subtitle, left + 18, top + 45, {
    width: width - 28,
    align: "right",
  })

  if (refLabel) {
    doc.font(fonts.boldFontName).fontSize(10).fillColor(COLORS.accentText).text(refLabel, left + 18, top + 64, {
      width: width - 28,
      align: "right",
    })
  }

  doc.restore()
  doc.y = top + 104
}

const writeSectionTitle = (doc, fonts, title) => {
  ensureVerticalSpace(doc, 54)

  const left = doc.page.margins.left
  const width = getInnerWidth(doc)
  const y = doc.y + 3

  doc.roundedRect(left, y, width, 26, 8).fill(COLORS.accentSoft)
  doc.font(fonts.boldFontName).fontSize(12).fillColor(COLORS.accentText).text(title, left + 12, y + 7, {
    width: width - 24,
    align: "right",
  })

  doc.y = y + 32
}

const writeField = (doc, fonts, label, value) => {
  ensureVerticalSpace(doc, 34)

  const left = doc.page.margins.left
  const width = getInnerWidth(doc)
  const rowY = doc.y

  const labelWidth = 190
  const valueWidth = width - labelWidth - 26
  const valueText = safeString(value)

  const valueHeight = doc.heightOfString(valueText, { width: valueWidth, align: "right" })
  const labelHeight = doc.heightOfString(label, { width: labelWidth, align: "right" })
  const rowHeight = Math.max(30, valueHeight + 12, labelHeight + 12)

  doc.roundedRect(left, rowY, width, rowHeight, 7).fillAndStroke(COLORS.panel, COLORS.border)

  doc.font(fonts.boldFontName).fontSize(10).fillColor(COLORS.accentText).text(label, left + width - labelWidth - 10, rowY + 6, {
    width: labelWidth,
    align: "right",
  })

  doc.font(fonts.regularFontName).fontSize(10).fillColor(COLORS.text).text(valueText, left + 12, rowY + 6, {
    width: valueWidth,
    align: "right",
  })

  doc.y = rowY + rowHeight + 6
}

const writeClientSignatureBlock = (doc, fonts, clientName) => {
  ensureVerticalSpace(doc, 190)
  writeSectionTitle(doc, fonts, "اعتماد العميل")

  writeField(doc, fonts, "اسم العميل", clientName)
  writeField(doc, fonts, "تاريخ التوقيع", "____ / ____ / ______")

  ensureVerticalSpace(doc, 95)

  const left = doc.page.margins.left
  const width = getInnerWidth(doc)
  const boxY = doc.y
  const boxHeight = 78

  doc.roundedRect(left, boxY, width, boxHeight, 8).fillAndStroke(COLORS.panel, COLORS.border)
  doc.font(fonts.boldFontName).fontSize(10).fillColor(COLORS.accentText).text("توقيع العميل", left + 12, boxY + 10, {
    width: width - 24,
    align: "right",
  })

  const lineY = boxY + boxHeight - 20
  doc.moveTo(left + 24, lineY)
    .lineTo(left + width - 24, lineY)
    .lineWidth(1)
    .strokeColor("#9CA3AF")
    .stroke()

  doc.y = boxY + boxHeight + 8
}

const writeFooter = (doc, fonts) => {
  ensureVerticalSpace(doc, 80)

  const left = doc.page.margins.left
  const width = getInnerWidth(doc)
  const y = doc.y + 4

  doc.moveTo(left, y)
    .lineTo(left + width, y)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke()

  doc.font(fonts.regularFontName).fontSize(9).fillColor(COLORS.subtle).text(
    "نسخة مطبوعة مخصصة للأرشفة والمتابعة الداخلية.",
    left,
    y + 8,
    {
      width,
      align: "right",
    },
  )

  doc.y = y + 26
}

const createPdfBuffer = async (renderDocument) => {
  const doc = new PDFDocument({ size: "A4", margin: 48 })
  const chunks = []
  const fonts = configureDocumentFonts(doc)

  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    try {
      renderDocument(doc, fonts)
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

const renderDeliveryDocument = (doc, payload, fonts) => {
  drawPageHeader(doc, fonts, {
    title: "استمارة طباعة التوصيلة",
    subtitle: `تم الإنشاء: ${formatDateTime(payload.generatedAt)}`,
    refLabel: `رقم الطلب: ${payload.delivery.id}`,
  })

  writeSectionTitle(doc, fonts, "معلومات التوصيلة")
  writeField(doc, fonts, "رقم الطلب", payload.delivery.id)
  writeField(doc, fonts, "تاريخ الإنشاء", payload.delivery.createdAt)
  writeField(doc, fonts, "الحالة", payload.delivery.status)
  writeField(doc, fonts, "طلب مستعجل", payload.delivery.isUrgent ? "نعم" : "لا")

  writeSectionTitle(doc, fonts, "بيانات الزبون (المرسل)")
  writeField(doc, fonts, "الاسم الكامل", payload.sender.fullName)
  writeField(doc, fonts, "رقم الهاتف", payload.sender.phone)
  writeField(doc, fonts, "البريد الإلكتروني", payload.sender.email)

  writeSectionTitle(doc, fonts, "بيانات المستلم")
  writeField(doc, fonts, "اسم المستلم", payload.recipient.name)
  writeField(doc, fonts, "هاتف المستلم", payload.recipient.phone)

  writeSectionTitle(doc, fonts, "بيانات السائق")
  if (!payload.driver.assigned) {
    writeField(doc, fonts, "السائق", DRIVER_NOT_ASSIGNED)
  } else {
    writeField(doc, fonts, "الاسم", payload.driver.fullName)
    writeField(doc, fonts, "الهاتف", payload.driver.phone)
    writeField(doc, fonts, "التقييم", payload.driver.rating)
    writeField(doc, fonts, "نوع المركبة", payload.driver.vehicleType)
    writeField(doc, fonts, "الماركة", payload.driver.vehicleMake)
    writeField(doc, fonts, "الموديل", payload.driver.vehicleModel)
    writeField(doc, fonts, "رقم اللوحة", payload.driver.vehiclePlate)
  }

  writeSectionTitle(doc, fonts, "بيانات الرحلة المرتبطة")
  if (!payload.trip.isAttached) {
    writeField(doc, fonts, "الرحلة", "لا توجد رحلة مرتبطة")
  } else {
    writeField(doc, fonts, "رقم الرحلة", payload.trip.id)
    writeField(doc, fonts, "عنوان الرحلة", payload.trip.title)
    writeField(doc, fonts, "حالة الرحلة", payload.trip.status)
    writeField(doc, fonts, "وقت الانطلاق", payload.trip.departureTime)
    writeField(doc, fonts, "وقت الوصول المتوقع", payload.trip.expectedArrivalTime)
    writeField(doc, fonts, "الانطلاق", payload.trip.originAddress)
    writeField(doc, fonts, "الوجهة", payload.trip.destinationAddress)
  }

  writeSectionTitle(doc, fonts, "نقطة الاستلام والتسليم")
  writeField(doc, fonts, "عنوان الاستلام", payload.pickup.address)
  writeField(doc, fonts, "إحداثيات الاستلام", payload.pickup.coordinates)
  writeField(doc, fonts, "عنوان التسليم", payload.dropoff.address)
  writeField(doc, fonts, "إحداثيات التسليم", payload.dropoff.coordinates)

  writeSectionTitle(doc, fonts, "تفاصيل الطرد")
  writeField(doc, fonts, "نوع الطرد", payload.package.type)
  writeField(doc, fonts, "الوصف", payload.package.description)
  writeField(doc, fonts, "الوزن (كغ)", payload.package.weightKg)
  writeField(doc, fonts, "الحجم", payload.package.sizeCategory)
  writeField(doc, fonts, "ملاحظة التوصيل", payload.package.deliveryNote)

  writeSectionTitle(doc, fonts, "التسعير والدفع")
  writeField(doc, fonts, "الرسوم الأساسية", payload.pricing.baseFee)
  writeField(doc, fonts, "رسوم المسافة", payload.pricing.distanceFee)
  writeField(doc, fonts, "رسوم الوزن", payload.pricing.weightSurcharge)
  writeField(doc, fonts, "رسوم الحجم", payload.pricing.sizeSurcharge)
  writeField(doc, fonts, "رسوم الاستعجال", payload.pricing.urgentSurcharge)
  writeField(doc, fonts, "السعر التقديري", payload.pricing.estimatedPrice)
  writeField(doc, fonts, "السعر النهائي", payload.pricing.finalPrice)
  writeField(doc, fonts, "العملة", payload.pricing.currency)
  writeField(doc, fonts, "طريقة الدفع", payload.payment.method)
  writeField(doc, fonts, "حالة الدفع", payload.payment.status)

  writeClientSignatureBlock(doc, fonts, payload.sender.fullName)
  writeFooter(doc, fonts)
}

const renderTripDocument = (doc, payload, fonts) => {
  drawPageHeader(doc, fonts, {
    title: "استمارة طباعة الرحلة",
    subtitle: `تم الإنشاء: ${formatDateTime(payload.generatedAt)}`,
    refLabel: `رقم الرحلة: ${payload.trip.id}`,
  })

  writeSectionTitle(doc, fonts, "معلومات الرحلة")
  writeField(doc, fonts, "رقم الرحلة", payload.trip.id)
  writeField(doc, fonts, "العنوان", payload.trip.title)
  writeField(doc, fonts, "الحالة", payload.trip.status)
  writeField(doc, fonts, "تاريخ الإنشاء", payload.trip.createdAt)
  writeField(doc, fonts, "وقت الانطلاق", payload.trip.departureTime)
  writeField(doc, fonts, "وقت الوصول المتوقع", payload.trip.expectedArrivalTime)
  writeField(doc, fonts, "الحد الأقصى للتوصيلات", payload.trip.maxDeliveries)
  writeField(doc, fonts, "السعة المتاحة", payload.trip.availableCapacity)
  writeField(doc, fonts, "عنوان الانطلاق", payload.trip.originAddress)
  writeField(doc, fonts, "إحداثيات الانطلاق", payload.trip.originCoordinates)
  writeField(doc, fonts, "عنوان الوجهة", payload.trip.destinationAddress)
  writeField(doc, fonts, "إحداثيات الوجهة", payload.trip.destinationCoordinates)
  writeField(doc, fonts, "ملاحظات", payload.trip.notes)

  writeSectionTitle(doc, fonts, "بيانات السائق")
  writeField(doc, fonts, "الاسم", payload.driver.fullName)
  writeField(doc, fonts, "الهاتف", payload.driver.phone)
  writeField(doc, fonts, "البريد الإلكتروني", payload.driver.email)
  writeField(doc, fonts, "التقييم", payload.driver.rating)
  writeField(doc, fonts, "نوع المركبة", payload.driver.vehicleType)
  writeField(doc, fonts, "الماركة", payload.driver.vehicleMake)
  writeField(doc, fonts, "الموديل", payload.driver.vehicleModel)
  writeField(doc, fonts, "رقم اللوحة", payload.driver.vehiclePlate)

  writeSectionTitle(doc, fonts, "التوصيلات المرتبطة")
  if (!payload.deliveries.length) {
    writeField(doc, fonts, "التوصيلات", "لا توجد توصيلات مرتبطة بهذه الرحلة")
  } else {
    payload.deliveries.forEach((delivery, index) => {
      writeSectionTitle(doc, fonts, `توصيلة رقم ${index + 1}`)
      writeField(doc, fonts, "رقم التوصيلة", delivery.id)
      writeField(doc, fonts, "الحالة", delivery.status)
      writeField(doc, fonts, "تاريخ الإنشاء", delivery.createdAt)
      writeField(doc, fonts, "اسم الزبون", delivery.customerName)
      writeField(doc, fonts, "هاتف الزبون", delivery.customerPhone)
      writeField(doc, fonts, "اسم المستلم", delivery.recipientName)
      writeField(doc, fonts, "هاتف المستلم", delivery.recipientPhone)
      writeField(doc, fonts, "عنوان الاستلام", delivery.pickupAddress)
      writeField(doc, fonts, "عنوان التسليم", delivery.dropoffAddress)
    })
  }

  writeFooter(doc, fonts)
}

export const loadDeliveryPrintContext = async (deliveryId) => {
  const delivery = await findDeliveryById(null, deliveryId, {
    includeDriver: true,
    includeRequester: true,
    includeTrip: true,
  })

  if (!delivery) {
    return null
  }

  if (delivery.assignedDriverId) {
    const vehicleRows = await execute(
      `SELECT make, model, license_plate, type FROM Vehicles WHERE driver_id = ? LIMIT 1`,
      [delivery.assignedDriverId],
    )
    const veh = vehicleRows[0] || null
    if (delivery.assignedDriver) {
      delivery.assignedDriver.vehicle = veh
        ? { make: veh.make, model: veh.model, licensePlate: veh.license_plate, type: veh.type || null }
        : null
    }
  }

  return {
    delivery,
    payload: prepareDeliveryPrintPayload(delivery),
  }
}

export const loadTripPrintContext = async (tripId) => {
  const trip = await findTripById(null, tripId, { includeDriver: true })

  if (!trip) {
    return null
  }

  if (trip.driverId) {
    const vehicleRows = await execute(
      `SELECT make, model, license_plate, type FROM Vehicles WHERE driver_id = ? LIMIT 1`,
      [trip.driverId],
    )
    const veh = vehicleRows[0] || null
    trip.driverVehicle = veh
      ? { make: veh.make, model: veh.model, licensePlate: veh.license_plate, type: veh.type || null }
      : null
  }

  const deliveryRows = await execute(
    `SELECT d.id, d.status, d.created_at, d.recipient_name, d.recipient_phone,
            u.first_name, u.last_name, u.phone AS sender_phone,
            pl.address AS pickup_address, dl.address AS dropoff_address
     FROM Deliveries d
     JOIN Users u ON u.id = d.requester_id
     LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'
     LEFT JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
     WHERE d.trip_id = ?
     ORDER BY d.created_at DESC`,
    [tripId],
  )

  const deliveries = deliveryRows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    sender: { firstName: row.first_name, lastName: row.last_name, phone: row.sender_phone },
    recipient: { name: row.recipient_name, phone: row.recipient_phone },
    pickup: { address: row.pickup_address || "" },
    dropoff: { address: row.dropoff_address || "" },
  }))

  return {
    trip,
    deliveries,
    payload: prepareTripPrintPayload(trip, deliveries),
  }
}

export const canAccessDeliveryPrint = ({ delivery, user }) => {
  const isAdminLike = user.role === "admin" || user.role === "authority"
  if (isAdminLike) {
    return true
  }

  if (delivery.senderId && String(delivery.senderId) === String(user.id)) {
    return true
  }

  if (delivery.assignedDriverId && String(delivery.assignedDriverId) === String(user.id)) {
    return true
  }

  return false
}

export const prepareDeliveryPrintPayload = (delivery) => {
  const sender = delivery.sender || null
  const assignedDriver = delivery.assignedDriver || null
  const driverUser = assignedDriver?.user || null
  const trip = delivery.trip || null

  return {
    generatedAt: new Date(),
    delivery: {
      id: safeString(delivery.id),
      createdAt: formatDateTime(delivery.createdAt),
      status: translate(DELIVERY_STATUS_AR, delivery.status),
      isUrgent: !!delivery.isUrgent,
    },
    sender: {
      fullName: getFullName(sender),
      phone: safeString(sender?.phone),
      email: safeString(sender?.email),
    },
    recipient: {
      name: safeString(delivery.recipient?.name),
      phone: safeString(delivery.recipient?.phone),
    },
    driver: assignedDriver
      ? {
          assigned: true,
          fullName: getFullName(driverUser),
          phone: safeString(driverUser?.phone),
          rating: formatRating(driverUser?.rating),
          vehicleType: translate(VEHICLE_TYPE_AR, assignedDriver?.vehicle?.type),
          vehicleMake: safeString(assignedDriver?.vehicle?.make),
          vehicleModel: safeString(assignedDriver?.vehicle?.model),
          vehiclePlate: safeString(assignedDriver?.vehicle?.licensePlate),
        }
      : {
          assigned: false,
          fullName: DRIVER_NOT_ASSIGNED,
        },
    trip: trip
      ? {
          isAttached: true,
          id: safeString(trip.id),
          title: safeString(trip.title, "بدون عنوان"),
          status: translate(TRIP_STATUS_AR, trip.status),
          departureTime: formatDateTime(trip.departureTime),
          expectedArrivalTime: formatDateTime(trip.expectedArrivalTime),
          originAddress: safeString(trip.origin?.address),
          destinationAddress: safeString(trip.destination?.address),
        }
      : {
          isAttached: false,
        },
    pickup: {
      address: safeString(delivery.pickup?.address),
      coordinates: formatCoordinates(delivery.pickup?.location?.coordinates),
    },
    dropoff: {
      address: safeString(delivery.dropoff?.address),
      coordinates: formatCoordinates(delivery.dropoff?.location?.coordinates),
    },
    package: {
      type: safeString(delivery.package?.type),
      description: safeString(delivery.package?.description),
      weightKg: safeString(delivery.package?.weightKg),
      sizeCategory: translate(PACKAGE_SIZE_AR, delivery.package?.sizeCategory),
      deliveryNote: safeString(delivery.deliveryNote, "لا توجد ملاحظة"),
    },
    pricing: {
      baseFee: formatMoney(delivery.pricing?.baseFee, delivery.pricing?.currency),
      distanceFee: formatMoney(delivery.pricing?.distanceFee, delivery.pricing?.currency),
      weightSurcharge: formatMoney(delivery.pricing?.weightSurcharge, delivery.pricing?.currency),
      sizeSurcharge: formatMoney(delivery.pricing?.sizeSurcharge, delivery.pricing?.currency),
      urgentSurcharge: formatMoney(delivery.pricing?.urgentSurcharge, delivery.pricing?.currency),
      estimatedPrice: formatMoney(delivery.pricing?.estimatedPrice, delivery.pricing?.currency),
      finalPrice: formatMoney(delivery.pricing?.finalPrice, delivery.pricing?.currency),
      currency: safeString(delivery.pricing?.currency, "DZD"),
    },
    payment: {
      method: translate(PAYMENT_METHOD_AR, delivery.payment?.method),
      status: translate(PAYMENT_STATUS_AR, delivery.payment?.status),
    },
  }
}

export const prepareTripPrintPayload = (trip, deliveries) => {
  const driver = trip.driver || null
  const vehicle = trip.driverVehicle || null

  return {
    generatedAt: new Date(),
    trip: {
      id: safeString(trip.id),
      title: safeString(trip.title, "بدون عنوان"),
      status: translate(TRIP_STATUS_AR, trip.status),
      createdAt: formatDateTime(trip.createdAt),
      departureTime: formatDateTime(trip.departureTime),
      expectedArrivalTime: formatDateTime(trip.expectedArrivalTime),
      maxDeliveries: safeString(trip.maxDeliveries),
      availableCapacity: safeString(trip.availableCapacity),
      originAddress: safeString(trip.origin?.address),
      originCoordinates: formatCoordinates(trip.origin?.location?.coordinates),
      destinationAddress: safeString(trip.destination?.address),
      destinationCoordinates: formatCoordinates(trip.destination?.location?.coordinates),
      notes: safeString(trip.notes, "لا توجد ملاحظات"),
    },
    driver: {
      fullName: getFullName(driver),
      phone: safeString(driver?.phone),
      email: safeString(driver?.email),
      rating: formatRating(driver?.rating),
      vehicleType: translate(VEHICLE_TYPE_AR, vehicle?.type),
      vehicleMake: safeString(vehicle?.make),
      vehicleModel: safeString(vehicle?.model),
      vehiclePlate: safeString(vehicle?.licensePlate),
    },
    deliveries: deliveries.map((delivery) => ({
      id: safeString(delivery.id),
      status: translate(DELIVERY_STATUS_AR, delivery.status),
      createdAt: formatDateTime(delivery.createdAt),
      customerName: getFullName(delivery.sender),
      customerPhone: safeString(delivery.sender?.phone),
      recipientName: safeString(delivery.recipient?.name),
      recipientPhone: safeString(delivery.recipient?.phone),
      pickupAddress: safeString(delivery.pickup?.address),
      dropoffAddress: safeString(delivery.dropoff?.address),
    })),
  }
}

export const generateDeliveryPdfBuffer = async (payload) => {
  return createPdfBuffer((doc, fonts) => renderDeliveryDocument(doc, payload, fonts))
}

export const generateTripPdfBuffer = async (payload) => {
  return createPdfBuffer((doc, fonts) => renderTripDocument(doc, payload, fonts))
}

export const sendPdfInline = (res, { fileName, buffer, statusCode = 200 }) => {
  const normalizedFileName = safeString(fileName, "document.pdf").replace(/[^a-zA-Z0-9._-]/g, "_")

  res.status(statusCode)
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", `inline; filename="${normalizedFileName}"`)
  res.setHeader("Content-Length", String(buffer.length))

  return res.end(buffer)
}
