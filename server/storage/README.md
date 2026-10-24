# AnythingLLM Storage

This directory contains persistent files used by the SaaS application. The
runtime business database is PostgreSQL, configured with `DATABASE_URL`; this
directory does not need an `anythingllm.db` file.

- `enterprise/<tenant-id>/`: uploaded knowledge originals, isolated by tenant.
- `lancedb/`: vectors when the platform selects the default local LanceDB backend.
- `assets/`: branding images used by the restored settings pages.
- `models/` and temporary/cache directories: created by providers that need local
  models or generated files.

PostgreSQL stores tenant and account data, knowledge and chunk text, ownership,
index versions/status, original-file paths, conversations, messages and citations.
Actual vectors belong to the selected vector backend. Remote vector backends do
not require a local LanceDB directory. Retained upstream `documents/` and
`vector-cache/` folders are not the current SaaS knowledge-record database.

Docker Compose mounts this folder at `/app/server/storage` by default; set
`SERVER_STORAGE_PATH` in `docker/.env` to use another persistent host directory.
The configured container user must be able to write to it. Missing-original or
permission errors should be resolved by checking that mount, the file ownership
and the configured storage path; creating a SQLite file is not a fix.

Fresh deployment runs the PostgreSQL migrations before starting the API. The
runtime schema is defined by the single PostgreSQL schema and migration chain,
without Workspace membership or the upstream single-user SQLite seed.
See [Docker deployment](../../docker/HOW_TO_USE_DOCKER.md) for the build/start steps.

Back up PostgreSQL, uploaded originals, local or remote vector storage and the
deployment encryption/signing configuration together. A database backup alone
does not contain the uploaded files or the keys needed to decrypt saved secrets.
