import mysql from 'mysql2/promise';

let pool = null;

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseAzureConnString = (str) => {
  if (!str) return {};
  const parts = {};
  str.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const val = pair.slice(idx + 1).trim();
    if (key === 'server' || key === 'data source' || key === 'host') parts.host = val;
    else if (key === 'database' || key === 'initial catalog') parts.database = val;
    else if (key === 'port') parts.port = val;
    else if (key === 'user id' || key === 'user' || key === 'uid') parts.user = val;
    else if (key === 'password' || key === 'pwd') parts.password = val;
  });
  return parts;
};

const buildPoolConfig = () => {
  const azureConnStr = parseAzureConnString(process.env.MYSQLCONNSTR_AZURE_MYSQL_CONNECTIONSTRING);

  const host = (process.env.MYSQL_HOST || azureConnStr.host || process.env.AZURE_MYSQL_HOST || 'localhost').trim();
  const port = toInt(process.env.MYSQL_PORT || azureConnStr.port || process.env.AZURE_MYSQL_PORT, 3306);
  const user = (process.env.MYSQL_USER || azureConnStr.user || process.env.AZURE_MYSQL_USERNAME || process.env.AZURE_MYSQL_USER || 'root').trim();
  const password = String(process.env.MYSQL_PASSWORD || azureConnStr.password || process.env.AZURE_MYSQL_PASSWORD || '');
  let database = (process.env.MYSQL_DATABASE || azureConnStr.database || process.env.AZURE_MYSQL_DATABASE || '').trim();
  if (!database || database === 'mysql') {
    database = 'tawsil_db';
  }

  return {
    host,
    port,
    user,
    password,
    database,
    ssl: !!(process.env.AZURE_MYSQL_HOST || process.env.MYSQLCONNSTR_AZURE_MYSQL_CONNECTIONSTRING)
      ? { rejectUnauthorized: false }
      : undefined,
    waitForConnections: true,
    connectionLimit: toInt(process.env.MYSQL_POOL_LIMIT, 10),
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: toInt(process.env.MYSQL_KEEPALIVE_DELAY_MS, 0),
    dateStrings: false,
  };
};

const escapeIdentifier = (identifier) => {
  return String(identifier || '').replace(/`/g, '``');
};

const ensureDatabaseExists = async (poolConfig) => {
  const connection = await mysql.createConnection({
    host: poolConfig.host,
    port: poolConfig.port,
    user: poolConfig.user,
    password: poolConfig.password,
    ssl: poolConfig.ssl,
  });

  try {
    const databaseName = escapeIdentifier(poolConfig.database);
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }
};

export const connectDB = async () => {
  if (pool) {
    return pool;
  }

  const poolConfig = buildPoolConfig();
  if (process.env.NODE_ENV !== 'production') {
    console.log(`DB config: ${poolConfig.user}@${poolConfig.host}:${poolConfig.port}/${poolConfig.database} ssl=${!!poolConfig.ssl}`);
  }
  pool = mysql.createPool(poolConfig);

  let connection = null;
  try {
    connection = await pool.getConnection();
    await connection.ping();
  } catch (error) {
    if (error?.code !== 'ER_BAD_DB_ERROR') {
      throw error;
    }

    try {
      await pool.end();
    } catch {
      // Ignore close errors while recovering from a missing database.
    }

    pool = null;
    await ensureDatabaseExists(poolConfig);

    pool = mysql.createPool(poolConfig);
    connection = await pool.getConnection();
    await connection.ping();
  } finally {
    if (connection) {
      connection.release();
    }
  }

  console.log('MySQL database connected');
  return pool;
};

export const closeDB = async () => {
  if (!pool) {
    return;
  }

  const currentPool = pool;
  pool = null;

  try {
    await currentPool.end();
  } catch (error) {
    console.error('Error while closing database pool', error);
  }
};

export const getPool = () => {
  if (!pool) {
    throw new Error('Database pool is not initialized. Call connectDB() first.');
  }

  return pool;
};

export const execute = async (sql, params = []) => {
  const [rows] = await getPool().execute(sql, params);
  return rows;
};

export const exec = async (connection, sql, params = []) => {
  const executor = connection || getPool();
  const [rows] = await executor.execute(sql, params);
  return rows;
};

export const withTransaction = async (work) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Transaction rollback failed', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
};

// ─── Database schema setup ─────────────────────────────────────────────
import fs from 'fs/promises';
import path from 'path';

const applySqlFile = async (filePath, label) => {
  let sql = await fs.readFile(filePath, 'utf8');
  sql = sql.replace(/\r\n/g, '\n');
  sql = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  sql = sql.replace(/^\s*--.*$/gm, '');
  sql = sql.replace(/\bCREATE\s+DATABASE\b[\s\S]*?;\s*/gi, '');
  sql = sql.replace(/\bUSE\s+`?\w+`?\s*;\s*/gi, '');
  sql = sql.replace(/\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE TABLE IF NOT EXISTS ');
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0).map(s => `${s};`);
  if (statements.length === 0) return;
  const p = getPool();
  for (const stmt of statements) {
    try {
      await p.query(stmt);
    } catch (error) {
      if (error?.code === 'ER_TABLE_EXISTS_ERROR' || error?.code === 'ER_DUP_KEYNAME' || error?.code === 'ER_DUP_FIELDNAME' || error?.code === 'ER_DUP_ENTRY') continue;
      console.error(`SQL [${error?.code}] ${error?.message}`);
      if (process.env.NODE_ENV !== 'production') {
        console.error(`  SQL: ${stmt.slice(0, 100)}`);
      }
    }
  }
  console.log(`Applied ${label}`);
};

const tableExists = async (tableName) => {
  const p = getPool();
  const [rows] = await p.query("SHOW TABLES LIKE ?", [tableName]);
  return rows.length > 0;
};

export const setupDatabase = async () => {
  const p = getPool();
  const hasUsers = await tableExists('Users');
  if (!hasUsers) {
    console.log('Database empty — applying schema...');
    const { fileURLToPath } = await import('url');
    const currentFilePath = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFilePath);
    const projectRoot = path.resolve(currentDir, '..');
    await applySqlFile(path.join(projectRoot, 'db.sql'), 'base schema (db.sql)');
  }
  const hasAnalytics = await tableExists('DeliveryPricingAnalytics');
  if (!hasAnalytics) {
    console.log('Creating DeliveryPricingAnalytics table...');
    await p.query(`CREATE TABLE IF NOT EXISTS DeliveryPricingAnalytics (
      id VARCHAR(36) PRIMARY KEY,
      delivery_id VARCHAR(36) NOT NULL,
      pricing_mode VARCHAR(50) NOT NULL,
      distance_km DECIMAL(10,2) NOT NULL,
      base_fee DECIMAL(10,2) NOT NULL,
      distance_fee DECIMAL(10,2) NOT NULL,
      size_surcharge DECIMAL(10,2) NOT NULL,
      weight_surcharge DECIMAL(10,2) NOT NULL,
      deviation_cost DECIMAL(10,2) DEFAULT 0,
      urgent_surcharge DECIMAL(10,2) DEFAULT 0,
      estimated_price DECIMAL(10,2) NOT NULL,
      driver_score INT DEFAULT NULL,
      selected_driver_id VARCHAR(36) DEFAULT NULL,
      is_best_deal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE,
      FOREIGN KEY (selected_driver_id) REFERENCES Drivers(participant_id) ON DELETE SET NULL
    )`);
    console.log('DeliveryPricingAnalytics table created.');
  }

  // ── DriverLocationHistory table ─────────────────────────────────────
  const hasDriverLocationHistory = await tableExists('DriverLocationHistory');
  if (!hasDriverLocationHistory) {
    console.log('Creating DriverLocationHistory table...');
    await p.query(`CREATE TABLE IF NOT EXISTS DriverLocationHistory (
      id VARCHAR(36) PRIMARY KEY,
      driver_id VARCHAR(36) NOT NULL,
      latitude DECIMAL(10,8) NOT NULL,
      longitude DECIMAL(11,8) NOT NULL,
      accuracy DECIMAL(5,2) DEFAULT NULL,
      heading DECIMAL(5,2) DEFAULT NULL,
      speed DECIMAL(5,2) DEFAULT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dlh_driver_ts (driver_id, timestamp),
      FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE
    )`);
    console.log('DriverLocationHistory table created.');
  }

  // ── Add accuracy column to DriverLocation if missing ────────────────
  try {
    const [colRows] = await p.query(
      `SHOW COLUMNS FROM DriverLocation LIKE 'accuracy'`,
    );
    if (colRows.length === 0) {
      await p.query(
        `ALTER TABLE DriverLocation ADD COLUMN accuracy DECIMAL(5,2) DEFAULT NULL AFTER longitude`,
      );
      console.log('Added accuracy column to DriverLocation.');
    }
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_COLUMN') {
      console.error(`Could not add accuracy column: ${error.message}`);
    }
  }

  // ── Add filter_preferences column to Drivers if missing ─────────────
  try {
    const [fpRows] = await p.query(
      `SHOW COLUMNS FROM Drivers LIKE 'filter_preferences'`,
    );
    if (fpRows.length === 0) {
      await p.query(
        `ALTER TABLE Drivers ADD COLUMN filter_preferences JSON DEFAULT NULL AFTER vehicle_info`,
      );
      console.log('Added filter_preferences column to Drivers.');
    }
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_COLUMN') {
      console.error(`Could not add filter_preferences column: ${error.message}`);
    }
  }

  // ── Settings table ──────────────────────────────────────────────────
  const hasSettings = await tableExists('Settings');
  if (!hasSettings) {
    console.log('Creating Settings table...');
    await p.query(`CREATE TABLE IF NOT EXISTS Settings (
      setting_key   VARCHAR(100) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    // Insert default fuel_cost_per_km
    await p.query(
      `INSERT IGNORE INTO Settings (setting_key, setting_value) VALUES ('fuel_cost_per_km', '8')`,
    );
    console.log('Settings table created with defaults.');
  }

  // ── DeliveryEarningsSnapshot table ──────────────────────────────────
  const hasSnapshot = await tableExists('DeliveryEarningsSnapshot');
  if (!hasSnapshot) {
    console.log('Creating DeliveryEarningsSnapshot table...');
    await p.query(`CREATE TABLE IF NOT EXISTS DeliveryEarningsSnapshot (
      id                 VARCHAR(36) PRIMARY KEY,
      delivery_id        VARCHAR(36) NOT NULL,
      driver_id          VARCHAR(36) NOT NULL,
      estimated_earnings DECIMAL(10,2) NOT NULL,
      actual_earnings    DECIMAL(10,2) DEFAULT NULL,
      snapshot_data      JSON DEFAULT NULL,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE,
      FOREIGN KEY (driver_id) REFERENCES Drivers(participant_id) ON DELETE CASCADE
    )`);
    console.log('DeliveryEarningsSnapshot table created.');
  }

  // ── Add notification_preferences column to Drivers if missing ─────
  try {
    const [npRows] = await p.query(
      `SHOW COLUMNS FROM Drivers LIKE 'notification_preferences'`,
    );
    if (npRows.length === 0) {
      await p.query(
        `ALTER TABLE Drivers ADD COLUMN notification_preferences JSON DEFAULT NULL AFTER filter_preferences`,
      );
      console.log('Added notification_preferences column to Drivers.');
    }
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_COLUMN') {
      console.error(`Could not add notification_preferences column: ${error.message}`);
    }
  }

  // ── Add approval_welcome_shown column to Drivers if missing ───────
  try {
    const [awsRows] = await p.query(
      `SHOW COLUMNS FROM Drivers LIKE 'approval_welcome_shown'`,
    );
    if (awsRows.length === 0) {
      await p.query(
        `ALTER TABLE Drivers ADD COLUMN approval_welcome_shown BOOLEAN DEFAULT FALSE AFTER is_documents_verified`,
      );
      console.log('Added approval_welcome_shown column to Drivers.');
    }
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_COLUMN') {
      console.error(`Could not add approval_welcome_shown column: ${error.message}`);
    }
  }

  // ── Add pickup_wilaya / dropoff_wilaya columns to Deliveries if missing ──
  try {
    const [pwRows] = await p.query(
      `SHOW COLUMNS FROM Deliveries LIKE 'pickup_wilaya'`,
    );
    if (pwRows.length === 0) {
      await p.query(
        `ALTER TABLE Deliveries
         ADD COLUMN pickup_wilaya VARCHAR(100) DEFAULT NULL AFTER delivery_mode,
         ADD COLUMN dropoff_wilaya VARCHAR(100) DEFAULT NULL AFTER pickup_wilaya`,
      );
      console.log('Added pickup_wilaya / dropoff_wilaya columns to Deliveries.');
    }
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_COLUMN') {
      console.error(`Could not add pickup_wilaya / dropoff_wilaya columns: ${error.message}`);
    }
  }

  // ── Backfill pickup_wilaya / dropoff_wilaya for existing deliveries that have NULL ──
  try {
    const [nullRows] = await p.query(
      `SELECT COUNT(*) AS cnt FROM Deliveries WHERE pickup_wilaya IS NULL`,
    );
    if (nullRows[0].cnt > 0) {
      console.log(`Backfilling ${nullRows[0].cnt} deliveries with pickup_wilaya...`);
      await p.query(`
        UPDATE Deliveries d
        JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'
        LEFT JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
        SET d.pickup_wilaya = TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(pl.address, ',', -2), ',', 1)),
            d.dropoff_wilaya = TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(dl.address, ',', -2), ',', 1))
        WHERE d.pickup_wilaya IS NULL
      `);
      const [affected] = await p.query(`SELECT ROW_COUNT() AS cnt`);
      console.log(`Backfilled ${affected[0].cnt} deliveries.`);
    }
  } catch (error) {
    console.error(`Could not backfill pickup_wilaya: ${error.message}`);
  }

  // ── Add vehicle_type / max_size_category columns to Drivers if missing ──
  try {
    const [vtRows] = await p.query(
      `SHOW COLUMNS FROM Drivers LIKE 'vehicle_type'`,
    );
    if (vtRows.length === 0) {
      await p.query(
        `ALTER TABLE Drivers
         ADD COLUMN vehicle_type VARCHAR(50) DEFAULT NULL AFTER vehicle_info,
         ADD COLUMN max_size_category VARCHAR(10) DEFAULT NULL AFTER max_volume_m3`,
      );
      console.log('Added vehicle_type / max_size_category columns to Drivers.');
    }
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_COLUMN') {
      console.error(`Could not add vehicle_type / max_size_category columns: ${error.message}`);
    }
  }

  // ── Migrate Vehicles.type from ENUM to VARCHAR(50) ──
  try {
    const [vtColRows] = await p.query(
      `SHOW COLUMNS FROM Vehicles WHERE Field = 'type' AND Type LIKE 'enum(%'`,
    );
    if (vtColRows.length > 0) {
      await p.query(`ALTER TABLE Vehicles MODIFY COLUMN type VARCHAR(50) DEFAULT NULL`);
      console.log('Changed Vehicles.type from ENUM to VARCHAR(50).');
    }
  } catch (error) {
    console.error(`Could not migrate Vehicles.type: ${error.message}`);
  }

  // ── Migrate Trips.vehicle_type from ENUM to VARCHAR(50) ──
  try {
    const [ttColRows] = await p.query(
      `SHOW COLUMNS FROM Trips WHERE Field = 'vehicle_type' AND Type LIKE 'enum(%'`,
    );
    if (ttColRows.length > 0) {
      await p.query(`ALTER TABLE Trips MODIFY COLUMN vehicle_type VARCHAR(50) DEFAULT NULL`);
      console.log('Changed Trips.vehicle_type from ENUM to VARCHAR(50).');
    }
  } catch (error) {
    console.error(`Could not migrate Trips.vehicle_type: ${error.message}`);
  }

  // ── DeliveryRatings table ───────────────────────────────────────────
  const hasDeliveryRatings = await tableExists('DeliveryRatings');
  if (!hasDeliveryRatings) {
    console.log('Creating DeliveryRatings table...');
    await p.query(`CREATE TABLE IF NOT EXISTS DeliveryRatings (
      id                    VARCHAR(36) PRIMARY KEY,
      delivery_id           VARCHAR(36) NOT NULL UNIQUE,
      driver_id             VARCHAR(36) NOT NULL,
      client_id             VARCHAR(36) NOT NULL,
      communication_rating  TINYINT UNSIGNED NOT NULL CHECK (communication_rating BETWEEN 1 AND 5),
      package_rating        TINYINT UNSIGNED NOT NULL CHECK (package_rating BETWEEN 1 AND 5),
      delivery_time_rating  TINYINT UNSIGNED NOT NULL CHECK (delivery_time_rating BETWEEN 1 AND 5),
      average_rating        DECIMAL(3,2) NOT NULL,
      comment               TEXT,
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE,
      FOREIGN KEY (driver_id)   REFERENCES Drivers(participant_id) ON DELETE CASCADE,
      FOREIGN KEY (client_id)   REFERENCES Requesters(participant_id) ON DELETE CASCADE
    )`);
    console.log('DeliveryRatings table created.');
  }
  // DeliveryRatings indexes
  const ratingIndexesToCreate = [
    {
      name: 'idx_delivery_ratings_driver',
      sql: `CREATE INDEX idx_delivery_ratings_driver ON DeliveryRatings(driver_id)`,
    },
    {
      name: 'idx_delivery_ratings_delivery',
      sql: `CREATE INDEX idx_delivery_ratings_delivery ON DeliveryRatings(delivery_id)`,
    },
  ];
  for (const idx of ratingIndexesToCreate) {
    try {
      await p.query(idx.sql);
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') {
        console.error(`Could not create index ${idx.name}: ${error.message}`);
      }
    }
  }

  // ── ClientRatings table ──────────────────────────────────────────────
  const hasClientRatings = await tableExists('ClientRatings');
  if (!hasClientRatings) {
    console.log('Creating ClientRatings table...');
    await p.query(`CREATE TABLE IF NOT EXISTS ClientRatings (
      id                    VARCHAR(36) PRIMARY KEY,
      delivery_id           VARCHAR(36) NOT NULL UNIQUE,
      driver_id             VARCHAR(36) NOT NULL,
      client_id             VARCHAR(36) NOT NULL,
      communication_rating  TINYINT UNSIGNED NOT NULL CHECK (communication_rating BETWEEN 1 AND 5),
      flexibility_rating    TINYINT UNSIGNED NOT NULL CHECK (flexibility_rating BETWEEN 1 AND 5),
      meeting_respect_rating TINYINT UNSIGNED NOT NULL CHECK (meeting_respect_rating BETWEEN 1 AND 5),
      average_rating        DECIMAL(3,2) NOT NULL,
      comment               TEXT,
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (delivery_id) REFERENCES Deliveries(id) ON DELETE CASCADE,
      FOREIGN KEY (driver_id)   REFERENCES Drivers(participant_id) ON DELETE CASCADE,
      FOREIGN KEY (client_id)   REFERENCES Requesters(participant_id) ON DELETE CASCADE
    )`);
    console.log('ClientRatings table created.');
  }
  // ClientRatings indexes
  const clientRatingIndexes = [
    { name: 'idx_client_ratings_client', sql: `CREATE INDEX idx_client_ratings_client ON ClientRatings(client_id)` },
    { name: 'idx_client_ratings_delivery', sql: `CREATE INDEX idx_client_ratings_delivery ON ClientRatings(delivery_id)` },
  ];
  for (const idx of clientRatingIndexes) {
    try {
      await p.query(idx.sql);
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') {
        console.error(`Could not create index ${idx.name}: ${error.message}`);
      }
    }
  }

  // ── DeliveryStatusHistory table ─────────────────────────────────────
  const hasDeliveryStatusHistory = await tableExists('DeliveryStatusHistory');
  if (!hasDeliveryStatusHistory) {
    console.log('Creating DeliveryStatusHistory table...');
    await p.query(`CREATE TABLE IF NOT EXISTS DeliveryStatusHistory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      delivery_id VARCHAR(36) NOT NULL,
      status VARCHAR(50) NOT NULL,
      changed_by VARCHAR(36) DEFAULT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      note TEXT DEFAULT NULL,
      INDEX idx_dsh_delivery (delivery_id, changed_at)
    )`);
    console.log('DeliveryStatusHistory table created.');
  }

  // ── Performance indexes ─────────────────────────────────────────────
  const indexesToCreate = [
    {
      name: 'idx_deliveries_requester_status_updated',
      sql: `CREATE INDEX idx_deliveries_requester_status_updated ON Deliveries(requester_id, status, updated_at)`,
    },
    {
      name: 'idx_deliveries_driver_status',
      sql: `CREATE INDEX idx_deliveries_driver_status ON Deliveries(assigned_driver_id, status)`,
    },
    {
      name: 'idx_notifications_recipient_read_created',
      sql: `CREATE INDEX idx_notifications_recipient_read_created ON Notifications(recipient_id, is_read, created_at)`,
    },
  ]

  for (const idx of indexesToCreate) {
    try {
      await p.query(idx.sql)
      console.log(`Index ${idx.name} created.`)
    } catch (error) {
      if (error.code === 'ER_DUP_KEYNAME') {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`Index ${idx.name} already exists.`)
        }
      } else {
        console.error(`Could not create index ${idx.name}: ${error.message}`)
      }
    }
  }

  console.log('Database setup complete.');
};
