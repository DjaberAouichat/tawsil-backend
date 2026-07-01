#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Tawsil Backend — Azure VM Deployment Script (Ubuntu 24.04)
# ─────────────────────────────────────────────────────────────
# Run this script ON the VM after cloning the repo.
#   Usage: bash deploy.sh /path/to/backend
#
# Prerequisites: VM with Ubuntu 24.04.
# ─────────────────────────────────────────────────────────────

REPO_DIR="$(cd "${1:-$(dirname "$0")}" && pwd)"
RUN_USER="$(stat -c '%U' "$REPO_DIR")"
RUN_USER_HOME="$(eval echo "~$RUN_USER")"

echo "=== Deploying to: $REPO_DIR (user: $RUN_USER) ==="
cd "$REPO_DIR"

if [ "$EUID" -ne 0 ]; then
  echo "Re-running with sudo..."
  exec sudo bash "$0" "$@"
fi

echo "=== Step 1: System update ==="
apt-get update -y
apt-get upgrade -y

echo "=== Step 2: Install Node.js 22 ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node $(node -v), npm $(npm -v)"

echo "=== Step 3: Install MySQL 8.0 ==="
if ! command -v mysql &>/dev/null; then
  apt-get install -y mysql-server
  systemctl enable mysql
  systemctl start mysql
fi

echo "=== Step 4: Create database & configure root user ==="
mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS tawsil_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '@Djaberaoui2003';
FLUSH PRIVILEGES;
SQL

echo "=== Step 5: Install npm dependencies ==="
sudo -u "$RUN_USER" npm ci --omit=dev

echo "=== Step 6: Create uploads directory ==="
mkdir -p uploads
chown -R "$RUN_USER:$RUN_USER" uploads

echo "=== Step 7: Install PM2 process manager ==="
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

echo "=== Step 8: Start backend with PM2 ==="
sudo -u "$RUN_USER" pm2 delete tawsil-backend 2>/dev/null || true
sudo -u "$RUN_USER" pm2 start server.js --name tawsil-backend
sudo -u "$RUN_USER" pm2 save

# Enable PM2 startup for the user
sudo -u "$RUN_USER" pm2 startup systemd -u "$RUN_USER" --hp "$RUN_USER_HOME" 2>/dev/null || true

echo ""
echo "=== Deployment complete ==="
echo "Backend running on port 3000"
echo ""
echo "Check status: sudo -u $RUN_USER pm2 status"
echo "View logs:    sudo -u $RUN_USER pm2 logs tawsil-backend"
echo "API health:   curl http://localhost:3000/api/health"
echo ""
echo "IMPORTANT: Update CORS_ALLOWED_ORIGINS in .env"
echo "  with your Flutter web app URL before going live."
