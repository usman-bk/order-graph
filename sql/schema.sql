CREATE TABLE IF NOT EXISTS customers (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  api_token  text NOT NULL UNIQUE,
  is_admin   boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS items (
  id          bigserial PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id            bigserial PRIMARY KEY,
  customer_id   bigint NOT NULL REFERENCES customers (id),
  status        text NOT NULL DEFAULT 'PLACED' CHECK (status IN ('PLACED', 'PAID', 'SHIPPED', 'CANCELLED')),
  internal_note text,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id, id DESC);

CREATE TABLE IF NOT EXISTS order_lines (
  id       bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id),
  item_id  bigint NOT NULL REFERENCES items (id),
  quantity integer NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS order_lines_order_idx ON order_lines (order_id, id);
