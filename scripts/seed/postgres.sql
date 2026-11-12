-- Data Agent test fixture: PostgreSQL
-- Read-only analysis account + pre-provisioned workspace schema + sample data.

CREATE ROLE ro_analyst LOGIN PASSWORD 'ro' NOSUPERUSER NOCREATEDB NOCREATEROLE;

CREATE DATABASE analytics;
\connect analytics

CREATE TABLE sales (
  id          bigserial PRIMARY KEY,
  region      text NOT NULL,
  channel     text NOT NULL,
  amount      numeric(12, 2) NOT NULL,
  refunded    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sales (region, channel, amount, refunded, created_at) VALUES
  ('EU',  'web',    120.50, false, '2025-01-04T10:00:00Z'),
  ('EU',  'mobile',  80.00, true,  '2025-01-11T12:30:00Z'),
  ('EU',  'web',    240.10, false, '2025-02-02T09:15:00Z'),
  ('US',  'web',    310.00, false, '2025-01-19T18:45:00Z'),
  ('US',  'partner',150.75, false, '2025-02-08T08:05:00Z'),
  ('US',  'mobile',  99.99, true,  '2025-02-21T20:10:00Z'),
  ('APAC','web',     75.20, false, '2025-03-01T06:00:00Z'),
  ('APAC','partner',410.00, false, '2025-03-12T11:30:00Z'),
  ('LATAM','web',    60.00, true,  '2025-03-15T15:20:00Z'),
  ('LATAM','mobile', 185.40, false, '2025-03-28T17:40:00Z');

CREATE VIEW sales_by_region AS
  SELECT region, count(*) AS orders, sum(amount) AS total
  FROM sales GROUP BY region;

-- Read-only account: SELECT on source data only.
GRANT CONNECT ON DATABASE analytics TO ro_analyst;
GRANT USAGE ON SCHEMA public TO ro_analyst;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro_analyst;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ro_analyst;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ro_analyst;

-- Workspace: pre-created by ops, writable by the analysis account only.
CREATE SCHEMA analysis_ws AUTHORIZATION ro_analyst;
GRANT USAGE, CREATE ON SCHEMA analysis_ws TO ro_analyst;
