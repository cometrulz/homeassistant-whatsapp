#!/usr/bin/with-contenv bashio
set -e

export AUTH_TOKEN="$(bashio::config 'auth_token')"
export WEBHOOK_URL="$(bashio::config 'webhook_url')"
export WEBHOOK_BEARER="$(bashio::config 'webhook_bearer')"
export ALLOWLIST="$(bashio::config 'allowlist')"
export ALLOW_ALL_INBOUND="$(bashio::config 'allow_all_inbound')"
export LOG_RETENTION_DAYS="$(bashio::config 'log_retention_days')"
export LICENSE_SERVER_URL="$(bashio::config 'license_server_url')"
export LICENSE_EMAIL="$(bashio::config 'license_email')"
export LICENSE_KEY="$(bashio::config 'license_key')"
export PORT="3100"
export AUTH_DIR="/config/baileys_auth"

mkdir -p "$AUTH_DIR"

cd /opt/baileys_bridge
exec node index.js
