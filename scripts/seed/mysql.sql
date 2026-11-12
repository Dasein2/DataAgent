-- Data Agent test fixture: MySQL 8
-- Source database is read-only for the analysis account; workspace is a separate database.

CREATE DATABASE IF NOT EXISTS analytics CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS analysis_ws CHARACTER SET utf8mb4;

CREATE USER 'ro_analyst'@'%' IDENTIFIED BY 'ro';

CREATE TABLE analytics.sales (
  id          bigint unsigned NOT NULL AUTO_INCREMENT,
  region      varchar(16) NOT NULL,
  channel     varchar(16) NOT NULL,
  amount      decimal(12, 2) NOT NULL,
  refunded    tinyint(1) NOT NULL DEFAULT 0,
  created_at  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

INSERT INTO analytics.sales (region, channel, amount, refunded, created_at) VALUES
  ('EU',   'web',    120.50, 0, '2025-01-04 10:00:00'),
  ('EU',   'mobile',  80.00, 1, '2025-01-11 12:30:00'),
  ('EU',   'web',    240.10, 0, '2025-02-02 09:15:00'),
  ('US',   'web',    310.00, 0, '2025-01-19 18:45:00'),
  ('US',   'partner',150.75, 0, '2025-02-08 08:05:00'),
  ('US',   'mobile',  99.99, 1, '2025-02-21 20:10:00'),
  ('APAC', 'web',     75.20, 0, '2025-03-01 06:00:00'),
  ('APAC', 'partner',410.00, 0, '2025-03-12 11:30:00'),
  ('LATAM','web',     60.00, 1, '2025-03-15 15:20:00'),
  ('LATAM','mobile', 185.40, 0, '2025-03-28 17:40:00');

CREATE VIEW analytics.sales_by_region AS
  SELECT region, count(*) AS orders, sum(amount) AS total FROM analytics.sales GROUP BY region;

-- Source: SELECT only.
GRANT SELECT ON analytics.* TO 'ro_analyst'@'%';
-- Workspace: writable (views and tables), pre-created by ops.
GRANT ALL PRIVILEGES ON analysis_ws.* TO 'ro_analyst'@'%';

FLUSH PRIVILEGES;
