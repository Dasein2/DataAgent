-- PostgreSQL least-privilege setup for data-agent (run as a superuser / database owner).
-- Replace :analyst, :password, :database and :workspace before running.
--
-- The service never creates roles or schemas; it only verifies that the workspace is writable and
-- that source access is read-only.

CREATE ROLE :analyst LOGIN PASSWORD :'password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT CONNECT ON DATABASE :database TO :analyst;

-- Source: read only, and no ability to create anything in public.
GRANT USAGE ON SCHEMA public TO :analyst;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :analyst;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :analyst;
REVOKE CREATE ON SCHEMA public FROM :analyst;

-- Workspace: owned by the analysis account so it can create its own views/tables.
-- Use the Reserved `dwa_` prefix so the service can tell workspaces apart from source schemas.
CREATE SCHEMA :workspace AUTHORIZATION :analyst;
GRANT USAGE, CREATE ON SCHEMA :workspace TO :analyst;
REVOKE ALL ON SCHEMA :workspace FROM PUBLIC;

-- Optional: make a workspace read-only for production deployments (views still require CREATE on
-- the catalog, so production uses views_only at the service level instead of revoking CREATE).
