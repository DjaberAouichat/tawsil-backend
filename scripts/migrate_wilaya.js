import dotenv from "dotenv"
import mysql from "mysql2/promise"
import path from "path"
import { fileURLToPath } from "url"

const currentFilePath = fileURLToPath(import.meta.url)
const currentDir = path.dirname(currentFilePath)

dotenv.config({ path: path.join(currentDir, ".env") })
dotenv.config({ path: path.resolve(currentDir, "..", ".env"), override: false })

const extractWilaya = (address) => {
  if (!address) return null
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || null
}

const migrate = async () => {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "tawsil_db",
  })

  try {
    const [colRows] = await connection.execute(
      `SHOW COLUMNS FROM Deliveries LIKE 'pickup_wilaya'`,
    )
    if (colRows.length === 0) {
      await connection.execute(
        `ALTER TABLE Deliveries
         ADD COLUMN pickup_wilaya VARCHAR(100) DEFAULT NULL AFTER delivery_mode,
         ADD COLUMN dropoff_wilaya VARCHAR(100) DEFAULT NULL AFTER pickup_wilaya`,
      )
      console.log("Added pickup_wilaya / dropoff_wilaya columns.")
    }

    const [rows] = await connection.execute(
      `SELECT d.id, pl.address AS pickup_address, dl.address AS dropoff_address
       FROM Deliveries d
       LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'
       LEFT JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
       WHERE d.pickup_wilaya IS NULL`,
    )

    let updated = 0
    for (const row of rows) {
      const pickupWilaya = extractWilaya(row.pickup_address)
      const dropoffWilaya = extractWilaya(row.dropoff_address)
      if (pickupWilaya || dropoffWilaya) {
        await connection.execute(
          `UPDATE Deliveries SET pickup_wilaya = ?, dropoff_wilaya = ? WHERE id = ?`,
          [pickupWilaya, dropoffWilaya, row.id],
        )
        updated++
      }
    }

    console.log(`Migration complete. Updated ${updated} / ${rows.length} deliveries.`)
  } finally {
    await connection.end()
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err)
  process.exit(1)
})
