# Sentinel Security Journal

## 2026-09-21 - Path Traversal Prevention in Maintenance Proxy Endpoint
**Vulnerability:** Unsanitized user input (`req.body.filepath`) in `/api/maintenance/patch` endpoint allowed arbitrary directory traversal using relative path sequences (`../`).
**Learning:** Resolving file paths with `path.join(__dirname, filepath)` allows relative traversals out of the expected directory tree if `filepath` contains `../`.
**Prevention:** Always sanitize and resolve paths using `path.resolve` and enforce boundary containment (`resolvedPath.startsWith(rootDir + path.sep) || resolvedPath === rootDir`).
