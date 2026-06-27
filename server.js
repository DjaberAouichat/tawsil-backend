import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const workspaceEnvPath = path.resolve(currentDir, '..', '.env');

// Load env vars before importing modules that read process.env at import time.
dotenv.config({ path: path.join(currentDir, '.env') });
dotenv.config({ path: workspaceEnvPath, override: false });

if (process.env.NODE_ENV === 'production') {
  const required = [
    { name: 'JWT_SECRET', minLength: 32 },
    { name: 'MYSQL_HOST', alt: 'AZURE_MYSQL_HOST' },
    { name: 'MYSQL_USER', alt: 'AZURE_MYSQL_USER' },
    { name: 'MYSQL_PASSWORD', alt: 'AZURE_MYSQL_PASSWORD' },
    { name: 'MYSQL_DATABASE', alt: 'AZURE_MYSQL_DATABASE' },
    { name: 'GEOAPIFY_API_KEY' },
    { name: 'CORS_ALLOWED_ORIGINS' },
  ]
  for (const { name, alt, minLength } of required) {
    const isMysqlVar = name.startsWith('MYSQL_')
    if (isMysqlVar && process.env.MYSQLCONNSTR_AZURE_MYSQL_CONNECTIONSTRING) {
      continue
    }
    const val = process.env[name] || process.env[alt]
    if (!val) {
      const hint = alt ? `${name} or ${alt}` : name
      throw new Error(`Missing required env var: ${hint}`)
    }
    if (minLength && val.length < minLength) {
      throw new Error(`Env var ${name} must be at least ${minLength} characters long`)
    }
  }
}

const { connectDB, closeDB, getPool } = await import('./lib/db.js');
const { setupDatabase } = await import('./lib/db.js');
const { default: authRoutes } = await import('./routes/auth.routes.js');
const { default: mapsRoutes } = await import('./routes/maps.routes.js');
const { default: tripRoutes } = await import('./routes/trip.routes.js');
const { default: clientRoutes } = await import('./routes/client.routes.js');
const { default: deliveryRoutes } = await import('./routes/delivery.routes.js');
const { default: driverRoutes } = await import('./routes/driver.routes.js');
const { default: dashboardRoutes } = await import('./routes/dashboard.routes.js');
const { default: notificationRoutes } = await import('./routes/notification.routes.js');
const { default: adminRoutes } = await import('./routes/admin.routes.js');
const { default: authorityRoutes } = await import('./routes/authority.routes.js');
const { default: rateRoutes } = await import('./routes/rate.routes.js');
const { default: vehicleRoutes } = await import('./routes/vehicle.routes.js');
const { default: documentRoutes } = await import('./routes/document.routes.js');
const { default: uploadRoutes } = await import('./routes/upload.routes.js');
const { default: promotionRoutes } = await import('./routes/promotion.routes.js');
const { initSocket } = await import('./socket/index.js');
const { startExpiringDeliveryCron } = await import('./services/expiring-deliveries.cron.js');
const { securityHeaders } = await import('./middleware/auth.js');

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

if (!process.env.MYSQL_HOST && process.env.NODE_ENV !== 'production') {
  console.warn(
    'MYSQL_HOST was not provided. Using localhost defaults for development.',
  );
}

if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'production') {
  process.env.JWT_SECRET = 'dev-jwt-secret-change-me';
  console.warn(
    'JWT_SECRET was not provided. Using development fallback secret.',
  );
}

if (!process.env.JWT_EXPIRES_IN) {
  process.env.JWT_EXPIRES_IN = '7d';
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(securityHeaders);

const DB_RETRY_DELAY_MS = Number(process.env.DB_RETRY_DELAY_MS) || 15000;
let isDatabaseConnected = false;
let httpServer = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const allowedOriginsFromEnv = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const allowedOriginSet = new Set(allowedOriginsFromEnv);
const allowAnyOrigin = allowedOriginSet.has('*');

const localhostOriginPattern =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const privateLanOriginPattern =
  /^https?:\/\/(?:(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:192\.168\.\d{1,3}\.\d{1,3})|(?:172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}))(?::\d+)?$/i;

app.use((req, res, next) => {
  if (req.url.startsWith('/socket.io')) {
    next();
    return;
  }

  const origin = req.headers.origin;

  if (origin) {
    const allowed =
      allowAnyOrigin ||
      allowedOriginSet.has(origin) ||
      (process.env.NODE_ENV !== 'production' && localhostOriginPattern.test(origin)) ||
      (process.env.NODE_ENV !== 'production' && privateLanOriginPattern.test(origin));

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else if (
    process.env.NODE_ENV === 'production' &&
    !allowAnyOrigin &&
    allowedOriginSet.size === 0
  ) {
    return res.status(500).json({
      success: false,
      message: 'Server CORS is not configured for production.',
      details: {
        code: 'CORS_NOT_CONFIGURED',
      },
    });
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  );
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/uploads', express.static(path.join(currentDir, 'uploads')));

app.get('/api/health', (_req, res) => {
  return res.status(200).json({
    success: true,
    message: 'OK',
    data: {
      service: 'tawsil-backend',
      status: 'up',
      dbConnected: isDatabaseConnected,
      timestamp: new Date().toISOString(),
    },
  });
});

const PORT = Number(process.env.PORT || 3000);

const canServeWithoutDatabase = (requestPath) => {
  return (
    requestPath.startsWith('/api/health') || requestPath.startsWith('/api/maps')
  );
};

app.use((req, res, next) => {
  if (isDatabaseConnected || canServeWithoutDatabase(req.path) || req.url.startsWith('/socket.io')) {
    next();
    return;
  }

  return res.status(503).json({
    success: false,
    message: 'Service temporarily unavailable. Database is not connected.',
    details: {
      code: 'DB_UNAVAILABLE',
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/maps', mapsRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/authority', authorityRoutes);
app.use('/api/rates', rateRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api', uploadRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    details: null,
  });
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  console.error('[ADMIN CRASH] Error caught by Express error handler:');
  console.error('[ADMIN CRASH]   URL:', req?.method, req?.originalUrl || req?.url);
  console.error('[ADMIN CRASH]   Status:', statusCode);
  console.error('[ADMIN CRASH]   Message:', err?.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error('[ADMIN CRASH]   Stack:', err?.stack);
    if (err?.sql) console.error('[ADMIN CRASH]   SQL:', err.sql);
    if (err?.sqlMessage) console.error('[ADMIN CRASH]   SQL Message:', err.sqlMessage);
  }

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal server error',
    details: err.details || null,
  });
});

const ADMIN_EMAIL = 'admin@tawsil.dz';
const ADMIN_PASSWORD_PLAIN = 'adminadmin';

const ensureAdminAccount = async () => {
  try {
    const pool = getPool();
    const [existing] = await pool.execute(
      'SELECT u.id FROM Users u INNER JOIN Admins a ON a.user_id = u.id WHERE u.email = ? LIMIT 1',
      [ADMIN_EMAIL],
    );
    if (existing.length > 0) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`Compte admin trouve: ${ADMIN_EMAIL}`);
      }
      return;
    }

    const { randomUUID } = await import('crypto');
    const bcrypt = await import('bcryptjs');
    const adminId = randomUUID();
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD_PLAIN, 10);

    await pool.execute(
      `INSERT INTO Users (id, first_name, last_name, email, password, phone, is_email_verified, is_onboarded, created_at, updated_at)
       VALUES (?, 'Admin', 'Tawsil', ?, ?, '+213000000000', 1, 1, NOW(), NOW())`,
      [adminId, ADMIN_EMAIL, passwordHash],
    );
    await pool.execute('INSERT INTO Admins (user_id) VALUES (?)', [adminId]);

    if (process.env.NODE_ENV !== 'production') {
      console.log(`Compte admin cree avec succes: ${ADMIN_EMAIL}`);
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Erreur lors de la creation du compte admin:', error?.message || error);
    }
  }
};

const AUTHORITY_ACCOUNTS = [
  { email: 'Police@tawsil.dz', firstName: 'Police', lastName: 'Tawsil', phone: '+213770000001' },
  { email: 'Gendarmerie@tawsil.dz', firstName: 'Gendarmerie', lastName: 'Tawsil', phone: '+213770000002' },
  { email: 'DirectorateOfTransportation@tawsil.dz', firstName: 'Direction', lastName: 'Transport', phone: '+213770000003' },
];
const AUTHORITY_PASSWORD_PLAIN = 'tawsilgo';

const ensureAuthorityAccounts = async () => {
  try {
    const pool = getPool();
    const { randomUUID } = await import('crypto');
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(AUTHORITY_PASSWORD_PLAIN, 10);

    for (const acct of AUTHORITY_ACCOUNTS) {
      const [existing] = await pool.execute(
        'SELECT u.id FROM Users u WHERE u.email = ? LIMIT 1',
        [acct.email],
      );
      let userId = existing.length > 0 ? existing[0].id : null;

      const [authCheck] = await pool.execute(
        'SELECT user_id FROM Authorities WHERE user_id = ? LIMIT 1',
        [userId],
      );
      if (userId && authCheck.length > 0) {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`Compte authority trouve: ${acct.email}`);
        }
        continue;
      }

      if (!userId) {
        userId = randomUUID();
        await pool.execute(
          `INSERT INTO Users (id, first_name, last_name, email, password, phone, is_email_verified, is_onboarded, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, NOW(), NOW())`,
          [userId, acct.firstName, acct.lastName, acct.email, passwordHash, acct.phone],
        );
        if (process.env.NODE_ENV !== 'production') {
          console.log(`Utilisateur authority cree: ${acct.email}`);
        }
      }

      await pool.execute('INSERT IGNORE INTO Authorities (user_id) VALUES (?)', [userId]);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`Compte authority cree avec succes: ${acct.email}`);
      }
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Erreur lors de la creation des comptes authority:', error?.message || error);
    }
  }
};

const connectDatabaseWithRetry = async () => {
  while (!isDatabaseConnected) {
    try {
      await connectDB();
      isDatabaseConnected = true;
      if (process.env.NODE_ENV !== 'production') {
      console.log('Connexion base de donnees etablie.');
    }
      await setupDatabase();
      await ensureAdminAccount();
      await ensureAuthorityAccounts();
      return;
    } catch (error) {
      isDatabaseConnected = false;
      console.error(
        `Connexion DB indisponible. Nouvelle tentative dans ${DB_RETRY_DELAY_MS}ms.`,
        error?.message || error,
      );
      await wait(DB_RETRY_DELAY_MS);
    }
  }
};

const shutdown = async (signal) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`${signal} received. Shutting down gracefully...`);
  }

  try {
    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    await closeDB();
  } catch (error) {
    console.error('Error during shutdown', error);
  } finally {
    process.exit(0);
  }
};

const startServer = async () => {
  httpServer = http.createServer(app);

  httpServer.listen(PORT, () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Serveur lance sur le port ${PORT}`);
    }
  });

  httpServer.on('error', (error) => {
    console.error('HTTP server error:', error);
    process.exit(1);
  });

  initSocket(httpServer);

  startExpiringDeliveryCron();

  void connectDatabaseWithRetry();
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

void startServer();
