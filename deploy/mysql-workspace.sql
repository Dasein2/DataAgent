-- MySQL least-privilege setup for data-agent (run as root).
-- Replace :analyst, :password, :database and :workspace before running.
--
-- MySQL has no separate schema layer: the workspace is a second database, and the service checks
-- that it is writable. If the workspace cannot be provisioned the session degrades to read-only
-- analysis (workspace_access = none).

CREATE USER ':analyst'@'%' IDENTIFIED BY ':password';

-- Source: SELECT only. This is the hard guarantee; the SQL guard is defence in depth.
GRANT SELECT ON :database.* TO ':analyst'@'%';

-- Workspace: created by ops, writable by the analysis account.
CREATE DATABASE IF NOT EXISTS :workspace CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW
  ON :workspace.* TO ':analyst'@'%';

-- MySQL DDL implicitly commits; the service therefore records datasets as pending -> ready and
-- reconciles them with the catalog on the next snapshot.
FLUSH PRIVILEGES;
