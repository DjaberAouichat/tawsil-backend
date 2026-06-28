# TawsilGo Backend

Node.js (ESM) + Express 5 + MySQL2 + Socket.IO crowdshipping backend.

## Prerequisites
- Node.js >= 22
- MySQL 8+

## Local Setup
1. `cd backend`
2. `npm install`
3. `cp .env.example .env` then fill in your values
4. `npm run dev`

## Seed Database
`npm run seed`

## API Health Check
GET /api/health

## Azure Deployment
- Deployed via GitHub Actions (`.github/workflows/azure-deploy.yml`)
- Set the following GitHub secrets: `AZURE_WEBAPP_NAME`, `AZURE_WEBAPP_PUBLISH_PROFILE`
- Set the following Azure App Service Application Settings:
  - NODE_ENV=production
  - JWT_SECRET=<strong secret, min 32 chars>
  - MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
  - GEOAPIFY_API_KEY
  - CORS_ALLOWED_ORIGINS=https://your-frontend-domain.com
  - DEFAULT_ADMIN_PASSWORD=<strong password>
  - DEFAULT_AUTHORITY_PASSWORD=<strong password>
- Azure injects WEBSITES_PORT automatically; the server reads it with fallback to PORT=3000

## Socket.IO Events
- `notification:new` — new notification pushed to user
- `notification:read` — single notification marked read
- `notification:read-all` — all notifications marked read
- `delivery:status-updated` — delivery status changed
- `driver:location-updated` — driver location broadcast
