-- PGlite fixture: same shape as postgres.sql, minus role/GRANT statements (PGlite runs as a
-- superuser and does not model roles). The read-only guarantee still comes from the pinned
-- read-only transaction and the SQL guard, which is exactly what these tests exercise.

CREATE TABLE sales (
  id          bigserial PRIMARY KEY,
  region      text NOT NULL,
  channel     text NOT NULL,
  amount      numeric(12, 2) NOT NULL,
  refunded    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sales (region, channel, amount, refunded, created_at) VALUES
  ('EU',   'web',    120.50, false, '2025-01-04T10:00:00Z'),
  ('EU',   'mobile',  80.00, true,  '2025-01-11T12:30:00Z'),
  ('EU',   'web',    240.10, false, '2025-02-02T09:15:00Z'),
  ('US',   'web',    310.00, false, '2025-01-19T18:45:00Z'),
  ('US',   'partner',150.75, false, '2025-02-08T08:05:00Z'),
  ('US',   'mobile',  99.99, true,  '2025-02-21T20:10:00Z'),
  ('APAC', 'web',     75.20, false, '2025-03-01T06:00:00Z'),
  ('APAC', 'partner',410.00, false, '2025-03-12T11:30:00Z'),
  ('LATAM','web',     60.00, true,  '2025-03-15T15:20:00Z'),
  ('LATAM','mobile', 185.40, false, '2025-03-28T17:40:00Z');

CREATE VIEW sales_by_region AS
  SELECT region, count(*) AS orders, sum(amount) AS total FROM sales GROUP BY region;

CREATE SCHEMA analysis_ws;
