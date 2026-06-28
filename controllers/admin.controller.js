import { getPool, exec } from "../lib/db.js"
import { sendSuccess, createError } from "../utils/response.js"
import { createNotification } from "../utils/notification.utils.js"
import { updateDriverReviewStatus, insertDriverStatusHistory, listDriverStatusHistory } from "../models/driver.model.js"
import { addDriverVerificationTimelineEvent, listDriverVerificationTimeline } from "../models/driver.model.js"
import { listAllSettings, upsertSetting } from "../models/settings.model.js"
import { insertDeliveryStatusHistory } from "../models/delivery.model.js"

const ACTIVE_DELIVERY_STATUSES = ["Accepted", "DriverArrivedPickup", "PickedUp", "InTransit", "ArrivedDropoff"]
const CANCELLED_DELIVERY_STATUSES = ["CancelledByUser", "CancelledByDriver", "Rejected", "FailedDelivery", "Refunded"]
const PAID_PAYMENT_STATUSES = ["completed", "cash_received"]
const PRO_DRIVER_DOCUMENT_TYPES = ["RC"]

const toNumber = (value) => Number(value || 0)

const toDashboardDateRange = (period) => {
  const end = new Date()
  const start = new Date(end)

  switch (String(period || "month").toLowerCase()) {
    case "all":
      start.setFullYear(1970, 0, 1)
      start.setHours(0, 0, 0, 0)
      break
    case "day":
    case "today":
      start.setHours(0, 0, 0, 0)
      break
    case "week":
      start.setDate(start.getDate() - 7)
      break
    case "year":
      start.setFullYear(start.getFullYear() - 1)
      break
    case "month":
    default:
      start.setMonth(start.getMonth() - 1)
      break
  }

  return { start, end }
}

const mapTopDriverRow = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  phone: row.phone || null,
  profilePicture: row.profile_picture || null,
  driverType: row.driver_type || "normal",
  rating: Number(row.rating || 0),
  ratingCount: Number(row.rating_count || 0),
  deliveries: Number(row.deliveries || 0),
  revenue: Number(row.revenue || 0),
  createdAt: row.created_at,
})

const mapTopClientRow = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  phone: row.phone || null,
  profilePicture: row.profile_picture || null,
  deliveries: Number(row.deliveries || 0),
  totalSpent: Number(row.total_spent || 0),
  createdAt: row.created_at,
})

const mapRecentTransactionRow = (row) => ({
  id: row.id,
  transactionId: row.transaction_id || null,
  amount: Number(row.amount || 0),
  commission: Number(row.commission || 0),
  method: row.method,
  status: row.status,
  deliveryStatus: row.delivery_status || null,
  date: row.created_at,
  user: {
    id: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone || null,
  },
})

const buildDailySeries = (rows, daysInMonth, dayKey, valueKey) => {
  const series = Array(daysInMonth).fill(0)

  for (const row of rows) {
    const day = Number(row[dayKey] || 0) - 1
    if (day < 0 || day >= daysInMonth) {
      continue
    }

    series[day] = Number(row[valueKey] || 0)
  }

  return series
}

const buildDashboardStatsResponse = async () => {
  const { start: dayStart } = toDashboardDateRange("day")
  const { start: weekStart } = toDashboardDateRange("week")
  const { start: monthStart } = toDashboardDateRange("month")
  const { start: yearStart } = toDashboardDateRange("year")
  const now = new Date()
  const calendarMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

  // Helper that logs index + preview of failing query
  const runWithLog = async (idx, label, sql, params = []) => {
    try {
      const result = await exec(null, sql, params)
      return result
    } catch (err) {
      console.error(`[DB QUERY FAIL] Index ${idx} "${label}": ${err.message}`)
      if (process.env.NODE_ENV !== 'production') {
        console.error(`  SQL: ${sql.substring(0, 200)}`)
      }
      throw err
    }
  }

  try {
    const [
      usersRows,
      clientsRows,
      driversRows,
      transportersRows,
      deliveriesRows,
      deliveryModeBreakdownRows,
      tripsRows,
      transactionsRows,
      pendingRequestsRows,
      rejectedRows,
      suspendedRows,
      blockedRows,
      revenueRows,
      todayTransactionsRows,
      pendingDocumentsRows,
      pendingDriverReviewsRows,
      approvedDriversRows,
      rejectedDriversRows,
      activeDeliveriesRows,
      cancelledDeliveriesRows,
      completedDeliveriesRows,
      deliveriesTodayRows,
      deliveriesWeekRows,
      deliveriesMonthRows,
      tripsPublishedRows,
      tripsCompletedRows,
      tripsCancelledRows,
      tripsTodayRows,
      tripsMonthRows,
      revenueTodayRows,
      revenueWeekRows,
      revenueMonthRows,
      revenueYearRows,
      commissionRows,
      transactionAmountRows,
      driverEarningsRows,
      proDriverEarningsRows,
      revenueSeriesRows,
      registrationClientsRows,
      registrationDriversRows,
      pendingDriversRows,
      topDriversRows,
      topClientsRows,
      recentTransactionsRows,
      activePromotionsRows,
      notificationsSentRows,
    ] = await Promise.all([
      runWithLog(0,  'users',                `SELECT COUNT(*) AS total FROM Users`),
      runWithLog(1,  'clients',              `SELECT COUNT(*) AS total FROM Requesters`),
      runWithLog(2,  'drivers',              `SELECT COUNT(*) AS total FROM Drivers`),
      runWithLog(3,  'transporters',         `SELECT COUNT(*) AS total FROM Drivers WHERE driver_type = 'pro_transporter'`),
      runWithLog(4,  'deliveries',           `SELECT COUNT(*) AS total FROM Deliveries`),
      runWithLog(5,  'deliveryModeBreakdown',`SELECT COALESCE(SUM(CASE WHEN delivery_mode = 'standard' THEN 1 ELSE 0 END), 0) AS standard, COALESCE(SUM(CASE WHEN delivery_mode = 'pro_transporter' THEN 1 ELSE 0 END), 0) AS pro FROM Deliveries`),
      runWithLog(6,  'trips',                `SELECT COUNT(*) AS total FROM Trips`),
      runWithLog(7,  'transactions',         `SELECT COUNT(*) AS total FROM DeliveryPayments`),
      runWithLog(8,  'pendingRequests',      `SELECT COUNT(*) AS total FROM Deliveries WHERE status = 'Pending'`),
      runWithLog(9,  'rejected',             `SELECT COUNT(*) AS total FROM Deliveries WHERE status IN ('Rejected','FailedDelivery')`),
      runWithLog(10, 'suspended',            `SELECT COUNT(*) AS total FROM Users WHERE is_suspended = 1`),
      runWithLog(11, 'blocked',              `SELECT COUNT(*) AS total FROM Users WHERE is_blocked = 1`),
      runWithLog(12, 'revenue',              `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalRevenue FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received')`),
      runWithLog(13, 'todayTransactions',    `SELECT COUNT(*) AS total FROM DeliveryPayments WHERE DATE(created_at) = CURDATE()`),
      runWithLog(14, 'pendingDocuments',     `SELECT COUNT(*) AS total FROM Documents WHERE review_status = 'pending' OR is_verified = 0`),
      runWithLog(15, 'pendingDriverReviews', `SELECT COUNT(*) AS total FROM Drivers WHERE review_status = 'pending'`),
      runWithLog(16, 'approvedDrivers',      `SELECT COUNT(*) AS total FROM Drivers WHERE review_status = 'approved'`),
      runWithLog(17, 'rejectedDrivers',      `SELECT COUNT(*) AS total FROM Drivers WHERE review_status = 'rejected'`),
      runWithLog(18, 'activeDeliveries',     `SELECT COUNT(*) AS total FROM Deliveries WHERE status IN (?, ?, ?, ?, ?)`, ACTIVE_DELIVERY_STATUSES),
      runWithLog(19, 'cancelledDeliveries',  `SELECT COUNT(*) AS total FROM Deliveries WHERE status IN (?, ?, ?, ?, ?)`, CANCELLED_DELIVERY_STATUSES),
      runWithLog(20, 'completedDeliveries',  `SELECT COUNT(*) AS total FROM Deliveries WHERE status = 'Delivered'`),
      runWithLog(21, 'deliveriesToday',      `SELECT COUNT(*) AS total FROM Deliveries WHERE created_at >= ?`, [dayStart]),
      runWithLog(22, 'deliveriesWeek',       `SELECT COUNT(*) AS total FROM Deliveries WHERE created_at >= ?`, [weekStart]),
      runWithLog(23, 'deliveriesMonth',      `SELECT COUNT(*) AS total FROM Deliveries WHERE created_at >= ?`, [monthStart]),
      runWithLog(24, 'tripsPublished',       `SELECT COUNT(*) AS total FROM Trips WHERE status IN ('planned', 'active')`),
      runWithLog(25, 'tripsCompleted',       `SELECT COUNT(*) AS total FROM Trips WHERE status = 'completed'`),
      runWithLog(26, 'tripsCancelled',       `SELECT COUNT(*) AS total FROM Trips WHERE status = 'cancelled'`),
      runWithLog(27, 'tripsToday',           `SELECT COUNT(*) AS total FROM Trips WHERE created_at >= ?`, [dayStart]),
      runWithLog(28, 'tripsMonth',           `SELECT COUNT(*) AS total FROM Trips WHERE created_at >= ?`, [monthStart]),
      runWithLog(29, 'revenueToday',         `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalRevenue FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received') AND pay.created_at >= ?`, [dayStart]),
      runWithLog(30, 'revenueWeek',          `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalRevenue FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received') AND pay.created_at >= ?`, [weekStart]),
      runWithLog(31, 'revenueMonth',         `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalRevenue FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received') AND pay.created_at >= ?`, [monthStart]),
      runWithLog(32, 'revenueYear',          `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalRevenue FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received') AND pay.created_at >= ?`, [yearStart]),
      runWithLog(33, 'commissionRows',       `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price, 0) * 0.1), 0) AS totalCommission FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received')`),
      runWithLog(34, 'transactionAmount',    `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price, 0)), 0) AS totalAmount FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received')`),
      runWithLog(35, 'driverEarnings',       `SELECT COALESCE(SUM(CASE WHEN COALESCE(drv.driver_type, 'normal_driver') != 'pro_transporter' THEN COALESCE(dp.final_price, dp.price, 0) ELSE 0 END), 0) AS totalEarnings FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id LEFT JOIN Drivers drv ON drv.participant_id = d.assigned_driver_id WHERE pay.status IN ('completed', 'cash_received')`),
      runWithLog(36, 'proDriverEarnings',    `SELECT COALESCE(SUM(CASE WHEN drv.driver_type = 'pro_transporter' THEN COALESCE(dp.final_price, dp.price, 0) ELSE 0 END), 0) AS totalEarnings FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id LEFT JOIN Drivers drv ON drv.participant_id = d.assigned_driver_id WHERE pay.status IN ('completed', 'cash_received')`),
      runWithLog(37, 'revenueSeries',        `SELECT DAY(pay.created_at) AS day, COALESCE(SUM(COALESCE(dp.final_price, dp.price, 0) * 0.1), 0) AS totalRevenue FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received') AND pay.created_at >= ? AND pay.created_at < ? GROUP BY DAY(pay.created_at) ORDER BY day ASC`, [calendarMonthStart, nextMonthStart]),
      runWithLog(38, 'registrationClients',  `SELECT DAY(u.created_at) AS day, COUNT(*) AS total FROM Users u INNER JOIN Requesters r ON r.participant_id = u.id WHERE u.created_at >= ? AND u.created_at < ? GROUP BY DAY(u.created_at) ORDER BY day ASC`, [calendarMonthStart, nextMonthStart]),
      runWithLog(39, 'registrationDrivers',  `SELECT DAY(u.created_at) AS day, COUNT(*) AS total FROM Users u INNER JOIN Drivers d ON d.participant_id = u.id WHERE u.created_at >= ? AND u.created_at < ? GROUP BY DAY(u.created_at) ORDER BY day ASC`, [calendarMonthStart, nextMonthStart]),
      runWithLog(40, 'pendingDrivers',       `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture, u.created_at, d.review_status, d.review_reason, d.reviewed_by, d.reviewed_at, d.is_documents_verified, CASE d.driver_type WHEN 'pro_transporter' THEN 'professional' ELSE 'normal' END AS driver_type FROM Drivers d INNER JOIN Users u ON u.id = d.participant_id WHERE d.review_status = 'pending' ORDER BY u.created_at DESC LIMIT 8`),
      runWithLog(41, 'topDrivers',           `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture, u.created_at, COALESCE(ratings.rating_count, 0) AS rating_count, COALESCE(ratings.average_rating, 0) AS rating, COALESCE(stats.deliveries, 0) AS deliveries, COALESCE(stats.revenue, 0) AS revenue, CASE d.driver_type WHEN 'pro_transporter' THEN 'professional' ELSE 'normal' END AS driver_type FROM Drivers d INNER JOIN Users u ON u.id = d.participant_id LEFT JOIN (SELECT to_user_id AS user_id, COUNT(*) AS rating_count, COALESCE(AVG(rating), 0) AS average_rating FROM Rates GROUP BY to_user_id) ratings ON ratings.user_id = u.id LEFT JOIN (SELECT assigned_driver_id AS driver_id, COUNT(*) AS deliveries, COALESCE(SUM(COALESCE(dp.final_price, dp.price, 0)), 0) AS revenue FROM Deliveries d INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id WHERE pay.status IN ('completed', 'cash_received') GROUP BY assigned_driver_id) stats ON stats.driver_id = d.participant_id ORDER BY revenue DESC, deliveries DESC, rating DESC, u.created_at DESC LIMIT 10`),
      runWithLog(42, 'topClients',           `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture, u.created_at, COUNT(*) AS deliveries, COALESCE(SUM(COALESCE(dp.final_price, dp.price, 0)), 0) AS total_spent FROM Users u INNER JOIN Deliveries d ON d.requester_id = u.id LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id WHERE d.status = 'Delivered' GROUP BY u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture, u.created_at ORDER BY total_spent DESC, deliveries DESC, u.created_at DESC LIMIT 10`),
      runWithLog(43, 'recentTransactions',   `SELECT pay.id, pay.delivery_id, pay.transaction_id, pay.method, pay.status, pay.created_at, d.status AS delivery_status, u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, COALESCE(dp.final_price, dp.price, 0) AS amount, COALESCE(dp.final_price, dp.price, 0) * 0.1 AS commission FROM DeliveryPayments pay INNER JOIN Deliveries d ON d.id = pay.delivery_id INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id INNER JOIN Users u ON u.id = d.requester_id ORDER BY pay.created_at DESC LIMIT 10`),
      runWithLog(44, 'activePromotions',     `SELECT COUNT(*) AS total FROM Promotions WHERE is_active = 1 AND (end_date IS NULL OR end_date >= NOW())`),
      runWithLog(45, 'notificationsSent',    `SELECT COUNT(*) AS total FROM Notifications`),
    ])

    const totalUsers = toNumber(usersRows[0]?.total)
    const totalClients = toNumber(clientsRows[0]?.total)
    const totalDrivers = toNumber(driversRows[0]?.total)
    const totalProDrivers = toNumber(transportersRows[0]?.total)
    const normalDrivers = Math.max(totalDrivers - totalProDrivers, 0)
    const revenueSeries = buildDailySeries(revenueSeriesRows, daysInMonth, "day", "totalRevenue")
    const registrationClientsSeries = buildDailySeries(
      registrationClientsRows,
      daysInMonth,
      "day",
      "total",
    )
    const registrationDriversSeries = buildDailySeries(
      registrationDriversRows,
      daysInMonth,
      "day",
      "total",
    )

    const counts = {
      users: totalUsers,
      clients: totalClients,
      drivers: normalDrivers,
      transporters: totalProDrivers,
      approvedDrivers: toNumber(approvedDriversRows[0]?.total),
      rejectedDrivers: toNumber(rejectedDriversRows[0]?.total),
      deliveries: toNumber(deliveriesRows[0]?.total),
      standardDeliveries: toNumber(deliveryModeBreakdownRows[0]?.standard),
      proTransporterDeliveries: toNumber(deliveryModeBreakdownRows[0]?.pro),
      trips: toNumber(tripsRows[0]?.total),
      transactions: toNumber(transactionsRows[0]?.total),
      pendingRequests: toNumber(pendingRequestsRows[0]?.total),
      rejectedCases: toNumber(rejectedRows[0]?.total),
      suspendedAccounts: toNumber(suspendedRows[0]?.total),
      blockedAccounts: toNumber(blockedRows[0]?.total),
      pendingDocuments: toNumber(pendingDocumentsRows[0]?.total),
      pendingDriverReviews: toNumber(pendingDriverReviewsRows[0]?.total),
    }

    return {
      counts,
      revenue: {
        total: toNumber(revenueRows[0]?.totalRevenue),
        currency: "DZD",
        todayTransactions: toNumber(todayTransactionsRows[0]?.total),
        totalCommissions: toNumber(commissionRows[0]?.totalCommission),
        totalTransactionAmount: toNumber(transactionAmountRows[0]?.totalAmount),
        revenueToday: toNumber(revenueTodayRows[0]?.totalRevenue),
        revenueThisWeek: toNumber(revenueWeekRows[0]?.totalRevenue),
        revenueThisMonth: toNumber(revenueMonthRows[0]?.totalRevenue),
        revenueThisYear: toNumber(revenueYearRows[0]?.totalRevenue),
        driverEarnings: toNumber(driverEarningsRows[0]?.totalEarnings),
        proDriverEarnings: toNumber(proDriverEarningsRows[0]?.totalEarnings),
      },
      deliveries: {
        total: toNumber(deliveriesRows[0]?.total),
        active: toNumber(activeDeliveriesRows[0]?.total),
        completed: toNumber(completedDeliveriesRows[0]?.total),
        cancelled: toNumber(cancelledDeliveriesRows[0]?.total),
        today: toNumber(deliveriesTodayRows[0]?.total),
        thisWeek: toNumber(deliveriesWeekRows[0]?.total),
        thisMonth: toNumber(deliveriesMonthRows[0]?.total),
      },
      trips: {
        total: toNumber(tripsRows[0]?.total),
        published: toNumber(tripsPublishedRows[0]?.total),
        completed: toNumber(tripsCompletedRows[0]?.total),
        cancelled: toNumber(tripsCancelledRows[0]?.total),
        today: toNumber(tripsTodayRows[0]?.total),
        thisMonth: toNumber(tripsMonthRows[0]?.total),
      },
      verification: {
        pendingDocuments: toNumber(pendingDocumentsRows[0]?.total),
        pendingDriverReviews: toNumber(pendingDriverReviewsRows[0]?.total),
        pendingApprovals: toNumber(pendingDriverReviewsRows[0]?.total),
      },
      revenueSeries,
      registrations: {
        clients: registrationClientsSeries,
        drivers: registrationDriversSeries,
      },
      pendingDrivers: pendingDriversRows.map(mapDriverReviewRow),
      topDrivers: topDriversRows.map(mapTopDriverRow),
      topClients: topClientsRows.map(mapTopClientRow),
      recentTransactions: recentTransactionsRows.map(mapRecentTransactionRow),
      activePromotions: toNumber(activePromotionsRows[0]?.total),
      notificationsSent: toNumber(notificationsSentRows[0]?.total),
    }
  } catch (err) {
    console.error(`[DASHBOARD STATS ERROR] ${err.message}`)
    if (process.env.NODE_ENV !== 'production') {
      console.error(err.stack)
    }
    throw err
  }
}

const toSafePaginationInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(Math.max(parsed, 0), max)
}

const toPeriodRange = (period) => {
  const now = new Date()
  const start = new Date(now)

  switch (String(period || "month").toLowerCase()) {
    case "all":
      start.setFullYear(1970, 0, 1)
      start.setHours(0, 0, 0, 0)
      break
    case "day":
    case "today":
      start.setHours(0, 0, 0, 0)
      break
    case "week":
      start.setDate(start.getDate() - 7)
      break
    case "year":
      start.setFullYear(start.getFullYear() - 1)
      break
    case "month":
    default:
      start.setMonth(start.getMonth() - 1)
      break
  }

  return { start, end: now }
}

const mapDriverReviewRow = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  phone: row.phone || "",
  profilePicture: row.profile_picture || "",
  createdAt: row.created_at,
  role: "driver",
  driverType: row.driver_type || "normal",
  driverReviewStatus: row.verification_status || row.review_status || "pending",
  driverApprovedBy: row.reviewed_by || null,
  driverApprovedAt: row.approved_at || row.reviewed_at || null,
  isDocumentsVerified: row.is_documents_verified === 1 || row.is_documents_verified === true,
})

const mapUserRow = (row) => {
  if (!row) return null
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    profilePicture: row.profile_picture || "",
    city: row.city || null,
    address: row.address || null,
    isEmailVerified: !!row.is_email_verified,
    isBlocked: !!row.is_blocked,
    isSuspended: !!row.is_suspended,
    blockedAt: row.blocked_at || null,
    suspendedAt: row.suspended_at || null,
    role: row.role || "client",
    driverType: row.driver_type || null,
    driverReviewStatus: row.verification_status || row.review_status || null,
    driverReviewReason: row.review_reason || null,
    driverReviewedAt: row.reviewed_at || null,
    driverApprovedBy: row.reviewed_by || null,
    driverApprovedAt: row.approved_at || row.reviewed_at || null,
    isDocumentsVerified: row.is_documents_verified === 1 || row.is_documents_verified === true,
    deliveryCount: Number(row.delivery_count || 0),
    tripCount: Number(row.trip_count || 0),
    transactionCount: Number(row.transaction_count || 0),
    totalSpent: Number(row.total_spent || 0),
    revenueGenerated: Number(row.revenue_generated || row.total_spent || 0),
    rating: Number(row.rating || 0),
    ratingCount: Number(row.rating_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const sendDriverReviewNotification = async (driverId, reviewStatus, reason = null) => {
  const normalizedStatus = String(reviewStatus || "").toLowerCase()
  if (normalizedStatus !== "approved" && normalizedStatus !== "rejected") {
    return null
  }

  return createNotification({
    recipient: driverId,
    title:
      normalizedStatus === "approved"
        ? "Félicitations ! Votre compte conducteur a été approuvé."
        : "Votre demande a été refusée.",
    message:
      normalizedStatus === "approved"
        ? "Votre compte conducteur a été approuvé. Vous pouvez maintenant accéder au dashboard conducteur."
        : reason
          ? `Votre demande a été refusée. Motif: ${reason}`
          : "Votre demande a Ã©tÃ© refusÃ©e.",
    type: `driver_review_${normalizedStatus}`,
    referenceId: driverId,
    referenceModel: "Driver",
    sendEmail: false,
  })
}

export const listAccounts = async (req, res, next) => {
  try {
    const limit = toSafePaginationInt(req.query.limit, 20, 100)
    const offset = toSafePaginationInt(req.query.offset, 0)
    const role = req.adminRoleOverride || req.query.role || null
    const search = req.query.search || null
    const reviewStatus = req.query.reviewStatus || null

    let where = "WHERE 1=1"
    const params = []

    if (search) {
      where += " AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)"
      const like = `%${search}%`
      params.push(like, like, like, like)
    }

    if (role === "driver") {
      where += " AND d.participant_id IS NOT NULL"
      if (reviewStatus) {
        where += " AND d.review_status = ?"
        params.push(reviewStatus)
      }
    } else if (role === "client") {
      where += " AND r.participant_id IS NOT NULL"
    } else if (role === "admin") {
      where += " AND a.user_id IS NOT NULL"
    } else if (role === "authority") {
      where += " AND auth.user_id IS NOT NULL"
    }

    const rows = await exec(
      null,
      `SELECT u.*,
        COALESCE((SELECT COUNT(*) FROM Deliveries d WHERE d.requester_id = u.id), 0) AS delivery_count,
        COALESCE((SELECT COUNT(*) FROM Trips t WHERE t.driver_id = u.id), 0) AS trip_count,
        COALESCE((SELECT SUM(COALESCE(dp.final_price, dp.price))
          FROM Deliveries d
          LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
          WHERE d.requester_id = u.id AND d.status = 'Delivered'), 0) AS total_spent,
        COALESCE((SELECT AVG(r.rating) FROM Rates r WHERE r.to_user_id = u.id), 0) AS rating,
        CASE
          WHEN a.user_id IS NOT NULL THEN 'admin'
          WHEN auth.user_id IS NOT NULL THEN 'authority'
          WHEN d.participant_id IS NOT NULL THEN 'driver'
          ELSE 'client'
          END AS role,
          CASE
            WHEN d.participant_id IS NULL THEN NULL
            WHEN d.driver_type = 'pro_transporter' THEN 'professional'
            ELSE 'normal'
          END AS driver_type,
          d.review_status,
          d.review_reason,
          d.reviewed_at,
          d.is_documents_verified
       FROM Users u
       LEFT JOIN Admins a ON a.user_id = u.id
       LEFT JOIN Authorities auth ON auth.user_id = u.id
       LEFT JOIN Drivers d ON d.participant_id = u.id
       LEFT JOIN Requesters r ON r.participant_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM Users u
       LEFT JOIN Admins a ON a.user_id = u.id
       LEFT JOIN Authorities auth ON auth.user_id = u.id
       LEFT JOIN Drivers d ON d.participant_id = u.id
       LEFT JOIN Requesters r ON r.participant_id = u.id
       ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Accounts fetched successfully", {
      users: rows.map(mapUserRow),
      total: Number(countRows[0]?.total || 0),
    })
  } catch (error) {
    next(error)
  }
}

export const listDriversWithSubmittedDocuments = async (req, res, next) => {
  try {
    const limit = toSafePaginationInt(req.query.limit, 100, 200)
    const offset = toSafePaginationInt(req.query.offset, 0)
    const search = String(req.query.search || "").trim()

    const params = []
    let where = "WHERE d.participant_id IS NOT NULL AND d.review_status = 'pending' AND docs.document_count > 0"

    if (search) {
      where += " AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)"
      const like = `%${search}%`
      params.push(like, like, like, like)
    }

    const rows = await exec(
      null,
      `SELECT u.*,
        COALESCE((SELECT COUNT(*) FROM Deliveries del WHERE del.requester_id = u.id), 0) AS delivery_count,
        COALESCE((SELECT COUNT(*) FROM Trips t WHERE t.driver_id = u.id), 0) AS trip_count,
        COALESCE((SELECT COUNT(*) FROM DeliveryPayments pay INNER JOIN Deliveries del ON del.id = pay.delivery_id WHERE del.requester_id = u.id), 0) AS transaction_count,
        COALESCE((SELECT SUM(COALESCE(dp.final_price, dp.price))
          FROM Deliveries del
          LEFT JOIN DeliveryPricing dp ON dp.delivery_id = del.id
          WHERE del.requester_id = u.id), 0) AS total_spent,
        COALESCE((SELECT SUM(COALESCE(dp.final_price, dp.price))
          FROM Deliveries del
          LEFT JOIN DeliveryPricing dp ON dp.delivery_id = del.id
          WHERE del.assigned_driver_id = u.id), 0) AS revenue_generated,
        COALESCE((SELECT AVG(r.rating) FROM Rates r WHERE r.to_user_id = u.id), 0) AS rating,
        COALESCE((SELECT COUNT(*) FROM Rates r WHERE r.to_user_id = u.id), 0) AS rating_count,
        'driver' AS role,
        CASE d.driver_type
          WHEN 'pro_transporter' THEN 'professional'
          ELSE 'normal'
        END AS driver_type,
        d.review_status,
        d.verification_status,
        d.review_reason,
        d.reviewed_at,
        d.approved_at,
        d.is_documents_verified
       FROM Drivers d
       INNER JOIN Users u ON u.id = d.participant_id
       INNER JOIN (
         SELECT driver_id, COUNT(*) AS document_count
         FROM Documents
         GROUP BY driver_id
       ) docs ON docs.driver_id = d.participant_id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM Drivers d
       INNER JOIN Users u ON u.id = d.participant_id
       INNER JOIN (
         SELECT driver_id, COUNT(*) AS document_count
         FROM Documents
         GROUP BY driver_id
       ) docs ON docs.driver_id = d.participant_id
       ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Drivers with submitted documents fetched successfully", {
      drivers: rows.map(mapUserRow),
      total: Number(countRows[0]?.total || 0),
      pagination: { limit, offset },
    })
  } catch (error) {
    next(error)
  }
}
export const listAdminDriverReviews = async (req, res, next) => {
  try {
    const reviewStatus = req.query.reviewStatus || req.path.split("/").filter(Boolean).pop()
    req.adminRoleOverride = "driver"
    req.adminReviewStatusOverride = reviewStatus

    return listAccounts(req, res, next)
  } catch (error) {
    next(error)
  }
}

export const getAccount = async (req, res, next) => {
  try {
    const rows = await exec(
      null,
      `SELECT u.*,
        COALESCE((SELECT COUNT(*) FROM Deliveries d WHERE d.requester_id = u.id), 0) AS delivery_count,
        COALESCE((SELECT COUNT(*) FROM Trips t WHERE t.driver_id = u.id), 0) AS trip_count,
        COALESCE((SELECT COUNT(*) FROM DeliveryPayments pay INNER JOIN Deliveries d ON d.id = pay.delivery_id WHERE d.requester_id = u.id), 0) AS transaction_count,
        COALESCE((SELECT SUM(COALESCE(dp.final_price, dp.price))
          FROM Deliveries d
          LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
          WHERE d.requester_id = u.id AND d.status = 'Delivered'), 0) AS total_spent,
        COALESCE((SELECT SUM(COALESCE(dp.final_price, dp.price))
          FROM Deliveries d
          LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
          WHERE d.assigned_driver_id = u.id AND d.status = 'Delivered'), 0) AS revenue_generated,
        COALESCE((SELECT AVG(r.rating) FROM Rates r WHERE r.to_user_id = u.id), 0) AS rating,
        COALESCE((SELECT COUNT(*) FROM Rates r WHERE r.to_user_id = u.id), 0) AS rating_count,
        CASE
          WHEN a.user_id IS NOT NULL THEN 'admin'
          WHEN auth.user_id IS NOT NULL THEN 'authority'
          WHEN d.participant_id IS NOT NULL THEN 'driver'
          ELSE 'client'
          END AS role,
          CASE
            WHEN d.participant_id IS NULL THEN NULL
            WHEN d.driver_type = 'pro_transporter' THEN 'professional'
            ELSE 'normal'
          END AS driver_type,
          d.review_status,
          d.review_reason,
          d.reviewed_at,
          d.is_documents_verified
       FROM Users u
       LEFT JOIN Admins a ON a.user_id = u.id
       LEFT JOIN Authorities auth ON auth.user_id = u.id
       LEFT JOIN Drivers d ON d.participant_id = u.id
       LEFT JOIN Requesters r ON r.participant_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [req.params.userId],
    )

    const user = rows[0]
    if (!user) return next(createError(404, "User not found"))

    return sendSuccess(res, 200, "Account fetched successfully", { user: mapUserRow(user) })
  } catch (error) {
    next(error)
  }
}

export const blockAccount = async (req, res, next) => {
  try {
    const { userId } = req.params
    const { reason } = req.body

    const rows = await exec(null, `SELECT id, is_blocked FROM Users WHERE id = ? LIMIT 1`, [userId])
    if (!rows[0]) return next(createError(404, "User not found"))
    if (rows[0].is_blocked) return next(createError(409, "Account is already blocked"))

    const driverRows = await exec(null, `SELECT participant_id, review_status FROM Drivers WHERE participant_id = ? LIMIT 1`, [userId])
    const oldStatus = driverRows[0]?.review_status || null

    await exec(
      null,
      `UPDATE Users SET is_blocked = 1, blocked_at = NOW(), token_version = COALESCE(token_version, 0) + 1 WHERE id = ?`,
      [userId],
    )

    await exec(null, `DELETE FROM UserTokens WHERE user_id = ?`, [userId])
    await exec(null, `UPDATE Drivers SET review_status = 'blocked', verification_status = 'blocked', review_reason = ?, reviewed_by = ?, reviewed_at = NOW(), approved_at = NULL, is_documents_verified = 0, is_available = 0, availability = 'offline' WHERE participant_id = ?`, [reason || 'blocked_by_admin', req.user.id, userId])

    await insertDriverStatusHistory(null, {
      driverId: userId,
      oldStatus,
      newStatus: 'blocked',
      changedBy: req.user.id,
      comment: reason || 'blocked_by_admin',
    })

    return sendSuccess(res, 200, "Account blocked successfully", { userId, reason: reason || null })
  } catch (error) {
    next(error)
  }
}

export const unblockAccount = async (req, res, next) => {
  try {
    const { userId } = req.params

    const rows = await exec(null, `SELECT id FROM Users WHERE id = ? LIMIT 1`, [userId])
    if (!rows[0]) return next(createError(404, "User not found"))

    await exec(
      null,
      `UPDATE Users SET is_blocked = 0, blocked_at = NULL WHERE id = ?`,
      [userId],
    )

    await exec(null, `UPDATE Drivers SET review_status = 'pending', verification_status = 'pending', review_reason = NULL, reviewed_by = ?, reviewed_at = NOW(), approved_at = NULL WHERE participant_id = ? AND review_status = 'blocked'`, [req.user.id, userId])

    await insertDriverStatusHistory(null, {
      driverId: userId,
      oldStatus: 'blocked',
      newStatus: 'pending',
      changedBy: req.user.id,
      comment: 'unblocked_by_admin',
    })

    return sendSuccess(res, 200, "Account unblocked successfully", { userId })
  } catch (error) {
    next(error)
  }
}

export const suspendAccount = async (req, res, next) => {
  try {
    const { userId } = req.params
    const { reason } = req.body

    const rows = await exec(null, `SELECT id, is_suspended FROM Users WHERE id = ? LIMIT 1`, [userId])
    if (!rows[0]) return next(createError(404, "User not found"))
    if (rows[0].is_suspended) return next(createError(409, "Account is already suspended"))

    await exec(
      null,
      `UPDATE Users SET is_suspended = 1, suspended_at = NOW() WHERE id = ?`,
      [userId],
    )

    return sendSuccess(res, 200, "Account suspended successfully", { userId, reason: reason || null })
  } catch (error) {
    next(error)
  }
}

export const unsuspendAccount = async (req, res, next) => {
  try {
    const { userId } = req.params

    const rows = await exec(null, `SELECT id FROM Users WHERE id = ? LIMIT 1`, [userId])
    if (!rows[0]) return next(createError(404, "User not found"))

    await exec(
      null,
      `UPDATE Users SET is_suspended = 0, suspended_at = NULL WHERE id = ?`,
      [userId],
    )

    return sendSuccess(res, 200, "Account unsuspended successfully", { userId })
  } catch (error) {
    next(error)
  }
}

export const deleteAccount = async (req, res, next) => {
  try {
    const { userId } = req.params

    if (userId === req.user.id) {
      return next(createError(400, "Admins cannot delete their own account"))
    }

    const rows = await exec(null, `SELECT id FROM Users WHERE id = ? LIMIT 1`, [userId])
    if (!rows[0]) return next(createError(404, "User not found"))

    await exec(null, `DELETE FROM Users WHERE id = ?`, [userId])

    return sendSuccess(res, 200, "Account deleted successfully", { userId })
  } catch (error) {
    next(error)
  }
}

export const overrideDeliveryStatus = async (req, res, next) => {
  try {
    const { deliveryId } = req.params
    const { status, reason } = req.body

    const allowed = [
      "Draft", "Pending", "Accepted", "DriverArrivedPickup", "PickedUp",
      "InTransit", "ArrivedDropoff", "Delivered", "CancelledByUser",
      "CancelledByDriver", "Rejected", "FailedDelivery", "Refunded",
    ]

    if (!status || !allowed.includes(status)) {
      return next(createError(400, `Invalid status. Must be one of: ${allowed.join(", ")}`))
    }

    const rows = await exec(
      null,
      `SELECT id, status FROM Deliveries WHERE id = ? LIMIT 1`,
      [deliveryId],
    )

    if (!rows[0]) return next(createError(404, "Delivery not found"))

    await exec(
      null,
      `UPDATE Deliveries SET status = ?, updated_at = NOW() WHERE id = ?`,
      [status, deliveryId],
    )

    await insertDeliveryStatusHistory(null, deliveryId, status, req.user.id, reason || null)

    return sendSuccess(res, 200, "Delivery status overridden successfully", {
      deliveryId,
      previousStatus: rows[0].status,
      newStatus: status,
      reason: reason || null,
      overriddenBy: req.user.id,
    })
  } catch (error) {
    next(error)
  }
}

export const verifyDriverDocuments = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const { verified } = req.body

    const rows = await exec(
      null,
      `SELECT participant_id FROM Drivers WHERE participant_id = ? LIMIT 1`,
      [driverId],
    )
    if (!rows[0]) return next(createError(404, "Driver not found"))

    await updateDriverReviewStatus(null, driverId, {
      reviewStatus: verified ? "approved" : "pending",
      reviewReason: null,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      isDocumentsVerified: !!verified,
    })

    if (verified) {
      await sendDriverReviewNotification(driverId, "approved")
    }

    return sendSuccess(res, 200, `Driver documents ${verified ? "verified" : "unverified"} successfully`, {
      driverId,
      isDocumentsVerified: !!verified,
    })
  } catch (error) {
    next(error)
  }
}

export const updateDriverReviewStatusHandler = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const { reviewStatus, reason } = req.body || {}

    if (!reviewStatus) {
      return next(createError(400, "reviewStatus is required"))
    }

    const allowed = new Set(["pending", "approved", "rejected", "blocked"])
    if (!allowed.has(reviewStatus)) {
      return next(createError(400, "Invalid reviewStatus value"))
    }

    const rows = await exec(
      null,
      `SELECT participant_id, review_status FROM Drivers WHERE participant_id = ? LIMIT 1`,
      [driverId],
    )
    if (!rows[0]) {
      return next(createError(404, "Driver not found"))
    }
    const oldStatus = rows[0].review_status

    const isDocumentsVerified = reviewStatus === "approved"
      ? true
      : reviewStatus === "rejected" || reviewStatus === "blocked"
      ? false
      : undefined

    await updateDriverReviewStatus(null, driverId, {
      reviewStatus,
      verificationStatus: reviewStatus,
      reviewReason: reason || null,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      approvedAt: reviewStatus === "approved" ? new Date() : null,
      isDocumentsVerified,
      isAvailable: reviewStatus === "approved" ? true : reviewStatus === "pending" ? undefined : false,
      availability: reviewStatus === "approved" ? "available" : reviewStatus === "pending" ? undefined : "offline",
      approvalWelcomeShown: reviewStatus === "approved" ? false : undefined,
    })

    console.log(`[ADMIN] Driver ${driverId} review ${oldStatus} -> ${reviewStatus}, approvalWelcomeShown ${reviewStatus === "approved" ? "reset to false" : "unchanged"}`)

    await addDriverVerificationTimelineEvent(null, {
      driverId,
      eventType: "driver_review_updated",
      entityType: "driver",
      entityId: driverId,
      status: reviewStatus,
      reason: reason || null,
      actorId: req.user.id,
    })

    const updatedRows = await exec(
      null,
      `SELECT participant_id, review_status, verification_status, review_reason, reviewed_by, reviewed_at, approved_at, is_documents_verified
       FROM Drivers
       WHERE participant_id = ?
       LIMIT 1`,
      [driverId],
    )

    await sendDriverReviewNotification(driverId, reviewStatus, reason || null)

    await insertDriverStatusHistory(null, {
      driverId,
      oldStatus: oldStatus || null,
      newStatus: reviewStatus,
      changedBy: req.user.id,
      comment: reason || null,
    })

    return sendSuccess(res, 200, "Driver review status updated successfully", {
      driverId,
      reviewStatus: updatedRows[0]?.verification_status || updatedRows[0]?.review_status || reviewStatus,
      reviewReason: updatedRows[0]?.review_reason || null,
      reviewedBy: updatedRows[0]?.reviewed_by || req.user.id,
      reviewedAt: updatedRows[0]?.reviewed_at || null,
      approvedBy: updatedRows[0]?.reviewed_by || req.user.id,
      approvedAt: updatedRows[0]?.approved_at || updatedRows[0]?.reviewed_at || null,
      isDocumentsVerified: !!updatedRows[0]?.is_documents_verified,
      reason: reason || null,
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverVerificationTimelineHandler = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200)
    const offset = parseInt(req.query.offset, 10) || 0

    const rows = await exec(
      null,
      `SELECT participant_id FROM Drivers WHERE participant_id = ? LIMIT 1`,
      [driverId],
    )
    if (!rows[0]) {
      return next(createError(404, "Driver not found"))
    }

    const timeline = await listDriverVerificationTimeline(null, driverId, {
      limit,
      offset,
    })

    return sendSuccess(res, 200, "Driver verification timeline fetched successfully", {
      driverId,
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

export const getDriverStatusHistoryHandler = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200)
    const offset = parseInt(req.query.offset, 10) || 0

    const rows = await exec(
      null,
      `SELECT participant_id FROM Drivers WHERE participant_id = ? LIMIT 1`,
      [driverId],
    )
    if (!rows[0]) {
      return next(createError(404, "Driver not found"))
    }

    const history = await listDriverStatusHistory(null, driverId, { limit, offset })

    return sendSuccess(res, 200, "Driver status history fetched successfully", {
      driverId,
      history,
      pagination: { limit, offset },
    })
  } catch (error) {
    next(error)
  }
}

export const listAdminTrips = async (req, res, next) => {
  try {
    const limit = toSafePaginationInt(req.query.limit, 20, 100)
    const offset = toSafePaginationInt(req.query.offset, 0)
    const status = req.query.status || null
    const driverId = req.query.driverId || null

    const params = []
    const clauses = []

    if (status) {
      clauses.push("t.status = ?")
      params.push(status)
    }
    if (driverId) {
      clauses.push("t.driver_id = ?")
      params.push(driverId)
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""

    const rows = await exec(
      null,
      `SELECT t.id, t.driver_id, t.title, t.departure_time, t.expected_arrival_time,
              t.max_deliveries, t.available_capacity, t.vehicle_type, t.accepted_package_size,
              t.status, t.notes, t.created_at, t.updated_at,
              u.first_name, u.last_name, u.phone
       FROM Trips t
       JOIN Users u ON u.id = t.driver_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM Trips t
       ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Trips fetched successfully", {
      trips: rows.map((row) => ({
        id: row.id,
        driverId: row.driver_id,
        title: row.title || "",
        departureTime: row.departure_time,
        expectedArrivalTime: row.expected_arrival_time,
        maxDeliveries: row.max_deliveries,
        availableCapacity: row.available_capacity,
        vehicleType: row.vehicle_type || null,
        acceptedPackageSize: row.accepted_package_size || null,
        status: row.status,
        notes: row.notes || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        driver: {
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone || null,
        },
      })),
      total: Number(countRows[0]?.total || 0),
    })
  } catch (error) {
    next(error)
  }
}

export const getAdminDashboardSummary = async (_req, res, next) => {
  try {
    const [
    usersRows,
    clientsRows,
    driversRows,
      transportersRows,
      deliveriesRows,
      tripsRows,
      transactionsRows,
      pendingRows,
      rejectedRows,
      suspendedRows,
      blockedRows,
      revenueRows,
      todayTransactionsRows,
      pendingDocumentsRows,
      pendingDriverReviewsRows,
    ] = await Promise.all([
      exec(null, `SELECT COUNT(*) AS total FROM Users`),
    exec(null, `SELECT COUNT(*) AS total FROM Requesters`),
    exec(null, `SELECT COUNT(*) AS total FROM Drivers`),
      exec(
        null,
        `SELECT COUNT(*) AS total
         FROM Drivers
         WHERE driver_type = 'pro_transporter'`,
      ),
    exec(null, `SELECT COUNT(*) AS total FROM Deliveries`),
    exec(
      null,
      `SELECT
         SUM(CASE WHEN delivery_mode = 'standard' THEN 1 ELSE 0 END) AS standard,
         SUM(CASE WHEN delivery_mode = 'pro_transporter' THEN 1 ELSE 0 END) AS pro
       FROM Deliveries`,
    ),
      exec(null, `SELECT COUNT(*) AS total FROM Trips`),
      exec(null, `SELECT COUNT(*) AS total FROM DeliveryPayments`),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE status = 'Pending'`),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE status IN ('Rejected','FailedDelivery')`),
      exec(null, `SELECT COUNT(*) AS total FROM Users WHERE is_suspended = 1`),
      exec(null, `SELECT COUNT(*) AS total FROM Users WHERE is_blocked = 1`),
      exec(
        null,
        `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalRevenue
         FROM Deliveries d
         INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id
         INNER JOIN DeliveryPayments pay ON pay.delivery_id = d.id
         WHERE pay.status IN ('completed', 'cash_received')`,
      ),
      exec(
        null,
        `SELECT COUNT(*) AS total
         FROM DeliveryPayments
         WHERE DATE(created_at) = CURDATE()`,
      ),
      exec(
        null,
        `SELECT COUNT(*) AS total
         FROM Documents
         WHERE review_status = 'pending' OR is_verified = 0`,
      ),
      exec(
        null,
        `SELECT COUNT(*) AS total
         FROM Drivers
         WHERE review_status = 'pending'`,
      ),
    ])

    return sendSuccess(res, 200, "Admin dashboard summary fetched successfully", {
      counts: {
        users: Number(usersRows[0]?.total || 0),
        clients: Number(clientsRows[0]?.total || 0),
        drivers: Math.max(Number(driversRows[0]?.total || 0) - Number(transportersRows[0]?.total || 0), 0),
        transporters: Number(transportersRows[0]?.total || 0),
        deliveries: Number(deliveriesRows[0]?.total || 0),
        trips: Number(tripsRows[0]?.total || 0),
        transactions: Number(transactionsRows[0]?.total || 0),
        pendingRequests: Number(pendingRows[0]?.total || 0),
        rejectedCases: Number(rejectedRows[0]?.total || 0),
        suspendedAccounts: Number(suspendedRows[0]?.total || 0),
        blockedAccounts: Number(blockedRows[0]?.total || 0),
        pendingDocuments: Number(pendingDocumentsRows[0]?.total || 0),
        pendingDriverReviews: Number(pendingDriverReviewsRows[0]?.total || 0),
      },
      revenue: {
        total: Number(revenueRows[0]?.totalRevenue || 0),
        currency: "DZD",
        todayTransactions: Number(todayTransactionsRows[0]?.total || 0),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getAdminDashboardStats = async (_req, res, next) => {
  try {
    const stats = await buildDashboardStatsResponse()
    return sendSuccess(res, 200, "Admin dashboard stats fetched successfully", stats)
  } catch (error) {
    next(error)
  }
}

export const listDriversByReviewStatus = async (req, res, next) => {
  try {
    const status = String(req.adminReviewStatusOverride || req.query.status || "pending").toLowerCase()
    const allowed = new Set(["pending", "approved", "rejected", "blocked"])
    if (!allowed.has(status)) {
      return next(createError(400, "Invalid review status"))
    }

    const limit = toSafePaginationInt(req.query.limit, 50, 200)
    const offset = toSafePaginationInt(req.query.offset, 0)

    const rows = await exec(
      null,
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture, u.created_at,
              d.review_status, d.review_reason, d.is_documents_verified,
              CASE d.driver_type
                WHEN 'pro_transporter' THEN 'professional'
                ELSE 'normal'
              END AS driver_type
       FROM Drivers d
       INNER JOIN Users u ON u.id = d.participant_id
       WHERE d.review_status = ?
       ORDER BY u.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [status],
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM Drivers d
       WHERE d.review_status = ?`,
      [status],
    )

    return sendSuccess(res, 200, "Drivers fetched successfully", {
      drivers: rows.map(mapDriverReviewRow),
      total: Number(countRows[0]?.total || 0),
      status,
      pagination: {
        limit,
        offset,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listAdminTransactions = async (req, res, next) => {
  try {
    const limit = toSafePaginationInt(req.query.limit, 50, 200)
    const offset = toSafePaginationInt(req.query.offset, 0)
    const period = String(req.query.period || "month").toLowerCase()
    const search = String(req.query.search || "").trim()
    const { start, end } = toPeriodRange(period)
    const searchClause = search
      ? ` AND (
          u.first_name LIKE ? OR
          u.last_name LIKE ? OR
          u.email LIKE ? OR
          pay.transaction_id LIKE ? OR
          pay.method LIKE ? OR
          pay.status LIKE ? OR
          d.id LIKE ?
        )`
      : ""
    const searchParams = search
      ? Array(7).fill(`%${search}%`)
      : []

    const rows = await exec(
      null,
      `SELECT
         pay.id,
         pay.delivery_id,
         pay.method,
         pay.status,
         pay.transaction_id,
         pay.created_at,
         d.requester_id,
         d.assigned_driver_id,
         d.status AS delivery_status,
         d.created_at AS delivery_created_at,
         COALESCE(dp.final_price, dp.price, 0) AS amount,
         COALESCE(dp.final_price, dp.price, 0) * 0.1 AS commission,
         u.first_name AS user_first_name,
         u.last_name AS user_last_name,
         u.email AS user_email
       FROM DeliveryPayments pay
       INNER JOIN Deliveries d ON d.id = pay.delivery_id
       INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       INNER JOIN Users u ON u.id = d.requester_id
       WHERE pay.created_at BETWEEN ? AND ?
       ${searchClause}
       ORDER BY pay.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [start, end, ...searchParams],
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM DeliveryPayments pay
       INNER JOIN Deliveries d ON d.id = pay.delivery_id
       INNER JOIN Users u ON u.id = d.requester_id
       WHERE pay.created_at BETWEEN ? AND ?
       ${searchClause}`,
      [start, end, ...searchParams],
    )

    const totalRows = await exec(
      null,
      `SELECT
         COALESCE(SUM(COALESCE(dp.final_price, dp.price, 0)), 0) AS totalAmount,
         COALESCE(SUM(COALESCE(dp.final_price, dp.price, 0) * 0.1), 0) AS totalCommission
       FROM DeliveryPayments pay
       INNER JOIN Deliveries d ON d.id = pay.delivery_id
       INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       WHERE pay.created_at BETWEEN ? AND ?`,
      [start, end],
    )

    return sendSuccess(res, 200, "Transactions fetched successfully", {
      transactions: rows.map((row) => ({
        id: row.id,
        deliveryId: row.delivery_id,
        user: {
          firstName: row.user_first_name,
          lastName: row.user_last_name,
          email: row.user_email,
        },
        amount: Number(row.amount || 0),
        commission: Number(row.commission || 0),
        method: row.method,
        status: row.status,
        transactionId: row.transaction_id || null,
        date: row.created_at,
        deliveryStatus: row.delivery_status,
      })),
      total: Number(countRows[0]?.total || 0),
      totals: {
        amount: Number(totalRows[0]?.totalAmount || 0),
        commission: Number(totalRows[0]?.totalCommission || 0),
        currency: "DZD",
      },
      period,
      search: search || null,
    })
  } catch (error) {
    next(error)
  }
}

export const getAuthorityDashboardSummary = async (_req, res, next) => {
  try {
    const [
      sensitiveCasesRows,
      driversUnderReviewRows,
      rejectedDriversRows,
      failedDeliveriesRows,
      complaintsRows,
      importantRecordsRows,
    ] = await Promise.all([
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE status IN ('FailedDelivery','Refunded')`),
      exec(null, `SELECT COUNT(*) AS total FROM Drivers WHERE review_status = 'pending'`),
      exec(null, `SELECT COUNT(*) AS total FROM Drivers WHERE review_status = 'rejected'`),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE status = 'FailedDelivery'`),
      exec(null, `SELECT COUNT(*) AS total FROM DeliveryCancellation`),
      exec(null, `SELECT COUNT(*) AS total FROM Notifications WHERE type IN ('delivery_completed','delivery_accepted')`),
    ])

    return sendSuccess(res, 200, "Authority dashboard summary fetched successfully", {
      counts: {
        sensitiveCases: Number(sensitiveCasesRows[0]?.total || 0),
        driversUnderReview: Number(driversUnderReviewRows[0]?.total || 0),
        rejectedDrivers: Number(rejectedDriversRows[0]?.total || 0),
        failedDeliveries: Number(failedDeliveriesRows[0]?.total || 0),
        complaints: Number(complaintsRows[0]?.total || 0),
        importantRecords: Number(importantRecordsRows[0]?.total || 0),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listAuthorityDeliveries = async (req, res, next) => {
  try {
    const limit = toSafePaginationInt(req.query.limit, 50, 200)
    const offset = toSafePaginationInt(req.query.offset ?? ((Number(req.query.page || 1) - 1) * limit), 0)
    const status = req.query.status || null

    let where = "WHERE 1=1"
    const params = []

    if (status) {
      where += " AND d.status = ?"
      params.push(status)
    }

    const rows = await exec(
      null,
      `SELECT d.id, d.status, d.created_at, d.updated_at,
              d.requester_id, d.assigned_driver_id,
              requester.first_name AS requester_first_name,
              requester.last_name AS requester_last_name,
              requester.email AS requester_email,
              requester.phone AS requester_phone,
              driver.first_name AS driver_first_name,
              driver.last_name AS driver_last_name,
              driver.email AS driver_email,
              driver.phone AS driver_phone,
              COALESCE(dp.final_price, dp.price, 0) AS price,
              dp.currency AS currency,
              pickup.address AS pickup_address,
              dropoff.address AS dropoff_address
       FROM Deliveries d
       INNER JOIN Users requester ON requester.id = d.requester_id
       LEFT JOIN Users driver ON driver.id = d.assigned_driver_id
       LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       LEFT JOIN DeliveryLocations pickup ON pickup.delivery_id = d.id AND pickup.type = 'PICKUP'
       LEFT JOIN DeliveryLocations dropoff ON dropoff.delivery_id = d.id AND dropoff.type = 'DROPOFF'
       ${where}
       ORDER BY d.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total FROM Deliveries d ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Deliveries fetched successfully", {
      deliveries: rows.map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        price: Number(row.price || 0),
        currency: row.currency || "DZD",
        requester: {
          id: row.requester_id,
          firstName: row.requester_first_name,
          lastName: row.requester_last_name,
          email: row.requester_email,
          phone: row.requester_phone,
        },
        sender: {
          id: row.requester_id,
          firstName: row.requester_first_name,
          lastName: row.requester_last_name,
          email: row.requester_email,
          phone: row.requester_phone,
        },
        assignedDriver: row.assigned_driver_id
          ? {
              id: row.assigned_driver_id,
              firstName: row.driver_first_name,
              lastName: row.driver_last_name,
              email: row.driver_email,
              phone: row.driver_phone,
            }
          : null,
        pickup: { address: row.pickup_address || "" },
        dropoff: { address: row.dropoff_address || "" },
        pricing: { finalPrice: Number(row.price || 0), currency: row.currency || "DZD" },
      })),
      total: Number(countRows[0]?.total || 0),
      pagination: { limit, offset },
    })
  } catch (error) {
    next(error)
  }
}

export const getSettings = async (req, res, next) => {
  try {
    const settings = await listAllSettings(null)
    return sendSuccess(res, 200, "Settings retrieved", settings)
  } catch (error) {
    next(error)
  }
}

export const updateSetting = async (req, res, next) => {
  try {
    const { key } = req.params
    const { value } = req.body
    if (value === undefined || value === null) {
      return next(createError(400, "value is required"))
    }
    const setting = await upsertSetting(null, key, value)
    return sendSuccess(res, 200, "Setting updated", setting)
  } catch (error) {
    next(error)
  }
}


