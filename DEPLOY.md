# DEPLOY.md

This repository uses a single canonical server implementation for deployments.

Canonical server entrypoint:
- ./server.js (root)

To deploy on Railway (or similar hosts):
1. Ensure the project is linked to this repository and the branch `main`.
2. Railway will start the service using the `web` command in the Procfile: `web: node server.js`.
3. Do NOT point Railway to files under `public/` as standalone server entrypoints; duplicates were archived/stubbed.

If you need the deploy configuration changed (different branch or build commands), update the Railway project settings accordingly.
