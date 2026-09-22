"use strict";

// Writes the repository the held-out eval cases run in to the current directory
// and commits it: `node heldout-fixture.js original|oriented`. It checks the
// navigation cases' two route lines on a second repository with its own layout,
// domain, map format and contract. Both snapshots hold the same code, tests and
// carrier contract, byte for byte. `oriented` adds a Start here section to
// AGENTS.md that routes returning-customer discounts to their library and an
// endpoint's batch or page size to that endpoint's contract entry.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function mapFile(oriented) {
  return [
    "# travel",
    "",
    "Booking platform: the booking service, the legacy gateway, and the libraries and integrations they share. Node 22 (`.nvmrc`), CommonJS, nothing to install or build.",
    "",
    ...(oriented
      ? [
          "## Start here",
          "",
          "- Before changing returning-customer discounts, go to `lib/fare-rules/`.",
          "- Before changing an endpoint's batch or page size, read that endpoint's entry under `## 6. Endpoints` in `reference/carrier-api.md`.",
          "",
        ]
      : []),
    "## Commands",
    "",
    "Run `npm test` for every test in the repository, or `node --test <file>` for one file.",
    "",
    "## Layout",
    "",
    "```text",
    "services/      deployable services, each with src/ and test/",
    "lib/           libraries the services share",
    "integrations/  clients for outside APIs",
    "reference/     contracts with outside partners",
    "```",
    "",
  ].join("\n");
}

const manifest = (fields) => `${JSON.stringify({ ...fields, private: true }, null, 2)}\n`;

const CODE = {
  "package.json": manifest({ name: "travel", scripts: { test: "node --test" } }),
  ".nvmrc": "22\n",
  "CLAUDE.md": "@AGENTS.md\n",

  "services/booking/package.json": manifest({ name: "@travel/booking" }),
  "services/booking/src/quote.js": `"use strict";

const { returningCustomerDiscount } = require("../../../lib/fare-rules");
const { serviceFeeCents } = require("./fees");

// A quote: the fare, less a returning customer's discount, plus the service fee
// of the traveller's country.
function quoteCents(fareCents, traveller) {
  const discounted = fareCents - returningCustomerDiscount(fareCents, traveller);
  return discounted + serviceFeeCents(traveller.country);
}

module.exports = { quoteCents };
`,
  "services/booking/src/fees.js": `"use strict";

// Service fee region of each country; a country not listed pays the non-EU fee.
const REGIONS = {
  DE: "eu",
  ES: "eu",
  FR: "eu",
  IT: "eu",
  NL: "eu",
  CH: "europe",
  GB: "europe",
  NO: "europe",
};

// Flat service fee of each region, in cents.
const FEES = { eu: 250, europe: 400, "non-eu": 900 };

function regionFor(country) {
  return REGIONS[country] ?? "non-eu";
}

function serviceFeeCents(country) {
  return FEES[regionFor(country)];
}

module.exports = { regionFor, serviceFeeCents, REGIONS, FEES };
`,
  "services/booking/test/quote.test.js": `"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { quoteCents } = require("../src/quote");

test("a traveller with five earlier trips pays eight percent less, plus the EU fee", () => {
  // 10000 - 800 discount + 250 fee.
  assert.strictEqual(quoteCents(10000, { previousTrips: 5, country: "DE" }), 9450);
});

test("a first trip pays the full fare", () => {
  assert.strictEqual(quoteCents(10000, { previousTrips: 0, country: "CH" }), 10400);
});
`,
  "services/booking/test/fees.test.js": `"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { serviceFeeCents } = require("../src/fees");

test("each region pays its own fee", () => {
  assert.strictEqual(serviceFeeCents("DE"), 250);
  assert.strictEqual(serviceFeeCents("GB"), 400);
  assert.strictEqual(serviceFeeCents("US"), 900);
});
`,

  "services/legacy-gateway/package.json": manifest({ name: "@travel/legacy-gateway" }),
  "services/legacy-gateway/src/pricing.js": `"use strict";

const { applyRepeatDiscount } = require("../../../lib/fares-v1");

// The v1 gateway prices a booking the way the first platform did.
function gatewayPriceCents(fareCents, customer) {
  return fareCents - applyRepeatDiscount(fareCents, customer);
}

module.exports = { gatewayPriceCents };
`,
  "services/legacy-gateway/test/pricing.test.js": `"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { gatewayPriceCents } = require("../src/pricing");

test("a repeat customer of the v1 gateway gets ten percent off", () => {
  assert.strictEqual(gatewayPriceCents(10000, { repeat: true }), 9000);
});
`,

  "lib/fare-rules/package.json": manifest({ name: "@travel/fare-rules", main: "src/index.js" }),
  "lib/fare-rules/src/index.js": `"use strict";

module.exports = { ...require("./returning-customer"), ...require("./seasons") };
`,
  "lib/fare-rules/src/returning-customer.js": `"use strict";

// A returning customer gets a share of the fare off, by how many trips they
// booked before.
const TIERS = [
  { trips: 10, percent: 12 },
  { trips: 5, percent: 8 },
  { trips: 2, percent: 5 },
];

function returningCustomerDiscount(fareCents, traveller) {
  const tier = TIERS.find((candidate) => (traveller.previousTrips ?? 0) >= candidate.trips);
  return tier ? Math.round((fareCents * tier.percent) / 100) : 0;
}

module.exports = { returningCustomerDiscount, TIERS };
`,
  "lib/fare-rules/src/seasons.js": `"use strict";

// Fares rise in the high season, from June to August.
function seasonFactor(month) {
  return month >= 6 && month <= 8 ? 1.2 : 1;
}

module.exports = { seasonFactor };
`,
  "lib/fare-rules/test/returning-customer.test.js": `"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { returningCustomerDiscount } = require("../src/returning-customer");

test("the discount follows the number of earlier trips", () => {
  assert.strictEqual(returningCustomerDiscount(10000, { previousTrips: 1 }), 0);
  assert.strictEqual(returningCustomerDiscount(10000, { previousTrips: 2 }), 500);
  assert.strictEqual(returningCustomerDiscount(10000, { previousTrips: 7 }), 800);
  assert.strictEqual(returningCustomerDiscount(10000, { previousTrips: 12 }), 1200);
});
`,

  "lib/fares-v1/package.json": manifest({ name: "@travel/fares-v1", main: "src/repeat.js" }),
  "lib/fares-v1/src/repeat.js": `"use strict";

// v1 pricing: a customer who booked before gets a flat ten percent off.
function applyRepeatDiscount(fareCents, customer) {
  return customer.repeat ? Math.round(fareCents / 10) : 0;
}

module.exports = { applyRepeatDiscount };
`,
  "lib/fares-v1/test/repeat.test.js": `"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { applyRepeatDiscount } = require("../src/repeat");

test("a repeat customer gets ten percent off", () => {
  assert.strictEqual(applyRepeatDiscount(5000, { repeat: true }), 500);
  assert.strictEqual(applyRepeatDiscount(5000, { repeat: false }), 0);
});
`,

  "lib/promotions/package.json": manifest({ name: "@travel/promotions", main: "src/codes.js" }),
  "lib/promotions/src/codes.js": `"use strict";

// Marketing codes. A returning booker gets a code for their next trip; the code
// itself is redeemed at checkout like any other promotion.
function repeatBookerCode(customer) {
  return \`BACK-\${String(customer.id).toUpperCase()}\`;
}

function promotionDiscount(fareCents, code) {
  return code.startsWith("BACK-") ? 1500 : 0;
}

module.exports = { repeatBookerCode, promotionDiscount };
`,
  "lib/promotions/test/codes.test.js": `"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { repeatBookerCode, promotionDiscount } = require("../src/codes");

test("a returning booker's code is worth 15.00", () => {
  const code = repeatBookerCode({ id: "c42" });
  assert.strictEqual(code, "BACK-C42");
  assert.strictEqual(promotionDiscount(10000, code), 1500);
});
`,

  "integrations/carrier/package.json": manifest({ name: "@travel/carrier", main: "src/manifests.js" }),
  "integrations/carrier/src/limits.js": `"use strict";

// Limits the carrier API enforces, from reference/carrier-api.md.
module.exports = {
  REQUESTS_PER_MINUTE: 90,
  MANIFEST_DEFAULT_BATCH: 100,
  MANIFEST_MAX_BATCH: 500,
  LABELS_MAX_BATCH: 40,
};
`,
  "integrations/carrier/src/manifests.js": `"use strict";

const { MANIFEST_DEFAULT_BATCH, MANIFEST_MAX_BATCH } = require("./limits");

// Splits the day's parcels into the batches POST /v3/manifests accepts.
function manifestBatches(parcels, size) {
  const batch = Math.min(size ?? MANIFEST_DEFAULT_BATCH, MANIFEST_MAX_BATCH);
  const batches = [];
  for (let start = 0; start < parcels.length; start += batch) batches.push(parcels.slice(start, start + batch));
  return batches;
}

module.exports = { manifestBatches };
`,
  "integrations/carrier/test/manifests.test.js": `"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { manifestBatches } = require("../src/manifests");
const { MANIFEST_DEFAULT_BATCH, MANIFEST_MAX_BATCH } = require("../src/limits");

const parcels = (n) => Array.from({ length: n }, (_, i) => ({ id: \`p\${i}\` }));

test("without a size, batches use the default", () => {
  const batches = manifestBatches(parcels(MANIFEST_DEFAULT_BATCH + 1));
  assert.strictEqual(batches.length, 2);
  assert.strictEqual(batches[0].length, MANIFEST_DEFAULT_BATCH);
});

test("a batch never exceeds the maximum", () => {
  for (const batch of manifestBatches(parcels(MANIFEST_MAX_BATCH * 2 + 3), MANIFEST_MAX_BATCH * 10)) {
    assert.ok(batch.length <= MANIFEST_MAX_BATCH);
  }
});
`,
};

// ---------------------------------------------------------------------------
// The carrier's API contract: long, and the batch sizes of one endpoint differ
// from the general batch rule that comes before them.

const HOST = "api.carrier.example";
const KEY = "<api-key>";
const c = (text) => "`" + text + "`";
const json = (value) => ["```json", ...JSON.stringify(value, null, 2).split("\n"), "```"];

function httpRequest(line, body) {
  const head = [`${line} HTTP/1.1`, `Host: ${HOST}`, `Authorization: Bearer ${KEY}`];
  if (body === undefined) return ["```http", ...head, "```"];
  return ["```http", ...head, "Content-Type: application/json", "", ...JSON.stringify(body, null, 2).split("\n"), "```"];
}

// Each resource: its route, a noun, its fields as [name, type, description,
// example], and the operations it offers. `batch` gives [default, maximum] for
// an operation that takes a list.
const RESOURCES = [
  ["accounts", "account", [["id", "string", "Account id.", "acc_7Q2L"], ["name", "string", "Trading name.", "Travel Logistics"], ["country", "string", "Country of the account.", "DE"], ["currency", "string", "Billing currency.", "EUR"], ["created_at", "string", "When it was opened.", "2025-11-03T08:00:00Z"]], ["get", "update"]],
  ["branches", "branch", [["id", "string", "Branch id.", "brn_2F8K"], ["name", "string", "Branch name.", "Hamburg Hafen"], ["address_id", "string", "Where the branch is.", "adr_9P1X"], ["opening_hours", "string", "Opening hours.", "Mo-Fr 07:00-19:00"], ["active", "boolean", "Whether it takes parcels.", true]], ["list", "get", "create", "update"]],
  ["depots", "depot", [["id", "string", "Depot id.", "dep_4M7C"], ["code", "string", "Sorting code.", "HAM1"], ["region", "string", "Region it serves.", "north"], ["cutoff", "string", "Latest drop-off time.", "18:30"], ["capacity", "integer", "Parcels a day.", 12000]], ["list", "get"]],
  ["drivers", "driver", [["id", "string", "Driver id.", "drv_8T3R"], ["name", "string", "Full name.", "Jonas Weber"], ["depot_id", "string", "Home depot.", "dep_4M7C"], ["vehicle", "string", "Vehicle class.", "van"], ["on_duty", "boolean", "Whether on duty now.", false]], ["list", "get"]],
  ["routes", "route", [["id", "string", "Route id.", "rte_5N2D"], ["depot_id", "string", "Depot it leaves from.", "dep_4M7C"], ["stops", "integer", "Planned stops.", 42], ["date", "string", "Service date.", "2026-03-02"], ["status", "string", "`planned`, `running` or `done`.", "planned"]], ["list", "get"]],
  ["zones", "zone", [["id", "string", "Zone id.", "zon_1H6J"], ["name", "string", "Zone name.", "Nordics"], ["countries", "array of strings", "Countries in the zone.", ["DK", "FI", "NO", "SE"]], ["surcharge", "integer", "Surcharge in cents.", 350]], ["list", "get"]],
  ["services", "service", [["id", "string", "Service code.", "express"], ["name", "string", "Service name.", "Express"], ["days", "integer", "Delivery days.", 1], ["tracked", "boolean", "Whether it is tracked.", true]], ["list", "get"]],
  ["service-points", "service point", [["id", "string", "Service point id.", "spt_3V9Q"], ["name", "string", "Shop name.", "Kiosk am Markt"], ["postal_code", "string", "Postal code.", "20095"], ["open_sundays", "boolean", "Open on Sundays.", false]], ["list", "get"]],
  ["webhooks", "webhook", [["id", "string", "Webhook id.", "whk_6C1B"], ["url", "string", "Where events are sent.", "https://travel.example/hooks/carrier"], ["events", "array of strings", "Event types sent.", ["parcel.delivered"]], ["active", "boolean", "Whether it is active.", true]], ["list", "get", "create", "update", "delete"]],
  ["addresses", "address", [["id", "string", "Address id.", "adr_9P1X"], ["line1", "string", "Street and number.", "Hafenstrasse 4"], ["postal_code", "string", "Postal code.", "20457"], ["city", "string", "City.", "Hamburg"], ["country", "string", "Country.", "DE"], ["verified", "boolean", "Whether it was verified.", true]], ["list", "get", "create"]],
  ["rates", "rate", [["service", "string", "Service code.", "express"], ["zone", "string", "Destination zone.", "Nordics"], ["amount", "integer", "Price in cents.", 1890], ["currency", "string", "Currency.", "EUR"], ["valid_until", "string", "End of validity.", "2026-06-30"]], ["list"]],
  ["shipments", "shipment", [["id", "string", "Shipment id.", "shp_2K8W"], ["reference", "string", "Your reference.", "BK-10492"], ["service", "string", "Service code.", "express"], ["parcels", "integer", "Number of parcels.", 2], ["status", "string", "`created`, `in_transit` or `delivered`.", "created"]], ["list", "get", "create", "update"]],
  ["parcels", "parcel", [["id", "string", "Parcel id.", "prc_7D4S"], ["shipment_id", "string", "Shipment.", "shp_2K8W"], ["weight", "integer", "Weight in grams.", 1250], ["tracking_number", "string", "Tracking number.", "CA123456789DE"], ["status", "string", "Last known status.", "created"]], ["list", "get", "create", "batch:300:75"]],
  ["labels", "label", [["id", "string", "Label id.", "lbl_9J2F"], ["parcel_id", "string", "Parcel.", "prc_7D4S"], ["format", "string", "`pdf` or `zpl`.", "pdf"], ["url", "string", "Where to fetch it.", "https://files.carrier.example/lbl_9J2F.pdf"]], ["get", "create", "batch:40:20"]],
  ["customs-declarations", "customs declaration", [["id", "string", "Declaration id.", "cus_5R8T"], ["shipment_id", "string", "Shipment.", "shp_2K8W"], ["contents", "string", "`goods`, `documents` or `gift`.", "goods"], ["value", "integer", "Declared value in cents.", 12000], ["currency", "string", "Currency.", "EUR"]], ["get", "create", "update"]],
  ["documents", "document", [["id", "string", "Document id.", "doc_3P6L"], ["shipment_id", "string", "Shipment.", "shp_2K8W"], ["type", "string", "`invoice` or `packing_list`.", "invoice"], ["url", "string", "Where to fetch it.", "https://files.carrier.example/doc_3P6L.pdf"]], ["list", "get", "create"]],
  ["tracking", "tracking record", [["tracking_number", "string", "Tracking number.", "CA123456789DE"], ["status", "string", "Last known status.", "in_transit"], ["location", "string", "Last scan.", "Hamburg HAM1"], ["updated_at", "string", "Last update.", "2026-03-02T14:05:00Z"]], ["get"]],
  ["events", "event", [["id", "string", "Event id.", "evt_1X7M"], ["type", "string", "Event type.", "parcel.scanned"], ["parcel_id", "string", "Parcel.", "prc_7D4S"], ["at", "string", "When it happened.", "2026-03-02T14:05:00Z"]], ["list:1000:200", "get"]],
  ["invoices", "invoice", [["id", "string", "Invoice id.", "inv_8B2N"], ["period", "string", "Billed month.", "2026-02"], ["amount", "integer", "Total in cents.", 482050], ["currency", "string", "Currency.", "EUR"], ["paid", "boolean", "Whether it is paid.", false]], ["list", "get"]],
  ["claims", "claim", [["id", "string", "Claim id.", "clm_4W9K"], ["parcel_id", "string", "Parcel.", "prc_7D4S"], ["type", "string", "`damage`, `loss` or `delay`.", "damage"], ["amount", "integer", "Claimed in cents.", 4990], ["status", "string", "`submitted`, `accepted` or `rejected`.", "submitted"]], ["list", "get", "create"]],
  ["returns", "return", [["id", "string", "Return id.", "ret_2Q5H"], ["parcel_id", "string", "Original parcel.", "prc_7D4S"], ["reason", "string", "Why it comes back.", "refused"], ["label_url", "string", "Return label.", "https://files.carrier.example/ret_2Q5H.pdf"]], ["list", "get", "create"]],
  ["collections", "collection", [["id", "string", "Collection id.", "col_6G3Z"], ["branch_id", "string", "Branch to collect from.", "brn_2F8K"], ["date", "string", "Collection date.", "2026-03-03"], ["window", "string", "Time window.", "14:00-16:00"], ["status", "string", "`booked` or `collected`.", "booked"]], ["list", "get", "create", "delete"]],
  ["pickups", "pickup", [["id", "string", "Pickup id.", "pck_9L1C"], ["address_id", "string", "Where to pick up.", "adr_9P1X"], ["date", "string", "Pickup date.", "2026-03-03"], ["parcels", "integer", "Parcels expected.", 12], ["status", "string", "`booked` or `done`.", "booked"]], ["list", "get", "create", "delete"]],
  ["manifests", "manifest", [["id", "string", "Manifest id.", "man_5T8V"], ["date", "string", "Day the manifest closes.", "2026-03-02"], ["parcels", "integer", "Parcels in it.", 25], ["status", "string", "`open` or `closed`.", "closed"], ["closed_at", "string", "When it closed.", "2026-03-02T18:45:00Z"]], ["manifest", "list", "get"]],
  ["reports", "report", [["id", "string", "Report id.", "rep_7K4P"], ["type", "string", "`volume` or `quality`.", "volume"], ["period", "string", "Month covered.", "2026-02"], ["url", "string", "Where to fetch it.", "https://files.carrier.example/rep_7K4P.csv"]], ["list", "get", "create"]],
];

const sample = (fields) => Object.fromEntries(fields.map(([name, , , example]) => [name, example]));
const table = (header, rows) => [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];
const capital = (text) => text[0].toUpperCase() + text.slice(1);

function operation(route, noun, fields, op) {
  const [kind, max, fallback] = op.split(":");
  const item = sample(fields);
  const inputs = fields.filter(([name]) => !["id", "status", "created_at", "updated_at", "closed_at"].includes(name));
  const id = fields[0][3];
  const errors = [["400", c("invalid_parameter"), "A parameter is missing or has the wrong type."], ["401", c("unauthorized"), "The key is missing or revoked."]];
  switch (kind) {
    case "list": {
      const [limit, def] = max ? [Number(max), Number(fallback)] : [100, 20];
      return {
        title: `GET /v3/${route}`,
        text: [`Lists the ${noun}s of the account, newest first. A page holds ${def} ${noun}s unless the request sets ${c("limit")}, and at most ${limit}; a larger ${c("limit")} fails with ${c("400 invalid_parameter")}.`],
        params: [["limit", "query", "integer", "no", `${capital(noun)}s per page, 1 to ${limit}. Default ${def}.`], ["cursor", "query", "string", "no", "Where the previous page ended."]],
        request: httpRequest(`GET /v3/${route}?limit=${def}`),
        status: 200,
        response: { data: [item], next_cursor: "c_2" },
        errors,
      };
    }
    case "get":
      return {
        title: `GET /v3/${route}/{id}`,
        text: [`Returns one ${noun}.`],
        params: [["id", "path", "string", "yes", `The ${noun}'s id.`]],
        request: httpRequest(`GET /v3/${route}/${id}`),
        status: 200,
        response: item,
        errors: [...errors, ["404", c("not_found"), `No ${noun} with that id in this account.`]],
      };
    case "create":
      return {
        title: `POST /v3/${route}`,
        text: [`Creates a ${noun}. The response holds the stored ${noun} with its id.`],
        params: inputs.map(([name, type, description]) => [name, "body", type, "yes", description]),
        request: httpRequest(`POST /v3/${route}`, sample(inputs)),
        status: 201,
        response: item,
        errors: [...errors, ["422", c("validation_failed"), "A field has a value the carrier does not accept."]],
      };
    case "update":
      return {
        title: `PATCH /v3/${route}/{id}`,
        text: [`Changes the fields the request names and keeps the others.`],
        params: [["id", "path", "string", "yes", `The ${noun}'s id.`], ...inputs.map(([name, type, description]) => [name, "body", type, "no", description])],
        request: httpRequest(`PATCH /v3/${route}/${id}`, sample(inputs.slice(0, 1))),
        status: 200,
        response: item,
        errors: [...errors, ["404", c("not_found"), `No ${noun} with that id in this account.`]],
      };
    case "delete":
      return {
        title: `DELETE /v3/${route}/{id}`,
        text: [`Removes a ${noun}. A removed ${noun} cannot be restored.`],
        params: [["id", "path", "string", "yes", `The ${noun}'s id.`]],
        request: httpRequest(`DELETE /v3/${route}/${id}`),
        status: 204,
        response: null,
        errors: [...errors, ["404", c("not_found"), `No ${noun} with that id in this account.`]],
      };
    case "batch":
      return {
        title: `POST /v3/${route}/batch`,
        text: [`Creates several ${noun}s in one request. A request takes at most ${max} ${noun}s, and ${fallback} when it gives no ${c("batch_size")}; a larger batch fails with ${c("413 batch_too_large")}.`],
        params: [["items", "body", "array", "yes", `The ${noun}s to create.`], ["batch_size", "body", "integer", "no", `${capital(noun)}s per request, 1 to ${max}. Default ${fallback}.`]],
        request: httpRequest(`POST /v3/${route}/batch`, { items: [sample(inputs)], batch_size: Number(fallback) }),
        status: 201,
        response: { data: [item] },
        errors: [...errors, ["413", c("batch_too_large"), `More than ${max} ${noun}s in one request.`]],
      };
    case "manifest":
      return {
        title: "POST /v3/manifests",
        text: [
          "Closes the day's parcels of a branch into a manifest; the carrier collects only manifested parcels. Send the parcels in batches: the first request opens the manifest and each later one adds to it, until a request sets `close` to `true`.",
          "",
          `Batches: a request takes at most 60 parcels, and 25 when it gives no ${c("batch_size")}. A larger batch fails with ${c("413 batch_too_large")}. These sizes apply to this endpoint only; section 3.4 does not.`,
        ],
        params: [["branch_id", "body", "string", "yes", "Branch whose parcels close."], ["parcel_ids", "body", "array of strings", "yes", "Parcels in this batch."], ["batch_size", "body", "integer", "no", "Parcels per request, 1 to 60. Default 25."], ["close", "body", "boolean", "no", "Closes the manifest after this batch."]],
        request: httpRequest("POST /v3/manifests", { branch_id: "brn_2F8K", parcel_ids: ["prc_7D4S", "prc_7D4T"], batch_size: 25, close: false }),
        status: 201,
        response: item,
        errors: [...errors, ["409", c("manifest_closed"), "The branch's manifest for that day is already closed."], ["413", c("batch_too_large"), "More than 60 parcels in one request."]],
      };
    default:
      throw new Error(`unknown operation ${op}`);
  }
}

function endpoints() {
  const lines = [];
  let n = 0;
  for (const [route, noun, fields, ops] of RESOURCES) {
    for (const op of ops) {
      const entry = operation(route, noun, fields, op);
      n += 1;
      lines.push(`### 6.${n} ${c(entry.title)}`, "", ...entry.text, "");
      lines.push("Parameters:", "", ...table(["Name", "In", "Type", "Required", "Description"], entry.params), "");
      lines.push("Request:", "", ...entry.request, "");
      if (entry.response === null) lines.push(`Response: ${c(String(entry.status))} with no body.`, "");
      else lines.push(`Response ${c(String(entry.status))}:`, "", ...json(entry.response), "");
      lines.push("Errors:", "", ...table(["Status", "Code", "When"], entry.errors), "");
    }
  }
  return lines;
}

function contract() {
  return [
    "# Carrier API v3",
    "",
    "The carrier's contract for booking platforms: how to create shipments and parcels, print labels, book collections, close manifests and follow parcels to their destination.",
    "",
    "## 1. Overview",
    "",
    `All requests go to ${c(`https://${HOST}`)} over HTTPS. Bodies are JSON, times are UTC in ISO 8601, and amounts are integers in cents. Resource ids start with a prefix that names their type, such as ${c("shp_")} for shipments.`,
    "",
    "The API is versioned in the path. Version 3 is current; version 2 was retired on 2026-01-31, and appendix A maps its endpoints to version 3.",
    "",
    "## 2. Authentication",
    "",
    "Every request carries the account's API key in the `Authorization` header:",
    "",
    "```http",
    `Authorization: Bearer ${KEY}`,
    "```",
    "",
    "An account holds two active keys at most, so a key can be rotated without downtime. A revoked key fails with `401 unauthorized` within one minute.",
    "",
    "## 3. Conventions",
    "",
    "### 3.1 Ids and references",
    "",
    "The carrier assigns every id. Your own reference goes in the `reference` field of a shipment; it is echoed on labels and invoices and need not be unique.",
    "",
    "### 3.2 Pagination",
    "",
    "A listing returns `data` and `next_cursor`. Pass `next_cursor` as `cursor` to get the following page; the last page has a `next_cursor` of `null`. Each listing states its own page sizes.",
    "",
    "### 3.3 Idempotency",
    "",
    "A `POST` may carry an `Idempotency-Key` header. The carrier keeps the first response for that key for 24 hours and returns it again for a repeated request.",
    "",
    "### 3.4 Batches",
    "",
    `An endpoint that takes a list of items accepts up to 500 items per request, and uses 100 when the request gives no ${c("batch_size")}. An endpoint's own entry in section 6 can set other sizes.`,
    "",
    "### 3.5 Rate limits",
    "",
    "An account may send 90 requests per minute. A request over the limit fails with `429 rate_limited` and a `Retry-After` header in seconds.",
    "",
    "## 4. Errors",
    "",
    "Errors return a JSON body with a machine-readable code and a message for people:",
    "",
    ...json({ error: { code: "validation_failed", message: "postal_code does not match city" } }),
    "",
    ...table(["Status", "Code", "Meaning"], [
      ["400", c("invalid_parameter"), "A parameter is missing or has the wrong type."],
      ["401", c("unauthorized"), "The key is missing or revoked."],
      ["404", c("not_found"), "The resource does not exist in this account."],
      ["409", c("conflict"), "The resource is in a state that forbids the request."],
      ["413", c("batch_too_large"), "A batch holds more items than the endpoint accepts."],
      ["422", c("validation_failed"), "A field has a value the carrier does not accept."],
      ["429", c("rate_limited"), "The account sent too many requests."],
      ["500", c("internal_error"), "The carrier failed; retry with backoff."],
    ]),
    "",
    "## 5. Webhooks",
    "",
    "A webhook receives a `POST` for each event it subscribes to. The body holds the event as `GET /v3/events/{id}` returns it. Answer with a `2xx` within ten seconds; the carrier retries other answers for up to three days, with growing pauses.",
    "",
    "Each delivery carries a `Carrier-Signature` header: an HMAC-SHA256 of the body with the webhook's secret. Reject deliveries whose signature does not match.",
    "",
    "## 6. Endpoints",
    "",
    "Endpoints are grouped by resource, from account setup to closing the day.",
    "",
    ...endpoints(),
    "## 7. Appendix A: version 2",
    "",
    "Version 2 was retired on 2026-01-31. Its endpoints map to version 3 as follows.",
    "",
    ...table(["Version 2", "Version 3", "Difference"], [
      [c("POST /v2/shipments"), c("POST /v3/shipments"), "Parcels are created separately in v3."],
      [c("GET /v2/shipments"), c("GET /v3/shipments"), "Cursor pagination replaces page numbers."],
      [c("POST /v2/labels"), c("POST /v3/labels"), "v3 also offers batches."],
      [c("POST /v2/manifests"), c("POST /v3/manifests"), "v2 took at most 250 parcels a request, 50 by default."],
      [c("GET /v2/tracking/{number}"), c("GET /v3/tracking/{id}"), "Same numbers."],
    ]),
    "",
  ].join("\n");
}

const variant = process.argv[2];
if (variant !== "original" && variant !== "oriented") {
  process.stderr.write("usage: node heldout-fixture.js original|oriented\n");
  process.exit(2);
}

const files = { ...CODE, "AGENTS.md": mapFile(variant === "oriented"), "reference/carrier-api.md": contract() };
const existing = Object.keys(files).filter((file) => fs.existsSync(file));
if (existing.length) {
  process.stderr.write(`refusing to overwrite ${existing.join(", ")}; run this in an empty directory\n`);
  process.exit(1);
}
for (const [file, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const at = "2026-03-02T09:00:00Z";
const git = (...args) =>
  execFileSync("git", args, { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
git("init", "-q");
git("add", "--", ...Object.keys(files));
git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
