/**
 * Tawsil — Script de seed complet
 * Données réalistes algériennes en grande quantité.
 * Usage : node scripts/seed.js
 */

import dotenv from "dotenv"
import fs from "fs/promises"
import path from "path"
import mysql from "mysql2/promise"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { fileURLToPath } from "url"

const currentFilePath = fileURLToPath(import.meta.url)
const currentDir = path.dirname(currentFilePath)
const workspaceEnvPath = path.resolve(currentDir, "..", ".env")

dotenv.config({ path: path.join(currentDir, ".env") })
dotenv.config({ path: workspaceEnvPath, override: false })

// ─── Connexion ──────────────────────────────────────────────────────────────
const MYSQL_HOST = String(process.env.MYSQL_HOST || "localhost").trim()
const MYSQL_PORT = Number.parseInt(String(process.env.MYSQL_PORT || "3306"), 10) || 3306
const MYSQL_USER = String(process.env.MYSQL_USER || "root").trim()
const MYSQL_PASSWORD = String(process.env.MYSQL_PASSWORD || "")
const MYSQL_DATABASE = String(process.env.MYSQL_DATABASE || "crowdshipping_db").trim()

const createDatabaseIfNeeded = async () => {
  const bootstrapConn = await mysql.createConnection({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
  })
  try {
    await bootstrapConn.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally {
    await bootstrapConn.end()
  }
}

await createDatabaseIfNeeded()

const conn = await mysql.createConnection({
  host: MYSQL_HOST,
  port: MYSQL_PORT,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  multipleStatements: true,
})

const q = (sql, params = []) => conn.execute(sql, params)
const uid = () => crypto.randomUUID()

const applySchemaIfNeeded = async () => {
  const schemaPath = path.resolve(currentDir, "..", "db.sql")
  let schema = await fs.readFile(schemaPath, "utf8")
  schema = schema.replace(/\r\n/g, "\n")
  schema = schema.replace(/^\s*--.*$/gm, "")
  schema = schema.replace(/\bCREATE\s+DATABASE\b[\s\S]*?;\s*/gi, "")
  schema = schema.replace(/\bUSE\s+`?\w+`?\s*;\s*/gi, "")
  schema = schema.replace(/\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE TABLE ")

  const statements = schema.split(";").map(chunk => chunk.trim()).filter(chunk => chunk.length > 0).map(chunk => `${chunk};`)
  if (statements.length === 0) throw new Error("Schema file is empty after cleaning")

  try {
    for (const statement of statements) {
      try {
        await conn.query(statement)
      } catch (error) {
        const code = error?.code
        if (code === "ER_TABLE_EXISTS_ERROR" || code === "ER_DUP_KEYNAME" || code === "ER_DUP_FIELDNAME") continue
        throw error
      }
    }
  } catch (error) {
    console.error("❌ Échec application du schéma", error)
    throw error
  }
}

const addColumnIfMissing = async (table, column, definition) => {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  )
  if (Number(rows?.[0]?.count || 0) === 0) {
    const safeTable = table.replace(/`/g, "``")
    const safeColumn = column.replace(/`/g, "``")
    await conn.query(`ALTER TABLE \`${safeTable}\` ADD COLUMN \`${safeColumn}\` ${definition}`)
  }
}

const ensureReviewSchema = async () => {
  await addColumnIfMissing("Drivers", "review_reason", "TEXT NULL")
  await addColumnIfMissing("Drivers", "reviewed_by", "VARCHAR(36) NULL")
  await addColumnIfMissing("Drivers", "reviewed_at", "DATETIME NULL")
  await addColumnIfMissing("Documents", "review_reason", "TEXT NULL")
  await addColumnIfMissing("Documents", "reviewed_by", "VARCHAR(36) NULL")
  await addColumnIfMissing("Documents", "reviewed_at", "DATETIME NULL")
}

const ts = (days = 0, hours = 0, minutes = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(d.getHours() + hours)
  d.setMinutes(d.getMinutes() + minutes)
  return d.toISOString().slice(0, 19).replace("T", " ")
}

// ─── Mots de passe ──────────────────────────────────────────────────────────
const PASS = {
  admin: "adminadmin",
  auth: "Auth@Tawsil2026",
  driver: "Driver@Tawsil2026",
  user: "User@Tawsil2026",
}

console.log("🔐 Hachage des mots de passe…")
const [hAdmin, hAuth, hDriver, hUser] = await Promise.all([
  bcrypt.hash(PASS.admin, 10),
  bcrypt.hash(PASS.auth, 10),
  bcrypt.hash(PASS.driver, 10),
  bcrypt.hash(PASS.user, 10),
])

// ─── IDs préfixés pour organisation ─────────────────────────────────────────
const ID = {
  // Admins & authorities
  admin1: uid(), admin2: uid(), admin3: uid(),
  authority1: uid(), authority2: uid(), authority3: uid(),
  // Drivers (20)
  drv: Array.from({ length: 20 }, () => uid()),
  // Requesters (50)
  req: Array.from({ length: 50 }, () => uid()),
  // Véhicules (1 par driver)
  veh: Array.from({ length: 20 }, () => uid()),
  // Documents (2 par driver)
  doc: Array.from({ length: 40 }, () => uid()),
  // Trips (50)
  trip: Array.from({ length: 50 }, () => uid()),
  // Deliveries (200)
  delivery: Array.from({ length: 200 }, () => uid()),
}

// ─── Nettoyage complet (ordre inverse FK) ───────────────────────────────────
console.log("🗑  Nettoyage des données existantes…")
console.log("🧱 Vérification/initialisation du schéma…")
await applySchemaIfNeeded()
await ensureReviewSchema()

const TABLES = [
  "AuthorityComplianceReports", "AuthorityComplaints", "AuthorityIncidents",
  "DriverVerificationTimeline", "Notifications", "Rates", "DriverLocation",
  "DeliveryCancellation", "DeliveryTimeline", "DeliveryPayments", "DeliveryPricing",
  "DeliveryProofs", "DeliveryOtps", "DeliveryRejections", "DeliveryLocations",
  "Deliveries", "TripLocations", "Trips", "Documents", "Vehicles", "Drivers",
  "Requesters", "Participants", "Admins", "Authorities", "UserTokens", "Users",
]
for (const t of TABLES) {
  await conn.query(`DELETE FROM \`${t}\``)
}

// ════════════════════════════════════════════════════════════════════════════
// 1. USERS
// ════════════════════════════════════════════════════════════════════════════
console.log("👤 Insertion des utilisateurs (admins, authorities, drivers, requesters)…")

// Admins
const admins = [
  [ID.admin1, "Mourad", "Benhedda", "admin@tawsil.dz", hAdmin, "0550001000", 1],
  [ID.admin2, "Salima", "Khelladi", "admin2@tawsil.dz", hAdmin, "0550001002", 1],
  [ID.admin3, "Rachid", "Boudiaf", "admin3@tawsil.dz", hAdmin, "0550001003", 1],
]
// Authorities
const authorities = [
  [ID.authority1, "Nassima", "Hadjadj", "autorite@tawsil.dz", hAuth, "0550001001", 1],
  [ID.authority2, "Ahmed", "Benali", "autorite2@tawsil.dz", hAuth, "0550001004", 1],
  [ID.authority3, "Fatima", "Zerrouki", "autorite3@tawsil.dz", hAuth, "0550001005", 1],
]

// Drivers (20) – noms réalistes
const driverNames = [
  "Karim Benali", "Youcef Mammeri", "Sofiane Khelifi", "Farid Meziane", "Rachid Amara",
  "Hakim Boudiaf", "Lyes Hamdani", "Mounir Chaouche", "Tahar Ouali", "Nabil Benmoussa",
  "Djamel Berrah", "Réda Kaci", "Fouad Mansouri", "Slimane Boucherit", "Idir Aït Menguellet",
  "Mohamed Khelif", "Yacine Sadi", "Hocine Meddah", "Abdelkader Derradji", "Mustapha Brakni"
]
const driverPhones = [
  "0661100001", "0661100002", "0661100003", "0661100004", "0661100005",
  "0661100006", "0661100007", "0661100008", "0661100009", "0661100010",
  "0661100011", "0661100012", "0661100013", "0661100014", "0661100015",
  "0661100016", "0661100017", "0661100018", "0661100019", "0661100020",
]
const drivers = driverNames.map((name, idx) => {
  const [firstName, lastName] = name.split(" ")
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@tawsil.dz`
  return [ID.drv[idx], firstName, lastName, email, hDriver, driverPhones[idx], 1]
})

// Requesters (50) – noms et emails générés
const requesterNames = [
  "Amina Boudiaf", "Mohamed Chouiref", "Rania Boukhalfa", "Hamza Slimani", "Nadia Bensalem",
  "Omar Tahir", "Leila Kaci", "Bilal Mansouri", "Sara Zerrouki", "Yasmine Bouguerra",
  "Karim Laouar", "Assia Medjber", "Zineddine Belkaïd", "Meriem Chebbi", "Fares Amrani",
  "Lilia Gherbi", "Islem Hamzaoui", "Chahinez Ait", "Mehdi Ziani", "Ines Djerradi",
  "Samir Bouhired", "Nour Hacene", "Amira Tadjer", "Youcef Djenadi", "Sabrina Ouyahia",
  "Ryad Khellaf", "Nabila Boudinar", "Fayçal Mebarki", "Djahida Said", "Adel Kherbouche",
  "Maya Lounis", "Yanis Benkhodja", "Siham Aouadi", "Ilyes Malki", "Nawel Djebbari",
  "Sofiane Benlazar", "Latifa Metref", "Hicham Belouizdad", "Kenza Sahnoun", "Wassim Haddad",
  "Meriem Boudraa", "Rayane Benmoussa", "Louisa Chaabane", "Skander Bouzid", "Rim Maouche",
  "Walid Hamouma", "Yasmine Ould", "Lotfi Belhadj", "Houda Aït", "Azzedine Derbal"
]
const requesterPhones = Array.from({ length: 50 }, (_, i) => `077020${String(i + 1).padStart(4, "0")}`)
const requesters = requesterNames.map((name, idx) => {
  const [firstName, lastName] = name.split(" ")
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@gmail.com`
  return [ID.req[idx], firstName, lastName, email, hUser, requesterPhones[idx], 1]
})

const allUsers = [...admins, ...authorities, ...drivers, ...requesters]
for (const u of allUsers) {
  await q(
    `INSERT INTO Users (id, first_name, last_name, email, password, phone, is_email_verified, is_onboarded)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    u
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 2. RÔLES
// ════════════════════════════════════════════════════════════════════════════
for (const admin of [ID.admin1, ID.admin2, ID.admin3]) await q(`INSERT INTO Admins (user_id) VALUES (?)`, [admin])
for (const auth of [ID.authority1, ID.authority2, ID.authority3]) await q(`INSERT INTO Authorities (user_id) VALUES (?)`, [auth])

// ════════════════════════════════════════════════════════════════════════════
// 3. PARTICIPANTS
// ════════════════════════════════════════════════════════════════════════════
const participantIds = [...ID.drv, ...ID.req]
for (const pid of participantIds) await q(`INSERT INTO Participants (user_id) VALUES (?)`, [pid])

// ════════════════════════════════════════════════════════════════════════════
// 4. REQUESTERS
// ════════════════════════════════════════════════════════════════════════════
for (const rid of ID.req) await q(`INSERT INTO Requesters (participant_id) VALUES (?)`, [rid])

// ════════════════════════════════════════════════════════════════════════════
// 5. DRIVERS + VEHICULES + DOCUMENTS
// ════════════════════════════════════════════════════════════════════════════
console.log("🚗 Insertion des chauffeurs, véhicules et documents…")
const driverInfos = [
  ["16-000111-B", "2027-06-30", "CIN160111", 1, 1, "available", 4.8],
  ["25-000222-B", "2026-12-31", "CIN250222", 1, 1, "busy", 4.6],
  ["09-000333-B", "2028-03-15", "CIN090333", 1, 1, "available", 4.9],
  ["31-000444-B", "2026-08-20", "CIN310444", 1, 0, "offline", 4.3],
  ["19-000555-B", "2027-11-10", "CIN190555", 1, 1, "available", 4.7],
  ["22-000666-B", "2028-01-20", "CIN220666", 1, 1, "available", 4.5],
  ["37-000777-B", "2027-05-15", "CIN370777", 1, 1, "busy", 4.4],
  ["42-000888-B", "2029-02-28", "CIN420888", 1, 1, "available", 4.9],
  ["05-000999-B", "2026-11-30", "CIN050999", 1, 0, "offline", 4.2],
  ["13-001000-B", "2027-09-10", "CIN131000", 1, 1, "available", 4.6],
  ["18-001111-B", "2028-04-25", "CIN181111", 1, 1, "available", 4.8],
  ["21-001222-B", "2026-12-01", "CIN211222", 1, 1, "busy", 4.5],
  ["34-001333-B", "2027-07-19", "CIN341333", 1, 1, "available", 4.7],
  ["45-001444-B", "2028-10-11", "CIN451444", 1, 0, "offline", 4.3],
  ["56-001555-B", "2029-01-05", "CIN561555", 1, 1, "available", 4.9],
  ["67-001666-B", "2027-03-22", "CIN671666", 1, 1, "available", 4.4],
  ["78-001777-B", "2028-06-14", "CIN781777", 1, 1, "busy", 4.6],
  ["89-001888-B", "2026-09-30", "CIN891888", 1, 0, "offline", 4.2],
  ["90-001999-B", "2027-12-12", "CIN901999", 1, 1, "available", 4.8],
  ["11-002000-B", "2028-08-08", "CIN112000", 1, 1, "available", 4.7],
]
for (let i = 0; i < 20; i++) {
  const d = driverInfos[i]
  await q(
    `INSERT INTO Drivers (participant_id, license_number, license_expiry, id_card,
      is_documents_verified, is_available, availability, rating, review_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
    [ID.drv[i], d[0], d[1], d[2], d[3], d[4], d[5], d[6]]
  )
}

// Véhicules
const vehicleModels = [
  ["Renault", "Symbol", 2020, "Blanc", "16-112233-A", "ASS-ALG-001", "2026-06-30", "standard"],
  ["Mercedes", "Sprinter", 2019, "Gris", "25-445566-B", "ASS-CST-002", "2026-12-31", "van"],
  ["Toyota", "Corolla", 2022, "Noir", "09-778899-C", "ASS-BLI-003", "2028-03-10", "comfort"],
  ["Peugeot", "301", 2018, "Rouge", "31-223344-D", "ASS-ORA-004", "2026-08-20", "standard"],
  ["Kia", "Sportage", 2021, "Bleu", "19-556677-E", "ASS-SET-005", "2027-11-05", "premium"],
  ["Ford", "Focus", 2020, "Gris", "22-667788-F", "ASS-ALG-006", "2027-04-01", "standard"],
  ["Hyundai", "i20", 2021, "Blanc", "37-778899-G", "ASS-BLI-007", "2027-10-15", "standard"],
  ["Volkswagen", "Caddy", 2020, "Noir", "42-889900-H", "ASS-CST-008", "2028-01-20", "van"],
  ["Renault", "Clio", 2022, "Rouge", "05-990011-I", "ASS-ORA-009", "2027-09-09", "standard"],
  ["Peugeot", "Partner", 2019, "Blanc", "13-001122-J", "ASS-SET-010", "2026-12-01", "van"],
  ["Toyota", "Hilux", 2021, "Argent", "18-112233-K", "ASS-ALG-011", "2028-05-05", "premium"],
  ["Ford", "Transit", 2020, "Blanc", "21-223344-L", "ASS-CST-012", "2027-08-18", "van"],
  ["Hyundai", "Kona", 2022, "Bleu", "34-334455-M", "ASS-BLI-013", "2028-11-22", "comfort"],
  ["Kia", "Carnival", 2020, "Noir", "45-445566-N", "ASS-ORA-014", "2027-04-30", "van"],
  ["Renault", "Kangoo", 2021, "Gris", "56-556677-O", "ASS-SET-015", "2028-03-15", "van"],
  ["Mercedes", "Vito", 2019, "Blanc", "67-667788-P", "ASS-ALG-016", "2026-10-10", "van"],
  ["Volkswagen", "Amarok", 2021, "Noir", "78-778899-Q", "ASS-CST-017", "2028-07-07", "premium"],
  ["Peugeot", "Expert", 2020, "Gris", "89-889900-R", "ASS-BLI-018", "2027-12-20", "van"],
  ["Toyota", "Land Cruiser", 2022, "Rouge", "90-990011-S", "ASS-ORA-019", "2029-01-01", "premium"],
  ["Fiat", "Doblo", 2020, "Bleu", "11-001122-T", "ASS-SET-020", "2027-11-11", "standard"],
]
for (let i = 0; i < 20; i++) {
  const v = vehicleModels[i]
  await q(
    `INSERT INTO Vehicles (id, driver_id, make, model, year, color, license_plate,
      insurance_number, insurance_expiry, type, is_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [ID.veh[i], ID.drv[i], v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]]
  )
}

// Documents (2 par driver)
for (let i = 0; i < 20; i++) {
  const dId1 = ID.doc[i * 2]
  const dId2 = ID.doc[i * 2 + 1]
  await q(
    `INSERT INTO Documents (id, driver_id, document_type, document_url, expiry_date, is_verified)
     VALUES (?, ?, 'LICENSE', ?, ?, 1)`,
    [dId1, ID.drv[i], `https://cdn.tawsil.dz/docs/drv${i+1}-license.pdf`, driverInfos[i][1]]
  )
  await q(
    `INSERT INTO Documents (id, driver_id, document_type, document_url, expiry_date, is_verified)
     VALUES (?, ?, 'ID_CARD', ?, NULL, 1)`,
    [dId2, ID.drv[i], `https://cdn.tawsil.dz/docs/drv${i+1}-cin.pdf`]
  )
}

// Driver locations (pour ceux en ligne)
const onlineDrivers = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19] // presque tous
for (const i of onlineDrivers) {
  const lat = 36.2 + (i * 0.05)
  const lng = 2.4 + (i * 0.03)
  await q(
    `INSERT INTO DriverLocation (driver_id, latitude, longitude, heading, speed, timestamp)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE latitude = VALUES(latitude), longitude = VALUES(longitude), heading = VALUES(heading), speed = VALUES(speed), timestamp = CURRENT_TIMESTAMP`,
    [ID.drv[i], lat, lng, (i * 15) % 360, 50 + (i % 50)]
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 6. TRIPS (50)
// ════════════════════════════════════════════════════════════════════════════
console.log("🗺  Insertion des trajets…")
const cities = [
  "Alger", "Oran", "Constantine", "Annaba", "Blida", "Sétif", "Batna", "Tizi Ouzou",
  "Tlemcen", "Béjaïa", "Biskra", "Djelfa", "Guelma", "Jijel", "Laghouat", "Mascara",
  "Médéa", "Mostaganem", "M'sila", "Ouargla", "Sidi Bel Abbès", "Skikda", "Souk Ahras",
  "Tiaret", "Tindouf", "Tissemsilt", "Tizi", "Tolga", "Touggourt", "Tébessa"
]
const statuses = ["planned", "active", "completed", "cancelled"]
for (let i = 0; i < 50; i++) {
  const driverIdx = i % 20
  const startCity = cities[i % cities.length]
  const endCity = cities[(i + 13) % cities.length]
  const startDate = ts(-30 + (i % 60), 8 + (i % 10), 0)
  const endDate = ts(-30 + (i % 60) + 1, 18, 0)
  const maxDel = 3 + (i % 5)
  const availCap = (statuses[i % 4] === "completed" || statuses[i % 4] === "cancelled") ? 0 : (maxDel - (i % (maxDel+1)))
  const status = statuses[i % 4]
  const title = `${startCity} → ${endCity}`
  await q(
    `INSERT INTO Trips (id, driver_id, title, departure_time, expected_arrival_time,
      max_deliveries, available_capacity, vehicle_type, accepted_package_size, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'any', ?, ?)`,
    [ID.trip[i], ID.drv[driverIdx], title, startDate, endDate, maxDel, availCap, "standard", status, "Trajet régulier"]
  )
  // Ajouter les localisations
  const startLat = 36.2 + (i % 3)
  const startLng = 2.4 + (i % 5)
  const endLat = 35.5 + (i % 4)
  const endLng = 0.5 + (i % 7)
  await q(
    `INSERT INTO TripLocations (id, trip_id, type, address, latitude, longitude)
     VALUES (?, ?, 'START', ?, ?, ?)`,
    [uid(), ID.trip[i], `Gare de ${startCity}`, startLat, startLng]
  )
  await q(
    `INSERT INTO TripLocations (id, trip_id, type, address, latitude, longitude)
     VALUES (?, ?, 'END', ?, ?, ?)`,
    [uid(), ID.trip[i], `Gare de ${endCity}`, endLat, endLng]
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 7. DELIVERIES (200)
// ════════════════════════════════════════════════════════════════════════════
console.log("📦 Insertion des livraisons…")

const packageTypes = ["Électronique", "Vêtements", "Documents", "Alimentaire", "Livres", "Bijoux", "Médicaments", "Cadeaux", "Pièces auto", "Cosmétiques"]
const sizeCategories = ["small", "medium", "large", "xlarge"]
const weightCategories = ["SMALL", "MEDIUM", "LARGE", "XLARGE"]
const deliveryStatuses = ["Pending", "Accepted", "DriverArrivedPickup", "PickedUp", "InTransit", "ArrivedDropoff", "Delivered", "CancelledByUser", "CancelledByDriver", "FailedDelivery", "Refunded"]
const paymentMethods = ["card", "cash", "paypal"]

const insertDelivery = async (data) => {
  const { id, requesterId, driverId, tripId, pkgType, pkgDesc, pkgSize, pkgWeight, weightKg, isUrgent,
    recipientName, recipientPhone, note, status, capacityReserved, pickup, dropoff,
    baseFee, distanceFee, weightSurcharge, sizeSurcharge, urgentSurcharge,
    price, finalPrice, currency, payMethod, payStatus, timeline, proof, cancellation, otp } = data
  await q(
    `INSERT INTO Deliveries (id, requester_id, assigned_driver_id, trip_id, package_type, package_description,
      package_weight_category, package_size_category, package_weight_kg, capacity_reserved, is_urgent,
      recipient_name, recipient_phone, delivery_note, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, requesterId, driverId, tripId, pkgType, pkgDesc, pkgWeight, pkgSize, weightKg, capacityReserved, isUrgent ? 1 : 0,
     recipientName, recipientPhone, note, status]
  )
  await q(`INSERT INTO DeliveryLocations (id, delivery_id, type, address, latitude, longitude) VALUES (?, ?, 'PICKUP', ?, ?, ?)`, [uid(), id, pickup.address, pickup.lat, pickup.lng])
  await q(`INSERT INTO DeliveryLocations (id, delivery_id, type, address, latitude, longitude) VALUES (?, ?, 'DROPOFF', ?, ?, ?)`, [uid(), id, dropoff.address, dropoff.lat, dropoff.lng])
  await q(`INSERT INTO DeliveryPricing (id, delivery_id, base_fee, distance_fee, weight_surcharge, size_surcharge, urgent_surcharge, price, final_price, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uid(), id, baseFee, distanceFee, weightSurcharge, sizeSurcharge, urgentSurcharge, price, finalPrice, currency])
  await q(`INSERT INTO DeliveryPayments (id, delivery_id, method, status) VALUES (?, ?, ?, ?)`, [uid(), id, payMethod, payStatus])
  await q(`INSERT INTO DeliveryTimeline (id, delivery_id, accepted_at, driver_arrived_pickup_at, picked_up_at, in_transit_at, arrived_dropoff_at, delivered_at, cancelled_at, failed_at, refunded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uid(), id, timeline.accepted, timeline.arrivedPickup, timeline.pickedUp, timeline.inTransit, timeline.arrivedDropoff, timeline.delivered, timeline.cancelled, timeline.failed, timeline.refunded])
  if (proof) {
    await q(`INSERT INTO DeliveryProofs (id, delivery_id, photo_url, recipient_name, recipient_signature, notes, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [uid(), id, proof.photoUrl, proof.recipientName, proof.signature, proof.notes, proof.confirmedAt])
  }
  if (cancellation) {
    await q(`INSERT INTO DeliveryCancellation (id, delivery_id, cancelled_by_user_id, cancelled_by_driver_id, reason, cancelled_at) VALUES (?, ?, ?, ?, ?, ?)`, [uid(), id, cancellation.userId, cancellation.driverId, cancellation.reason, cancellation.at])
  }
  if (otp) {
    await q(`INSERT INTO DeliveryOtps (id, delivery_id, otp_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)`, [uid(), id, otp.hash, otp.expires])
  }
}

// Créer 200 livraisons
for (let i = 0; i < 200; i++) {
  const reqIdx = i % ID.req.length
  const driverIdx = (i % 20)
  const tripIdx = i % ID.trip.length
  const statusIdx = i % deliveryStatuses.length
  const isDelivered = deliveryStatuses[statusIdx] === "Delivered"
  const isCancelled = deliveryStatuses[statusIdx] === "CancelledByUser" || deliveryStatuses[statusIdx] === "CancelledByDriver"
  const isFailed = deliveryStatuses[statusIdx] === "FailedDelivery"
  const isRefunded = deliveryStatuses[statusIdx] === "Refunded"
  const hasProof = isDelivered
  const hasCancellation = isCancelled
  const hasOtp = isDelivered && i % 2 === 0

  const pkgType = packageTypes[i % packageTypes.length]
  const pkgSize = sizeCategories[i % sizeCategories.length]
  const pkgWeightCat = weightCategories[i % weightCategories.length]
  const weightKg = [0.5, 2, 5, 10, 15][i % 5]
  const isUrgent = i % 7 === 0
  const baseFee = 300
  const distanceFee = (i % 10 + 1) * 50
  const weightSurcharge = weightKg * 30
  const sizeSurcharge = [0, 50, 100, 150][i % 4]
  const urgentSurcharge = isUrgent ? 200 : 0
  const price = baseFee + distanceFee + weightSurcharge + sizeSurcharge + urgentSurcharge
  const finalPrice = isDelivered ? price + (i % 3 - 1) * 10 : null
  const payMethod = paymentMethods[i % 3]
  const payStatus = isDelivered ? (payMethod === "cash" ? "cash_received" : "completed") : (isCancelled ? "failed" : "pending")

  const pickup = { address: `${cities[i % cities.length]} Centre`, lat: 36.2 + (i % 5), lng: 2.4 + (i % 7) }
  const dropoff = { address: `${cities[(i+7) % cities.length]} Sud`, lat: 35.5 + (i % 5), lng: 0.5 + (i % 9) }

  const timeline = {
    accepted: null, arrivedPickup: null, pickedUp: null, inTransit: null,
    arrivedDropoff: null, delivered: null, cancelled: null, failed: null, refunded: null
  }
  let proof = null
  let cancellation = null
  let otp = null

  if (statusIdx >= 1 && statusIdx <= 6) { // Accepted -> ArrivedDropoff
    timeline.accepted = ts(-5 + (i % 5), 9, 0)
    if (statusIdx >= 2) timeline.arrivedPickup = ts(-5 + (i % 5), 10, 0)
    if (statusIdx >= 3) timeline.pickedUp = ts(-5 + (i % 5), 10, 30)
    if (statusIdx >= 4) timeline.inTransit = ts(-5 + (i % 5), 11, 0)
    if (statusIdx >= 5) timeline.arrivedDropoff = ts(-4 + (i % 5), 14, 0)
    if (statusIdx >= 6) timeline.delivered = ts(-4 + (i % 5), 14, 30)
  }
  if (isDelivered) {
    timeline.delivered = ts(-2 + (i % 5), 15, 0)
    proof = {
      photoUrl: `https://cdn.tawsil.dz/proofs/delivery_${i}.jpg`,
      recipientName: `Client_${i}`,
      signature: `https://cdn.tawsil.dz/proofs/sig_${i}.png`,
      notes: "Reçu en bon état",
      confirmedAt: timeline.delivered
    }
  }
  if (isCancelled) {
    timeline.cancelled = ts(-3 + (i % 4), 12, 0)
    cancellation = {
      userId: (i % 2 === 0) ? ID.req[reqIdx] : null,
      driverId: (i % 2 === 1) ? ID.drv[driverIdx] : null,
      reason: "Annulation pour raison personnelle",
      at: timeline.cancelled
    }
  }
  if (isFailed) {
    timeline.failed = ts(-1, 16, 0)
  }
  if (isRefunded) {
    timeline.refunded = ts(0, 10, 0)
  }
  if (hasOtp) {
    const plainOtp = String(100000 + Math.floor(Math.random() * 900000))
    const otpHash = await bcrypt.hash(plainOtp, 10)
    const expires = ts(0, 24, 0) // expire demain
    otp = { hash: otpHash, expires }
  }

  await insertDelivery({
    id: ID.delivery[i],
    requesterId: ID.req[reqIdx],
    driverId: (statusIdx > 0 && !isCancelled && !isFailed && statusIdx !== 0) ? ID.drv[driverIdx] : null,
    tripId: (i % 3 === 0 && statusIdx > 0 && !isCancelled) ? ID.trip[tripIdx] : null,
    pkgType, pkgDesc: `Description ${pkgType}`, pkgSize, pkgWeight: pkgWeightCat, weightKg,
    isUrgent, recipientName: `Destinataire ${i}`, recipientPhone: `0550${String(i).padStart(4,'0')}`,
    note: `Note livraison ${i}`, status: deliveryStatuses[statusIdx], capacityReserved: 1,
    pickup, dropoff, baseFee, distanceFee, weightSurcharge, sizeSurcharge, urgentSurcharge,
    price, finalPrice, currency: "DZD", payMethod, payStatus, timeline, proof, cancellation, otp
  })
}

// ════════════════════════════════════════════════════════════════════════════
// 8. RATES (évaluations pour livraisons terminées)
// ════════════════════════════════════════════════════════════════════════════
console.log("⭐ Insertion des évaluations…")
const ratedDeliveries = ID.delivery.filter((_, i) => i % 3 === 0 && i < 150)
for (const delId of ratedDeliveries) {
  const idx = ID.delivery.indexOf(delId)
  const requester = ID.req[idx % ID.req.length]
  const driver = ID.drv[idx % 20]
  const ratingVal = 3 + (idx % 3)
  await q(`INSERT INTO Rates (id, from_user_id, to_user_id, id_delivery, rating, comment) VALUES (?, ?, ?, ?, ?, ?)`, [uid(), requester, driver, delId, ratingVal, "Bonne expérience"])
  await q(`INSERT INTO Rates (id, from_user_id, to_user_id, id_delivery, rating, comment) VALUES (?, ?, ?, ?, ?, ?)`, [uid(), driver, requester, delId, ratingVal, "Client agréable"])
}

// ════════════════════════════════════════════════════════════════════════════
// 9. NOTIFICATIONS (abondantes)
// ════════════════════════════════════════════════════════════════════════════
console.log("🔔 Insertion des notifications…")
for (let i = 0; i < 400; i++) {
  const recipientId = (i % 2 === 0) ? ID.req[i % ID.req.length] : ID.drv[i % 20]
  const title = i % 3 === 0 ? "Nouvelle livraison" : (i % 3 === 1 ? "Mise à jour" : "Promotion")
  const message = `Message ${i} pour vous informer.`
  const type = i % 3 === 0 ? "delivery_update" : "info"
  const ref = (i % 5 === 0) ? ID.delivery[i % ID.delivery.length] : null
  const isRead = i % 4 === 0 ? 0 : 1
  await q(`INSERT INTO Notifications (id, recipient_id, title, message, type, reference_id, reference_model, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Delivery', ?, CURRENT_TIMESTAMP)`, [uid(), recipientId, title, message, type, ref, isRead])
}

// ════════════════════════════════════════════════════════════════════════════
// 10. DRIVER VERIFICATION TIMELINE
// ════════════════════════════════════════════════════════════════════════════
for (let i = 0; i < 20; i++) {
  await q(`INSERT INTO DriverVerificationTimeline (id, driver_id, event_type, entity_type, entity_id, status, actor_id, created_at) VALUES (?, ?, 'driver_review_updated', 'driver', ?, 'approved', ?, CURRENT_TIMESTAMP)`, [uid(), ID.drv[i], ID.drv[i], ID.admin1])
}

// ════════════════════════════════════════════════════════════════════════════
// 11. AUTHORITY INCIDENTS / COMPLAINTS / COMPLIANCE REPORTS
// ════════════════════════════════════════════════════════════════════════════
console.log("🛡️ Données pour autorité…")
// Incidents
for (let i = 0; i < 30; i++) {
  const delivery = ID.delivery[i % ID.delivery.length]
  const severity = ["low","medium","high","critical"][i % 4]
  const status = ["open","in_review","resolved","dismissed"][i % 4]
  const resolvedAt = status === "resolved" ? ts(-1, 12) : null
  await q(`INSERT INTO AuthorityIncidents (id, delivery_id, reported_by_user_id, assigned_to_authority_id, severity, status, title, description, resolution_notes, occurred_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uid(), delivery, ID.req[i % ID.req.length], ID.authority1, severity, status, `Incident ${i}`, `Description incident ${i}`, null, ts(-5, 10), resolvedAt])
}
// Complaints
for (let i = 0; i < 30; i++) {
  const delivery = ID.delivery[i % ID.delivery.length]
  const category = ["driver_behavior","delay","damage","payment","fraud","other"][i % 6]
  const status = ["new","in_review","resolved","rejected"][i % 4]
  await q(`INSERT INTO AuthorityComplaints (id, complainant_user_id, target_user_id, delivery_id, category, status, description, resolution_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [uid(), ID.req[i % ID.req.length], ID.drv[i % 20], delivery, category, status, `Plainte ${i}`, null])
}
// Compliance Reports
for (let i = 0; i < 20; i++) {
  const type = ["daily","weekly","monthly","incident","custom"][i % 5]
  const status = ["draft","published","archived"][i % 3]
  const publishedAt = status === "published" ? ts(-2, 8) : null
  await q(`INSERT INTO AuthorityComplianceReports (id, type, status, generated_by, period_start, period_end, summary, report_json, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uid(), type, status, ID.authority1, ts(-30,0), ts(0,0), `Rapport ${i}`, JSON.stringify({ key: "value" }), publishedAt])
}

// ════════════════════════════════════════════════════════════════════════════
// RÉSUMÉ DES COMPTES
// ════════════════════════════════════════════════════════════════════════════
await conn.end()

const SEP = "\u2500".repeat(72)
console.log(`\n${"\u2550".repeat(72)}`)
console.log("  TAWSIL \u2014 COMPTES CR\u00c9\u00c9S")
console.log(`${"\u2550".repeat(72)}\n`)

const section = (title) => {
  console.log(`\n${SEP}`)
  console.log(`  ${title}`)
  console.log(SEP)
}

const row = (label, value) =>
  console.log(`  ${label.padEnd(18)} ${value}`)

section("ADMIN")
row("Email :", "admin@tawsil.dz")
row("Mot de passe :", PASS.admin)

section("AUTORIT\u00c9")
const authAccounts = [
  ["Nassima Hadjadj", "autorite@tawsil.dz"],
  ["Ahmed Benali", "autorite2@tawsil.dz"],
  ["Fatima Zerrouki", "autorite3@tawsil.dz"],
]
for (const [n, e] of authAccounts) {
  console.log(`  ${n.padEnd(20)} ${e.padEnd(30)}  MDP: ${PASS.auth}`)
}

section("CHAUFFEURS  (mot de passe commun : " + PASS.driver + ")")
console.log()
console.log("  Nom                  Email                          T\u00e9l\u00e9phone     Statut       Note")
console.log("  " + "\u2500".repeat(90))
for (let i = 0; i < driverNames.length; i++) {
  const fn = driverNames[i].split(" ")[0].toLowerCase()
  const ln = driverNames[i].split(" ")[1].toLowerCase()
  const email = `${fn}.${ln}@tawsil.dz`
  const phone = driverPhones[i]
  const info = driverInfos[i]
  const status = info[5]
  const rating = info[6]
  console.log(`  ${driverNames[i].padEnd(20)} ${email.padEnd(30)} ${phone.padEnd(13)} ${status.padEnd(12)} ${rating}`)
}

section("DEMANDEURS  (mot de passe commun : " + PASS.user + ")")
console.log()
console.log("  Nom                  Email                          T\u00e9l\u00e9phone")
console.log("  " + "\u2500".repeat(65))
for (let i = 0; i < requesterNames.length; i++) {
  const fn = requesterNames[i].split(" ")[0].toLowerCase()
  const ln = requesterNames[i].split(" ")[1].toLowerCase()
  const email = `${fn}.${ln}@gmail.com`
  const phone = requesterPhones[i]
  console.log(`  ${requesterNames[i].padEnd(20)} ${email.padEnd(30)} ${phone}`)
}

section("STATISTIQUES")
console.log(`  Utilisateurs totaux  : ${allUsers.length} (3 admins + 3 autorit\u00e9s + 20 chauffeurs + 50 demandeurs)`)
console.log(`  Trajets              : 50`)
console.log(`  Livraisons           : 200`)
console.log(`  \u00c9valuations        : ${Math.floor(150 / 3) * 2}`)
console.log(`  Notifications        : 400`)
console.log()
console.log(`${"\u2550".repeat(72)}\n`)