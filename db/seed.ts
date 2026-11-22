// Builds db/shop.sqlite deterministically. Same seed -> byte-for-byte identical
// data on every machine, so gold query results are stable across laptops and CI.
//
//   npm run db:seed

import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH, ROOT } from "../flywheel/paths";

const SEED = 20261122;

// mulberry32: tiny, fast, deterministic PRNG.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES: [number, string, number | null][] = [
  [1, "Electronics", null],
  [2, "Home & Kitchen", null],
  [3, "Outdoors", null],
  [4, "Books", null],
  [5, "Audio", 1],
  [6, "Computers", 1],
  [7, "Cookware", 2],
  [8, "Furniture", 2],
  [9, "Camping", 3],
  [10, "Cycling", 3],
];

// [name, list price in dollars]
const PRODUCTS: Record<number, [string, number][]> = {
  4: [["The Pragmatic Engineer", 39], ["Designing Data Systems", 45], ["Deep Work Notes", 18], ["SQL Field Guide", 29], ["Atlas of Clouds", 24], ["The Long Run", 16]],
  5: [["Aurora Headphones", 249], ["Pulse Earbuds", 129], ["Boom Speaker", 89], ["Studio Monitor", 399], ["Vinyl Turntable", 329], ["Soundbar Mini", 179]],
  6: [["Nimbus Laptop 14", 1299], ["Nimbus Laptop 16", 1899], ["Atlas Monitor 27", 449], ["Keystroke Keyboard", 119], ["Glide Mouse", 49], ["Dock Hub Pro", 199], ["Tablet Air", 599]],
  7: [["Cast Iron Skillet", 45], ["Chef Knife 8in", 89], ["Dutch Oven 5qt", 179], ["Nonstick Pan Set", 129], ["Pour-Over Kettle", 59], ["Spice Grinder", 35]],
  8: [["Oak Desk", 649], ["Ergo Chair", 499], ["Bookshelf Tall", 229], ["Floor Lamp", 119], ["Side Table", 99], ["Standing Desk Frame", 399]],
  9: [["Trail Tent 2P", 329], ["Down Sleeping Bag", 279], ["Camp Stove", 69], ["Headlamp 400", 39], ["Water Filter", 49], ["Trekking Poles", 99]],
  10: [["Road Helmet", 149], ["Bike Lights Set", 59], ["Cycling Gloves", 29], ["Saddle Bag", 39], ["Mini Pump", 25], ["Bike Lock U", 69]],
};

const COUNTRIES: [string, string[], number][] = [
  ["US", ["New York", "Austin", "Seattle", "Chicago", "Denver"], 0.38],
  ["GB", ["London", "Manchester", "Leeds"], 0.14],
  ["DE", ["Berlin", "Munich", "Hamburg"], 0.14],
  ["IN", ["Bengaluru", "Mumbai", "Delhi", "Pune"], 0.12],
  ["CA", ["Toronto", "Vancouver"], 0.08],
  ["FR", ["Paris", "Lyon"], 0.07],
  ["JP", ["Tokyo", "Osaka"], 0.07],
];

const FIRST = ["Ava", "Liam", "Mia", "Noah", "Zoe", "Arjun", "Priya", "Lena", "Jonas", "Emma", "Kenji", "Yuki", "Chloe", "Lucas", "Isha", "Omar", "Sara", "Theo", "Nina", "Ravi"];
const LAST = ["Smith", "Patel", "Müller", "Garcia", "Tanaka", "Brown", "Singh", "Martin", "Kim", "Lopez", "Wilson", "Sharma", "Dubois", "Schmidt", "Sato", "Clark"];
const STATUSES: [string, number][] = [["delivered", 0.68], ["shipped", 0.1], ["pending", 0.06], ["cancelled", 0.09], ["returned", 0.07]];
const REVIEW_BODIES: Record<number, string[]> = {
  1: ["Broke after a week.", "Not as described.", "Would not buy again."],
  2: ["Disappointing quality.", "Works, barely.", "Expected more for the price."],
  3: ["It's fine.", "Does the job.", "Average."],
  4: ["Really good.", "Happy with it.", "Solid value."],
  5: ["Excellent!", "Exceeded expectations.", "Best purchase this year."],
};

function pickWeighted<T>(r: () => number, items: [T, ...unknown[]][], weightIdx: number): T {
  const total = items.reduce((s, it) => s + (it[weightIdx] as number), 0);
  let x = r() * total;
  for (const it of items) {
    x -= it[weightIdx] as number;
    if (x <= 0) return it[0];
  }
  return items[items.length - 1][0];
}

function isoDate(start: Date, offsetDays: number): string {
  const d = new Date(start.getTime() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function seed(path = DB_PATH) {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) rmSync(p);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(ROOT, "db", "schema.sql"), "utf-8"));
  const r = rng(SEED);
  const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  db.exec("BEGIN");
  const insCat = db.prepare("INSERT INTO categories VALUES (?, ?, ?)");
  for (const c of CATEGORIES) insCat.run(...c);

  // Products
  const insProd = db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?)");
  const products: { id: number; price: number; cat: number }[] = [];
  let pid = 1;
  for (const [cat, items] of Object.entries(PRODUCTS)) {
    for (const [name, dollars] of items) {
      const price = dollars * 100 - 1; // xx.99 pricing
      insProd.run(pid, name, Number(cat), price, isoDate(new Date("2023-01-01"), ri(0, 600)));
      products.push({ id: pid, price, cat: Number(cat) });
      pid++;
    }
  }

  // Customers
  const insCust = db.prepare("INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?)");
  const NUM_CUSTOMERS = 400;
  const signup: string[] = [];
  for (let id = 1; id <= NUM_CUSTOMERS; id++) {
    const first = FIRST[ri(0, FIRST.length - 1)];
    const last = LAST[ri(0, LAST.length - 1)];
    const country = pickWeighted(r, COUNTRIES, 2);
    const cities = COUNTRIES.find((c) => c[0] === country)![1];
    const date = isoDate(new Date("2023-06-01"), ri(0, 820));
    signup[id] = date;
    insCust.run(
      id,
      `${first} ${last}`,
      `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}${id}@example.com`,
      country,
      cities[ri(0, cities.length - 1)],
      r() < 0.22 ? "business" : "consumer",
      date,
    );
  }

  // Orders + items (2024-01-01 .. 2025-12-31). Business customers order more.
  const insOrder = db.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?)");
  const insItem = db.prepare("INSERT INTO order_items VALUES (?, ?, ?, ?, ?, ?)");
  const orderStart = new Date("2024-01-01");
  let itemId = 1;
  const NUM_ORDERS = 2200;
  for (let oid = 1; oid <= NUM_ORDERS; oid++) {
    // Skew toward a subset of heavy customers.
    const cust = r() < 0.35 ? ri(1, 60) : ri(1, NUM_CUSTOMERS);
    // Seasonality: more orders in Nov/Dec. Never before the customer signed up.
    const signupDay = Math.max(0, Math.round((Date.parse(signup[cust]) - orderStart.getTime()) / 86_400_000));
    let day = ri(0, 730);
    if (r() < 0.18) day = (r() < 0.5 ? 305 : 670) + ri(0, 60);
    day = Math.min(730, Math.max(day, signupDay + ri(0, 45)));
    const date = isoDate(orderStart, day);
    const status = pickWeighted(r, STATUSES, 1);
    insOrder.run(oid, cust, date, status, [0, 0, 499, 799, 1299][ri(0, 4)]);
    const lines = ri(1, 4);
    const used = new Set<number>();
    for (let l = 0; l < lines; l++) {
      const p = products[ri(0, products.length - 1)];
      if (used.has(p.id)) continue;
      used.add(p.id);
      const qty = r() < 0.75 ? 1 : ri(2, 4);
      // Charged price drifts a little from list price over time.
      const charged = Math.round(p.price * (0.9 + r() * 0.15));
      const discount = r() < 0.7 ? 0 : [5, 10, 15, 20, 30][ri(0, 4)];
      insItem.run(itemId++, oid, p.id, qty, charged, discount);
    }
  }

  // Reviews: product quality bias so "best rated" questions have clear answers.
  const insRev = db.prepare("INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?)");
  for (let id = 1; id <= 900; id++) {
    const p = products[ri(0, products.length - 1)];
    const bias = ((p.id * 37) % 5) / 4; // 0..1, fixed per product
    const rating = Math.max(1, Math.min(5, Math.round(1.5 + bias * 3 + (r() - 0.5) * 2.2)));
    const bodies = REVIEW_BODIES[rating];
    insRev.run(id, p.id, ri(1, NUM_CUSTOMERS), rating, isoDate(orderStart, ri(0, 730)), bodies[ri(0, bodies.length - 1)]);
  }
  db.exec("COMMIT");
  const counts = Object.fromEntries(
    ["categories", "products", "customers", "orders", "order_items", "reviews"].map((t) => [
      t,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );
  db.close();
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = seed();
  console.log(`Seeded ${DB_PATH}`);
  console.table(counts);
}
