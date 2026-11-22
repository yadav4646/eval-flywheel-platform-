-- Shop analytics schema. Money is stored as integer cents; dates are ISO-8601 text (YYYY-MM-DD).
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES categories(id)   -- NULL for top-level categories
);

CREATE TABLE products (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  price_cents  INTEGER NOT NULL,                  -- current list price
  launched_at  TEXT NOT NULL
);

CREATE TABLE customers (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  country      TEXT NOT NULL,                     -- ISO-3166 alpha-2, e.g. 'US', 'DE'
  city         TEXT NOT NULL,
  segment      TEXT NOT NULL CHECK (segment IN ('consumer', 'business')),
  signup_date  TEXT NOT NULL
);

CREATE TABLE orders (
  id              INTEGER PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  order_date      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'shipped', 'delivered', 'cancelled', 'returned')),
  shipping_cents  INTEGER NOT NULL
);

CREATE TABLE order_items (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL,
  unit_price_cents  INTEGER NOT NULL,             -- price actually charged per unit
  discount_pct      INTEGER NOT NULL DEFAULT 0    -- 0-30, applied to the line
);

CREATE TABLE reviews (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_date  TEXT NOT NULL,
  body         TEXT NOT NULL
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(order_date);
CREATE INDEX idx_items_order ON order_items(order_id);
CREATE INDEX idx_items_product ON order_items(product_id);
CREATE INDEX idx_reviews_product ON reviews(product_id);
