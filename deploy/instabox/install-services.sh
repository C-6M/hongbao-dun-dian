#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd "$(dirname "$0")/.." && pwd)"
run_user="${1:-$(id -un)}"
if [[ "$app_root" != /data/hongbao ]]; then echo 'Install bundle at /data/hongbao first' >&2; exit 1; fi
id "$run_user" >/dev/null
node_bin="$app_root/runtime/node/bin/node"
"$node_bin" --version
scanner_unit="$(mktemp)"
dashboard_unit="$(mktemp)"
proxy_unit="$(mktemp)"
health_unit="$(mktemp)"
health_timer="$(mktemp)"
qq_unit="$(mktemp)"
trap 'rm -f "$scanner_unit" "$dashboard_unit" "$proxy_unit" "$health_unit" "$health_timer" "$qq_unit"' EXIT
cat >"$scanner_unit" <<EOF
[Unit]
Description=Hongbao scanner (requires configured local proxy controller)
After=network-online.target hongbao-proxy.service
Requires=hongbao-proxy.service
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=3
OnFailure=hongbao-node-health.service

[Service]
Type=simple
User=$run_user
WorkingDirectory=/data/hongbao
EnvironmentFile=/data/hongbao/scanner.env
Environment=SCANNER_IP_NETWORK_RETRY=1
Environment=SCANNER_DESKTOP_NOTIFICATIONS=0
ExecStartPre=$node_bin /data/hongbao/deploy/preflight.js
ExecStart=$node_bin /data/hongbao/core/spider.js
Restart=on-failure
RestartSec=60
TimeoutStartSec=420
TimeoutStopSec=45
KillSignal=SIGTERM
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
cat >"$health_unit" <<EOF
[Unit]
Description=Hongbao node DNS recovery and live exit selection
After=network-online.target hongbao-proxy.service
Wants=network-online.target hongbao-proxy.service
StartLimitIntervalSec=600
StartLimitBurst=2

[Service]
Type=oneshot
User=$run_user
WorkingDirectory=/data/hongbao
EnvironmentFile=/data/hongbao/scanner.env
ExecStart=$node_bin /data/hongbao/deploy/manage-node-health.js --scheduled
TimeoutStartSec=1800
TimeoutStopSec=20
KillMode=control-group
UMask=0077
EOF
cat >"$health_timer" <<EOF
[Unit]
Description=Check Hongbao node health every 30 minutes

[Timer]
OnActiveSec=30min
OnUnitInactiveSec=30min
AccuracySec=1min
Unit=hongbao-node-health.service

[Install]
WantedBy=timers.target
EOF
cat >"$dashboard_unit" <<EOF
[Unit]
Description=Hongbao dashboard (loopback only)
After=network.target

[Service]
Type=simple
User=$run_user
WorkingDirectory=/data/hongbao
Environment=QQ_FORWARD_MANAGED=1
ExecStart=$node_bin /data/hongbao/core/server.js --port 8443
Restart=on-failure
RestartSec=10
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
cat >"$qq_unit" <<EOF
[Unit]
Description=Hongbao QQ official bot forwarding
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=$run_user
WorkingDirectory=/data/hongbao
ExecStart=$node_bin /data/hongbao/core/qq-forward-worker.js
Restart=always
RestartSec=10
TimeoutStopSec=45
KillSignal=SIGTERM
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
cat >"$proxy_unit" <<EOF
[Unit]
Description=Hongbao local proxy controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
WorkingDirectory=/data/hongbao
ExecStartPre=/data/hongbao/runtime/mihomo -t -d /data/hongbao/proxy -f /data/hongbao/proxy/config.yaml
ExecStart=/data/hongbao/runtime/mihomo -d /data/hongbao/proxy -f /data/hongbao/proxy/config.yaml
Restart=on-failure
RestartSec=30
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
sudo install -m 0644 "$scanner_unit" /etc/systemd/system/hongbao-scanner.service
sudo install -m 0644 "$dashboard_unit" /etc/systemd/system/hongbao-dashboard.service
sudo install -m 0644 "$proxy_unit" /etc/systemd/system/hongbao-proxy.service
sudo install -m 0644 "$health_unit" /etc/systemd/system/hongbao-node-health.service
sudo install -m 0644 "$health_timer" /etc/systemd/system/hongbao-node-health.timer
sudo install -m 0644 "$qq_unit" /etc/systemd/system/hongbao-qq-forward.service
sudo systemctl daemon-reload
echo 'Services and health timer installed; run node maintenance before enabling the timer.'
