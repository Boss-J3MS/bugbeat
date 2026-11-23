-- ═══════════════════════════════════════════════
--  BugBeat — plans and billing tables
--  Run once on the local database (phpMyAdmin) and on Aiven (HeidiSQL).
--  Safe to run again: tables are only created if missing, and the
--  starting plans and prices are only added if missing.
-- ═══════════════════════════════════════════════

-- Free and Student Pro, with their limits.
CREATE TABLE IF NOT EXISTS plans (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  code              VARCHAR(20)  NOT NULL UNIQUE,
  name              VARCHAR(50)  NOT NULL,
  daily_analyses    INT          NOT NULL,
  runs_per_15min    INT          NOT NULL,
  track_limit       INT          NOT NULL,
  history_limit     INT          NULL,            -- NULL = all sessions
  advanced_analysis TINYINT(1)   NOT NULL DEFAULT 0,
  risk_score        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- What can be bought. billing = 'prepaid' (one payment, a fixed number of
-- days) or 'auto_renew' (charged again every period from a saved card).
CREATE TABLE IF NOT EXISTS plan_prices (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  plan_id           INT          NOT NULL,
  billing           ENUM('prepaid','auto_renew') NOT NULL,
  duration_days     INT          NOT NULL,
  amount_centavos   INT          NOT NULL,        -- ₱99.00 = 9900
  paymongo_plan_id  VARCHAR(64)  NULL,            -- auto_renew only; filled in on first use
  is_active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plan_price (plan_id, billing, duration_days),
  CONSTRAINT fk_plan_prices_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- The PayMongo customer made for a user (auto-renew only).
CREATE TABLE IF NOT EXISTS billing_customers (
  user_id               INT          PRIMARY KEY,
  paymongo_customer_id  VARCHAR(64)  NOT NULL UNIQUE,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_billing_customers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Each period of Pro a user has: bought once, auto-renewing, or given by an
-- admin. A user is on Pro while one of these has starts_at <= now < ends_at.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  user_id                   INT          NOT NULL,
  plan_id                   INT          NOT NULL,
  price_id                  INT          NULL,      -- NULL for an admin grant
  source                    ENUM('prepaid','auto_renew','admin_grant') NOT NULL,
  status                    ENUM('pending','active','past_due','cancelled') NOT NULL DEFAULT 'pending',
  starts_at                 DATETIME     NULL,
  ends_at                   DATETIME     NULL,
  auto_renew                TINYINT(1)   NOT NULL DEFAULT 0,
  paymongo_subscription_id  VARCHAR(64)  NULL UNIQUE,
  granted_by                INT          NULL,      -- the admin who gave it
  note                      VARCHAR(255) NULL,
  cancelled_at              DATETIME     NULL,
  created_at                DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_subscriptions_user (user_id, ends_at),
  CONSTRAINT fk_subscriptions_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_subscriptions_plan    FOREIGN KEY (plan_id)    REFERENCES plans(id),
  CONSTRAINT fk_subscriptions_price   FOREIGN KEY (price_id)   REFERENCES plan_prices(id),
  CONSTRAINT fk_subscriptions_granter FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Every payment attempt and its result. Only PayMongo's webhook marks a
-- payment as paid.
CREATE TABLE IF NOT EXISTS payments (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  user_id              INT          NOT NULL,
  price_id             INT          NOT NULL,
  subscription_id      INT          NULL,
  checkout_session_id  VARCHAR(64)  NULL UNIQUE,   -- prepaid (PayMongo Checkout)
  payment_intent_id    VARCHAR(64)  NULL,          -- first auto-renew payment
  invoice_id           VARCHAR(64)  NULL UNIQUE,   -- auto-renew invoices
  amount_centavos      INT          NOT NULL,
  status               ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  livemode             TINYINT(1)   NOT NULL DEFAULT 0,
  paid_at              DATETIME     NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_payments_user (user_id, created_at),
  CONSTRAINT fk_payments_user  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_payments_price FOREIGN KEY (price_id) REFERENCES plan_prices(id),
  CONSTRAINT fk_payments_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
);

-- Webhook events already handled, so a repeated delivery changes nothing.
CREATE TABLE IF NOT EXISTS paymongo_events (
  event_id     VARCHAR(64)  PRIMARY KEY,
  event_type   VARCHAR(80)  NOT NULL,
  received_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Analyses per day, per user (logged in) or per hashed IP address
-- (logged out), to enforce the daily limit. Dates are Philippine dates.
CREATE TABLE IF NOT EXISTS usage_counts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT        NULL,
  ip_hash     CHAR(64)   NULL,
  usage_date  DATE       NOT NULL,
  analyses    INT        NOT NULL DEFAULT 0,
  UNIQUE KEY uq_usage_user (user_id, usage_date),
  UNIQUE KEY uq_usage_ip   (ip_hash, usage_date),
  CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Starting plans and prices.
INSERT IGNORE INTO plans (code, name, daily_analyses, runs_per_15min, track_limit, history_limit, advanced_analysis, risk_score)
VALUES ('free', 'Free',        15,  15, 1, 20,   0, 0),
       ('pro',  'Student Pro', 200, 40, 5, NULL, 1, 1);

INSERT IGNORE INTO plan_prices (plan_id, billing, duration_days, amount_centavos)
SELECT id, 'prepaid',    30,  9900  FROM plans WHERE code = 'pro' UNION ALL
SELECT id, 'prepaid',    365, 89900 FROM plans WHERE code = 'pro' UNION ALL
SELECT id, 'auto_renew', 30,  9900  FROM plans WHERE code = 'pro' UNION ALL
SELECT id, 'auto_renew', 365, 89900 FROM plans WHERE code = 'pro';
