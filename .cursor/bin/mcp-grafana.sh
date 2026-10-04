#!/bin/sh
# MCP Grafana Cloud проекта: адрес и токен сервисного аккаунта — из ~/.secrets-tank/grafana-cloud.env,
# в аргументы процесса не попадают.
set -eu
set -a
. "$HOME/.secrets-tank/grafana-cloud.env"
set +a
exec /opt/homebrew/bin/mcp-grafana
