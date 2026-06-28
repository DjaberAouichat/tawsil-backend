import { Server as SocketServer } from "socket.io"
import jwt from "jsonwebtoken"
import crypto from "crypto"
import { findUserById, getUserRole } from "../models/user.model.js"
import { exec } from "../lib/db.js"

let io = null

const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
    if (!token) {
      return next(new Error("Authentication required"))
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await findUserById(null, decoded.id)

    if (!user || user.isBlocked || user.isSuspended) {
      return next(new Error("Access denied"))
    }

    const dbRole = await getUserRole(null, user.id)
    socket.userId = user.id
    socket.userRole = dbRole || decoded.role

    next()
  } catch (error) {
    next(new Error("Invalid token"))
  }
}

const parseSocketOrigins = () => {
  if (process.env.NODE_ENV !== 'production') return "*"
  const raw = String(process.env.CORS_ALLOWED_ORIGINS || "").trim()
  if (!raw) return false
  const origins = raw.split(",").map((s) => s.trim()).filter(Boolean)
  return origins.length > 0 ? origins : false
}

export const initSocket = (httpServer) => {
  io = new SocketServer(httpServer, {
    cors: {
      origin: parseSocketOrigins(),
      methods: ["GET", "POST"],
    },
  })

  io.use(authenticateSocket)

  io.on("connection", (socket) => {
    const room = `user:${socket.userId}`
    socket.join(room)

    if (socket.userRole === "admin" || socket.userRole === "authority") {
      socket.join("admin")
    }

    if (socket.userRole === "client") {
      socket.join(`client:${socket.userId}`)
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[socket] User ${socket.userId} connected (role: ${socket.userRole})`)
    }

    socket.on("driver:location_update", async (payload) => {
      try {
        const { lat, lng, accuracy, heading, speed } = payload || {}

        const accuracyNum = typeof accuracy === "number" ? accuracy : 999

        // Hard‑reject only if accuracy >= 200 or coords outside Algeria
        if (accuracyNum >= 200) {
          socket.emit("location:low_accuracy", { accuracy: accuracyNum })
          return
        }

        if (typeof lat !== "number" || typeof lng !== "number" ||
            lat < 18 || lat > 38 || lng < -9 || lng > 12) {
          socket.emit("location:low_accuracy", { accuracy: accuracyNum })
          return
        }

        const isLowAccuracy = accuracyNum >= 100
        const id = crypto.randomUUID()
        const h = heading != null ? heading : null
        const s = speed != null ? speed : null

        await exec(
          null,
          `INSERT INTO DriverLocationHistory (id, driver_id, latitude, longitude, accuracy, heading, speed)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, socket.userId, lat, lng, accuracyNum, h, s],
        )

        await exec(
          null,
          `INSERT INTO DriverLocation (driver_id, latitude, longitude, accuracy, heading, speed)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             latitude = VALUES(latitude),
             longitude = VALUES(longitude),
             accuracy = VALUES(accuracy),
             heading = VALUES(heading),
             speed = VALUES(speed),
             \`timestamp\` = CURRENT_TIMESTAMP`,
          [socket.userId, lat, lng, accuracyNum, h, s],
        )

        await exec(
          null,
          `DELETE FROM DriverLocationHistory
           WHERE driver_id = ? AND id NOT IN (
             SELECT id FROM (
               SELECT id FROM DriverLocationHistory
               WHERE driver_id = ?
               ORDER BY timestamp DESC
               LIMIT 100
             ) AS keep
           )`,
          [socket.userId, socket.userId],
        )

        if (!isLowAccuracy) {
          io.to("admin").emit("driver:location_high_accuracy", {
            driverId: socket.userId,
            lat,
            lng,
            accuracy: accuracyNum,
            heading: h,
            speed: s,
            timestamp: new Date().toISOString(),
          })
        }

        // Broadcast to clients watching this driver's active deliveries
        try {
          const activeRows = await exec(
            null,
            `SELECT id, requester_id FROM Deliveries
             WHERE assigned_driver_id = ?
               AND status IN ('Accepted','DriverArrivedPickup','PickedUp','InTransit','ArrivedDropoff')`,
            [socket.userId],
          )
          for (const row of activeRows) {
            io.to(`client:${row.requester_id}`).emit("delivery:driver_location", {
              deliveryId: row.id,
              coordinates: [lng, lat],
              heading: h,
              speed: s,
              accuracy: accuracyNum,
              isLowAccuracy,
              timestamp: new Date().toISOString(),
            })
          }
        } catch (broadcastErr) {
          if (process.env.NODE_ENV !== 'production') {
            console.error("[socket] Broadcast delivery:driver_location error:", broadcastErr)
          }
        }

        socket.emit("location:confirmed", { accuracy: accuracyNum })
      } catch (error) {
        console.error("[socket] driver:location_update error:", error)
        socket.emit("location:low_accuracy", { accuracy: payload?.accuracy })
      }
    })

    socket.on("disconnect", (reason) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[socket] User ${socket.userId} disconnected (${reason})`)
      }
    })
  })

  if (process.env.NODE_ENV !== 'production') {
    console.log("[socket] Socket.IO initialized")
  }
  return io
}

export const emitToUser = (userId, event, data) => {
  if (!io) {
    console.warn("[socket] Socket.IO not initialized, cannot emit")
    return
  }
  io.to(`user:${userId}`).emit(event, data)
}

export const emitToAll = (event, data) => {
  if (!io) {
    console.warn("[socket] Socket.IO not initialized, cannot emit")
    return
  }
  io.emit(event, data)
}

export const getIO = () => io
