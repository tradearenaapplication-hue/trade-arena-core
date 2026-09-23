## 2026-09-18 - Internal Error Details Sanitization & Ethers Provider Compatibility
**Vulnerability:** Backend API error handlers in `server.js` were returning raw `error.message` strings to callers in 500 status responses, exposing sensitive operational details and stack information.
**Learning:** Returning unhandled exception messages in REST API catch blocks leaks internal state. In addition, when using Ethers v6 (`^6.17.0`), `ethers.providers.JsonRpcProvider` throws a `TypeError` and should be initialized as `ethers.JsonRpcProvider`.
**Prevention:** Always sanitize 500 HTTP error responses to return generic error messages (e.g., `'Internal server error'`), log exceptions internally, and thoroughly validate non-array/malformed JSON body inputs.
