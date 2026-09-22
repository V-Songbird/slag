"use strict";

// Writes the repository the navigation eval cases run in to the current
// directory and commits it: `node navigation-fixture.js original|oriented`.
// Both snapshots hold the same code, tests and partner contract, byte for byte.
// `oriented` adds a Start here section to AGENTS.md that routes member
// discounts and tax to their package and an endpoint's batch or page size to
// that endpoint's contract entry.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function mapFile(oriented) {
  return [
    "# shop",
    "",
    "Online store monorepo: the storefront, the public v1 API and the libraries they share. Node 22 (`.nvmrc`), CommonJS, nothing to install or build.",
    "",
    ...(oriented
      ? [
          "## Start here",
          "",
          "- Before changing member discounts or tax, go to `packages/price-engine/`.",
          "- Before changing an endpoint's batch or page size, read that endpoint's entry under `## 8. Endpoint reference` in `docs/partner-api.md`.",
          "",
        ]
      : []),
    "## Commands",
    "",
    "| Command | What it does | Cost |",
    "| --- | --- | --- |",
    "| `npm test` | Runs every test in the repository with `node --test` | Seconds |",
    "| `node --test <file>` | Runs one test file | Seconds |",
    "",
    "## Where things live",
    "",
    "| Path | Content |",
    "| --- | --- |",
    "| `apps/` | Deployable services, each with `src/` and `test/` |",
    "| `packages/` | Libraries the apps share, each with `src/` and `test/` |",
    "| `docs/` | Contracts with partners |",
    "",
  ].join("\n");
}

const manifest = (fields) => `${JSON.stringify({ ...fields, private: true }, null, 2)}\n`;

const CODE = {
  "package.json": manifest({ name: "shop", scripts: { test: "node --test" } }),
  ".nvmrc": "22\n",
  "CLAUDE.md": "@AGENTS.md\n",

  "apps/storefront/package.json": manifest({ name: "@shop/storefront" }),
  "apps/storefront/src/checkout.js": `"use strict";

const { memberDiscount, vatCents } = require("../../../packages/price-engine");
const { shippingCents } = require("./shipping");

// What the storefront charges for a cart, in cents: the items, less the
// member's discount, plus VAT on the discounted amount, plus shipping.
function checkoutTotal({ items, member, country }) {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const discounted = subtotal - memberDiscount(subtotal, member);
  return discounted + vatCents(discounted, country) + shippingCents(country);
}

module.exports = { checkoutTotal };
`,
  "apps/storefront/src/shipping.js": `"use strict";

// Shipping zone of each destination country. A country that is not listed
// ships at the world rate.
const ZONES = {
  DE: "domestic",
  AT: "eu",
  FR: "eu",
  NL: "eu",
  DK: "nordic",
  FI: "nordic",
  SE: "nordic",
};

// Flat shipping rate of each zone, in cents.
const RATES = { domestic: 490, eu: 990, nordic: 1290, world: 2490 };

function zoneFor(country) {
  return ZONES[country] ?? "world";
}

function shippingCents(country) {
  return RATES[zoneFor(country)];
}

module.exports = { zoneFor, shippingCents, ZONES, RATES };
`,
  "apps/storefront/test/checkout.test.js": `"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { checkoutTotal } = require("../src/checkout");

const cart = [{ priceCents: 10000, quantity: 1 }];

test("a gold member pays ten percent less before VAT and shipping", () => {
  // 10000 - 1000 discount = 9000, + 1710 VAT at 19%, + 490 domestic shipping.
  assert.strictEqual(checkoutTotal({ items: cart, member: { tier: "gold" }, country: "DE" }), 11200);
});

test("a guest pays the whole subtotal", () => {
  assert.strictEqual(checkoutTotal({ items: cart, member: null, country: "DE" }), 12390);
});
`,
  "apps/storefront/test/shipping.test.js": `"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { shippingCents } = require("../src/shipping");

test("each zone ships at its flat rate", () => {
  assert.strictEqual(shippingCents("DE"), 490);
  assert.strictEqual(shippingCents("FR"), 990);
  assert.strictEqual(shippingCents("SE"), 1290);
});

test("a country without a zone ships at the world rate", () => {
  assert.strictEqual(shippingCents("US"), 2490);
});
`,

  "apps/api-v1/package.json": manifest({ name: "@shop/api-v1" }),
  "apps/api-v1/src/prices.js": `"use strict";

const { applyLoyaltyDiscount } = require("../../../packages/pricing");

// The price the v1 API reports for an item and a customer's tier.
function v1Price({ priceCents, tier }) {
  return applyLoyaltyDiscount(priceCents, tier);
}

module.exports = { v1Price };
`,
  "apps/api-v1/test/prices.test.js": `"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { v1Price } = require("../src/prices");

test("a silver customer's v1 price is two percent lower", () => {
  assert.strictEqual(v1Price({ priceCents: 2000, tier: "silver" }), 1960);
});
`,

  "packages/pricing/package.json": manifest({ name: "@shop/pricing", description: "Price rules behind the public v1 API.", main: "src/index.js" }),
  "packages/pricing/src/index.js": `"use strict";

module.exports = { ...require("./loyalty") };
`,
  "packages/pricing/src/loyalty.js": `"use strict";

// Loyalty discount by customer tier: a flat share off the amount, rounded
// down to the cent.
const LOYALTY_RATES = { silver: 0.02, gold: 0.05 };

function applyLoyaltyDiscount(amountCents, tier) {
  return amountCents - Math.floor(amountCents * (LOYALTY_RATES[tier] ?? 0));
}

module.exports = { applyLoyaltyDiscount, LOYALTY_RATES };
`,
  "packages/pricing/test/loyalty.test.js": `"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { applyLoyaltyDiscount } = require("../src/loyalty");

test("gold takes five percent off, rounded down to the cent", () => {
  assert.strictEqual(applyLoyaltyDiscount(999, "gold"), 950);
});
`,

  "packages/price-engine/package.json": manifest({ name: "@shop/price-engine", main: "src/index.js" }),
  "packages/price-engine/src/index.js": `"use strict";

module.exports = { ...require("./member-discounts"), ...require("./tax") };
`,
  "packages/price-engine/src/member-discounts.js": `"use strict";

// Loyalty discount for storefront members, as a share of the order subtotal
// by membership tier.
const TIER_RATES = { bronze: 0, silver: 0.05, gold: 0.1 };

// The discount in cents; guests and unknown tiers get none.
function memberDiscount(subtotalCents, member) {
  return Math.round(subtotalCents * (TIER_RATES[member?.tier] ?? 0));
}

module.exports = { memberDiscount, TIER_RATES };
`,
  "packages/price-engine/src/tax.js": `"use strict";

// VAT rate of each destination country.
const VAT_RATES = { DE: 0.19, AT: 0.2, FR: 0.2, NL: 0.21, DK: 0.25, FI: 0.255, NO: 0.25, SE: 0.25 };

function vatCents(amountCents, country) {
  return Math.round(amountCents * (VAT_RATES[country] ?? 0));
}

module.exports = { vatCents, VAT_RATES };
`,
  "packages/price-engine/test/member-discounts.test.js": `"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { memberDiscount } = require("../src/member-discounts");

test("a gold member saves ten percent", () => {
  assert.strictEqual(memberDiscount(10000, { tier: "gold" }), 1000);
});

test("a guest saves nothing", () => {
  assert.strictEqual(memberDiscount(10000, null), 0);
});
`,

  "packages/quotes/package.json": manifest({ name: "@shop/quotes", main: "src/rebates.js" }),
  "packages/quotes/src/rebates.js": `"use strict";

// Loyalty rebate on a business quote: accounts in their third year or later
// get two percent back on quotes above 1,000.00.
function loyaltyRebate(quoteCents, accountYears) {
  return quoteCents > 100000 && accountYears >= 2 ? Math.round(quoteCents * 0.02) : 0;
}

module.exports = { loyaltyRebate };
`,
  "packages/quotes/test/rebates.test.js": `"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { loyaltyRebate } = require("../src/rebates");

test("only long-standing accounts get a rebate, and only on large quotes", () => {
  assert.strictEqual(loyaltyRebate(250000, 3), 5000);
  assert.strictEqual(loyaltyRebate(50000, 3), 0);
  assert.strictEqual(loyaltyRebate(250000, 1), 0);
});
`,

  "packages/partner-client/package.json": manifest({ name: "@shop/partner-client", main: "src/shipments.js" }),
  "packages/partner-client/src/limits.js": `"use strict";

// Limits the partner API enforces on this client. Every value comes from the
// partner's API contract in docs/partner-api.md.
module.exports = {
  REQUESTS_PER_MINUTE: 120,
  SHIPMENTS_DEFAULT_PAGE_SIZE: 50,
  SHIPMENTS_MAX_PAGE_SIZE: 200,
  LABELS_MAX_BATCH: 25,
};
`,
  "packages/partner-client/src/shipments.js": `"use strict";

const { SHIPMENTS_DEFAULT_PAGE_SIZE, SHIPMENTS_MAX_PAGE_SIZE } = require("./limits");

// The query string for one page of GET /v2/shipments.
function shipmentsQuery({ limit = SHIPMENTS_DEFAULT_PAGE_SIZE, cursor, status } = {}) {
  const query = new URLSearchParams({ limit: String(Math.min(limit, SHIPMENTS_MAX_PAGE_SIZE)) });
  if (cursor) query.set("cursor", cursor);
  if (status) query.set("status", status);
  return query.toString();
}

module.exports = { shipmentsQuery };
`,
  "packages/partner-client/test/shipments.test.js": `"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { shipmentsQuery } = require("../src/shipments");
const { SHIPMENTS_DEFAULT_PAGE_SIZE, SHIPMENTS_MAX_PAGE_SIZE } = require("../src/limits");

const param = (query, name) => new URLSearchParams(query).get(name);

test("a page without a size asks for the default size", () => {
  assert.strictEqual(param(shipmentsQuery(), "limit"), String(SHIPMENTS_DEFAULT_PAGE_SIZE));
});

test("a page never asks for more than the maximum", () => {
  assert.strictEqual(param(shipmentsQuery({ limit: 10000 }), "limit"), String(SHIPMENTS_MAX_PAGE_SIZE));
});

test("the cursor and the status filter are passed on", () => {
  const query = shipmentsQuery({ cursor: "c_2", status: "in_transit" });
  assert.strictEqual(param(query, "cursor"), "c_2");
  assert.strictEqual(param(query, "status"), "in_transit");
});
`,
};

// ---------------------------------------------------------------------------
// The partner's API contract: long, and the page sizes of one endpoint differ
// from the general pagination rule that comes before them. It is kept beside
// this script, in navigation-partner-api.md, as the text both snapshots commit.
function contract() {
  return fs.readFileSync(path.join(__dirname, "navigation-partner-api.md"), "utf8").replace(/\r\n/g, "\n");
}

const variant = process.argv[2];
if (variant !== "original" && variant !== "oriented") {
  process.stderr.write("usage: node navigation-fixture.js original|oriented\n");
  process.exit(2);
}

const files = { ...CODE, "AGENTS.md": mapFile(variant === "oriented"), "docs/partner-api.md": contract() };
const existing = Object.keys(files).filter((file) => fs.existsSync(file));
if (existing.length) {
  process.stderr.write(`refusing to overwrite ${existing.join(", ")}; run this in an empty directory\n`);
  process.exit(1);
}
for (const [file, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const at = "2026-02-02T09:00:00Z";
const git = (...args) =>
  execFileSync("git", args, { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
git("init", "-q");
git("add", "--", ...Object.keys(files));
git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
