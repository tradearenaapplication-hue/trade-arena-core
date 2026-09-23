# Archived duplicates README

The original duplicate server implementations that previously lived under public/ were intentionally archived or stubbed to ensure a single canonical server is used for deployment.

If you need to recover the original files, they exist in the repository's git history (previous commits). Use git log and git checkout to retrieve older versions, for example:

  git log -- public/server.js
  git checkout <commit-sha> -- public/server.js

Keeping duplicates in history rather than duplicating them here reduces repository size. If you prefer a full archival copy in this path, tell me and I will add them.
