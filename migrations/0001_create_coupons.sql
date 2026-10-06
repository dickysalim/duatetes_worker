-- Migration: 0001_create_coupons.sql
-- D1 Database: duatetes_coupon

CREATE TABLE IF NOT EXISTS coupons (
  coupon_id      TEXT PRIMARY KEY,        -- e.g. "DT-A1B2C3" — short random code
  date_generated TEXT NOT NULL,           -- ISO 8601 timestamp
  phone_number   TEXT NOT NULL,           -- customer WA number
  prize_won      TEXT,                    -- prize name, NULL until spin is done
  date_prize_won TEXT,                    -- ISO 8601 timestamp, NULL until spin
  is_redeemed    INTEGER NOT NULL DEFAULT 0, -- 0 = not redeemed, 1 = redeemed
  date_redeemed  TEXT                     -- ISO 8601 timestamp, NULL until redeemed
);
