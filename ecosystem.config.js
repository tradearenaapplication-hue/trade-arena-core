# Trade Arena PM2 Process Manager Configuration
# This file is used by Railway's PM2 integration

apps:
  - name: trade-arena
    script: server.js
    instances: max
    exec_mode: cluster
    max_memory_restart: 500M
    env:
      NODE_ENV: production
      PORT: 3001
      HOST: 0.0.0.0
    error: logs/err.log
    out: logs/out.log
    log_date_format: YYYY-MM-DD HH:mm:ss
    max_restarts: 10
    min_uptime: 10s