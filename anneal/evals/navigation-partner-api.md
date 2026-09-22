# Partner Logistics API

Contract version 2.6, in force since 2026-02-01. It describes the HTTP API the logistics partner runs for merchants: what a request must contain, what each endpoint returns and the limits the partner enforces. Where this document and the API disagree, the partner treats the document as correct and fixes the API.

## Contents

1. Scope
2. Environments
3. Authentication
4. Requests and responses
5. Errors
6. Rate limits
7. Pagination
8. Endpoint reference
9. Webhooks
10. Data formats
11. Service levels
12. Change log

Appendix A. Retired v1 API

## 1. Scope

This contract covers version 2 of the API, served under `/v2/`. It applies to every merchant account opened after 2024-06-01 and to older accounts once they migrated. Version 1 was retired on 2025-06-30; Appendix A keeps its description for merchants who still map old records.

It does not cover the warehouse service, customs brokerage or the merchant portal, which have contracts of their own.

The words must, must not, should and may carry their usual specification meaning. The partner checks every must, and a request that breaks one fails.

## 2. Environments

| Environment | Base URL | Purpose |
| --- | --- | --- |
| Sandbox | `https://sandbox.partner.example` | Integration tests. Labels carry a watermark, pickups are never dispatched and invoices stay empty. |
| Production | `https://api.partner.example` | Live shipments. Every label created here is billed. |

Sandbox data is deleted 30 days after it was created. Both environments deliver webhooks; a sandbox delivery carries the header `Partner-Environment: sandbox`.

Keys are issued per environment. A sandbox key used against production fails with `401 unauthorized`, and the reverse fails the same way.

## 3. Authentication

Every request carries an API key in the `Authorization` header:

```http
Authorization: Bearer <api-key>
```

Production keys start with `pk_live_`, sandbox keys with `pk_test_`. A merchant can hold two active keys per environment, so a key can be rotated without downtime: create the second key, deploy it, then revoke the first. A revoked key fails with `401 unauthorized` within one minute.

Keys carry the merchant's full permissions; there are no scoped keys. Keep them out of client-side code and logs. The partner revokes a key it finds in a public place and tells the merchant's technical contact.

Webhook deliveries are authenticated the other way round, with a signature the merchant checks; see section 9.

## 4. Requests and responses

Request and response bodies are JSON in UTF-8, sent with `Content-Type: application/json`. A request body may be at most 1 MB.

- **Idempotency.** Every `POST` must carry an `Idempotency-Key` header, a string of at most 64 characters that is unique per operation. The partner keeps each key for 24 hours. Repeating a request with the same key and body returns the first response again; the same key with another body fails with `409 idempotency_conflict`.
- **Timestamps.** Every timestamp is RFC 3339 in UTC, such as `2026-02-03T08:15:00Z`. A date without a time, such as a pickup date, is `YYYY-MM-DD` in the local calendar of the address it concerns.
- **Unknown fields.** The partner ignores request fields it does not know. Responses can gain fields at any time without a new version, so a client must ignore fields it does not know.
- **Language.** Texts meant for recipients, such as event descriptions, follow `Accept-Language`, and English is used when the header names no supported language. Supported: `da`, `de`, `en`, `fi`, `fr`, `nb`, `nl`, `sv`.
- **Request ids.** Every response carries a `Request-Id` header. Quote it when asking the partner about a request.

Section 12 announces a removed field at least 90 days before it disappears.

## 5. Errors

An error response has a status from the table below and a body of this shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "recipient.postal_code is not a postal code of recipient.country",
    "details": [
      {
        "field": "recipient.postal_code",
        "rule": "postal_code_format"
      }
    ]
  }
}
```

`code` is stable and meant for programs; `message` is meant for people and can change without notice.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | The body is not JSON, or a query parameter has the wrong type. |
| 401 | `unauthorized` | The key is missing, unknown, revoked or from the other environment. |
| 403 | `forbidden` | The key is valid but the account may not use the endpoint, such as returns on an account without the returns service. |
| 404 | `not_found` | No such resource in this account. |
| 409 | `conflict` | The resource is in a state that forbids the operation, such as cancelling a delivered shipment. |
| 409 | `idempotency_conflict` | The `Idempotency-Key` was used before with another body. |
| 422 | `validation_failed` | A field breaks a rule of section 10; `details` names each field. |
| 422 | `limit_exceeded` | A `limit` above the endpoint's maximum page size, or a batch larger than the endpoint allows. |
| 429 | `rate_limited` | The key sent more requests than section 6 allows. |
| 500 | `internal_error` | A fault on the partner's side. |
| 503 | `unavailable` | Maintenance; `Retry-After` gives the seconds to wait. |

Retry `429`, `500` and `503` with exponential backoff, starting at one second and never more than one minute apart. Do not retry other errors unchanged; they fail the same way again.

## 6. Rate limits

Each API key may send 120 requests per minute, counted over a sliding window of 60 seconds. Within that budget, bursts of up to 20 requests per second are accepted.

Every response reports the budget:

| Header | Meaning |
| --- | --- |
| `RateLimit-Limit` | Requests allowed per window, currently 120. |
| `RateLimit-Remaining` | Requests left in the current window. |
| `RateLimit-Reset` | Seconds until the oldest request leaves the window. |

A request over the budget fails with `429 rate_limited` and a `Retry-After` header in seconds. Requests refused this way still count against the window, so a client that retries at once stays limited.

Batch endpoints have ceilings of their own, stated in their entries in section 8. `POST /v2/labels` is the only one today.

## 7. Pagination

Listing endpoints return one page at a time, newest first:

```json
{
  "data": [
    "..."
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

To fetch the next page, repeat the request with `cursor` set to the previous page's `next_cursor` and with the same filters. On the last page `has_more` is `false` and `next_cursor` is `null`. A cursor expires after 24 hours; an expired cursor fails with `400 invalid_request`.

`limit` sets the page size. Unless an endpoint's entry in section 8 gives its own page sizes, `limit` defaults to 50 and may be at most 200. A `limit` above the maximum fails with `422 limit_exceeded`; the partner never shortens a page silently.

Pass `order=asc` for oldest first. Changing `order` or a filter between pages restarts the listing.

## 8. Endpoint reference

Endpoints are grouped by resource, in alphabetical order. Each entry lists its parameters, the fields of a successful response and the errors particular to it; the errors of section 5 can occur anywhere. Examples use the production host.

### Addresses

Checks addresses before a shipment is created.

#### 8.1 POST /v2/addresses/validate

Checks an address against the postal data of its country and suggests a corrected form. It creates nothing and is not billed.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | body | string | yes | Recipient name. |
| `line1` | body | string | yes | Street and number. |
| `line2` | body | string | no | Second address line. |
| `postal_code` | body | string | yes | Postal code. |
| `city` | body | string | yes | City. |
| `country` | body | string | yes | Country code. |

Response `200`: the verdict:

| Field | Type | Description |
| --- | --- | --- |
| `valid` | boolean | Whether the address can be delivered to as sent. |
| `suggestion` | object or null | A corrected address, when the partner found one. |
| `problems` | array of strings | What is wrong with the address as sent. |

Errors: `422 validation_failed` for a country the partner does not serve.

Example:

```http
POST /v2/addresses/validate HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "name": "Lina Berg",
  "line1": "Storgatan 12",
  "postal_code": "11415",
  "city": "Stockholm",
  "country": "SE",
  "phone": "+46701234567"
}
```

```json
{
  "valid": false,
  "suggestion": {
    "name": "Lina Berg",
    "line1": "Storgatan 12",
    "postal_code": "11451",
    "city": "Stockholm",
    "country": "SE",
    "phone": "+46701234567"
  },
  "problems": [
    "postal_code does not match city"
  ]
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "country XK is not served",
    "details": [
      {
        "field": "country",
        "rule": "served_country"
      }
    ]
  }
}
```

### Claims

Compensation requests for damaged, lost or late parcels.

#### 8.2 POST /v2/claims

Submits a claim. A `damage` or `loss` claim must arrive within 30 days of the shipment's last event, a `delay` claim within 30 days of delivery; section 11 limits the amount.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `shipment_id` | body | string | yes | Shipment of this account. |
| `type` | body | string | yes | `damage`, `loss` or `delay`. |
| `amount` | body | integer | yes | Amount claimed, in minor units. |
| `currency` | body | string | yes | ISO 4217 code. |
| `description` | body | string | yes | What happened, at most 2000 characters. |

Response `201`: the new claim:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Claim id. |
| `shipment_id` | string | Shipment the claim concerns. |
| `type` | string | `damage`, `loss` or `delay`. |
| `amount` | integer | Amount claimed, in minor units. |
| `currency` | string | ISO 4217 code. |
| `status` | string | `submitted`, `accepted`, `rejected` or `paid`. |
| `submitted_at` | string | When it was submitted. |
| `decided_at` | string or null | When the partner decided it. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/claims HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "shipment_id": "shp_4K9T2B",
  "type": "damage",
  "amount": 4990,
  "currency": "EUR",
  "description": "The lid of the box was crushed."
}
```

```json
{
  "id": "clm_6P2V7N",
  "shipment_id": "shp_4K9T2B",
  "type": "damage",
  "amount": 4990,
  "currency": "EUR",
  "status": "submitted",
  "submitted_at": "2026-02-09T12:30:00Z",
  "decided_at": null
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "shipment_id is required",
    "details": [
      {
        "field": "shipment_id",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.3 GET /v2/claims

Lists claims, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `status` | query | string | no | Only claims in this status. |
| `shipment_id` | query | string | no | Only claims about this shipment. |

Response `200`: a page whose `data` holds claims:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Claim id. |
| `shipment_id` | string | Shipment the claim concerns. |
| `type` | string | `damage`, `loss` or `delay`. |
| `amount` | integer | Amount claimed, in minor units. |
| `currency` | string | ISO 4217 code. |
| `status` | string | `submitted`, `accepted`, `rejected` or `paid`. |
| `submitted_at` | string | When it was submitted. |
| `decided_at` | string or null | When the partner decided it. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/claims?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "clm_6P2V7N",
      "shipment_id": "shp_4K9T2B",
      "type": "damage",
      "amount": 4990,
      "currency": "EUR",
      "status": "submitted",
      "submitted_at": "2026-02-09T12:30:00Z",
      "decided_at": null
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.4 GET /v2/claims/{id}

Returns one claim.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Claim id. |

Response `200`: the claim:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Claim id. |
| `shipment_id` | string | Shipment the claim concerns. |
| `type` | string | `damage`, `loss` or `delay`. |
| `amount` | integer | Amount claimed, in minor units. |
| `currency` | string | ISO 4217 code. |
| `status` | string | `submitted`, `accepted`, `rejected` or `paid`. |
| `submitted_at` | string | When it was submitted. |
| `decided_at` | string or null | When the partner decided it. |

Errors: `404 not_found`.

Example:

```http
GET /v2/claims/clm_6P2V7N HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "clm_6P2V7N",
  "shipment_id": "shp_4K9T2B",
  "type": "damage",
  "amount": 4990,
  "currency": "EUR",
  "status": "submitted",
  "submitted_at": "2026-02-09T12:30:00Z",
  "decided_at": null
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no claim clm_6P2V7N in this account"
  }
}
```

### Coverage

Where each service delivers.

#### 8.5 GET /v2/coverage

Tells whether a service reaches a postal code, and when the next delivery there could happen. `same_day` covers only some postal codes of a city.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `country` | query | string | yes | Destination country. |
| `postal_code` | query | string | yes | Destination postal code. |
| `service` | query | string | yes | Service code, see section 11. |

Response `200`: the coverage:

| Field | Type | Description |
| --- | --- | --- |
| `country` | string | As asked. |
| `postal_code` | string | As asked. |
| `service` | string | As asked. |
| `available` | boolean | Whether the service delivers there. |
| `next_delivery_date` | string or null | Earliest delivery for a label created now. |

Errors: `422 validation_failed` for a postal code that does not exist.

Example:

```http
GET /v2/coverage?country=SE&postal_code=11451&service=express HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "country": "SE",
  "postal_code": "11451",
  "service": "express",
  "available": true,
  "next_delivery_date": "2026-02-05"
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "postal_code 99999 does not exist in SE",
    "details": [
      {
        "field": "postal_code",
        "rule": "postal_code_exists"
      }
    ]
  }
}
```

### Customs declarations

Contents and value of shipments that leave the EU customs union.

#### 8.6 POST /v2/customs-declarations

Declares the contents of a shipment to a country outside the EU customs union, such as `NO`, `CH` or `GB`. A label for such a shipment fails until a declaration exists.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `shipment_id` | body | string | yes | A shipment in status `created`. |
| `contents_type` | body | string | yes | One of the types above. |
| `items` | body | array of objects | yes | 1 to 50 items. |
| `invoice_number` | body | string | no | Required when `contents_type` is `goods`. |

Response `201`: the new customs declaration:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Declaration id. |
| `shipment_id` | string | Shipment it declares. |
| `contents_type` | string | `goods`, `gift`, `documents`, `sample` or `return`. |
| `items` | array of objects | One entry per kind of item, with `description`, `quantity`, `value`, `currency`, `hs_code` and `origin_country`. |
| `invoice_number` | string or null | The merchant's invoice for the goods. |
| `created_at` | string | When it was created. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/customs-declarations HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "shipment_id": "shp_7D2H6W",
  "contents_type": "goods",
  "items": [
    {
      "description": "Cotton t-shirt",
      "quantity": 2,
      "value": 1990,
      "currency": "EUR",
      "hs_code": "610910",
      "origin_country": "PT"
    }
  ],
  "invoice_number": "INV-2026-0142"
}
```

```json
{
  "id": "cus_1R8F3M",
  "shipment_id": "shp_7D2H6W",
  "contents_type": "goods",
  "items": [
    {
      "description": "Cotton t-shirt",
      "quantity": 2,
      "value": 1990,
      "currency": "EUR",
      "hs_code": "610910",
      "origin_country": "PT"
    }
  ],
  "invoice_number": "INV-2026-0142",
  "created_at": "2026-02-03T07:45:00Z"
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "shipment_id is required",
    "details": [
      {
        "field": "shipment_id",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.7 GET /v2/customs-declarations/{id}

Returns one customs declaration.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Customs declaration id. |

Response `200`: the customs declaration:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Declaration id. |
| `shipment_id` | string | Shipment it declares. |
| `contents_type` | string | `goods`, `gift`, `documents`, `sample` or `return`. |
| `items` | array of objects | One entry per kind of item, with `description`, `quantity`, `value`, `currency`, `hs_code` and `origin_country`. |
| `invoice_number` | string or null | The merchant's invoice for the goods. |
| `created_at` | string | When it was created. |

Errors: `404 not_found`.

Example:

```http
GET /v2/customs-declarations/cus_1R8F3M HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "cus_1R8F3M",
  "shipment_id": "shp_7D2H6W",
  "contents_type": "goods",
  "items": [
    {
      "description": "Cotton t-shirt",
      "quantity": 2,
      "value": 1990,
      "currency": "EUR",
      "hs_code": "610910",
      "origin_country": "PT"
    }
  ],
  "invoice_number": "INV-2026-0142",
  "created_at": "2026-02-03T07:45:00Z"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no customs declaration cus_1R8F3M in this account"
  }
}
```

### Documents

Proofs of delivery, delivery notes and commercial invoices the partner produces.

#### 8.8 GET /v2/documents

Lists documents, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `shipment_id` | query | string | no | Only documents of this shipment. |
| `type` | query | string | no | Only documents of this type. |

Response `200`: a page whose `data` holds documents:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Document id. |
| `shipment_id` | string | Shipment it belongs to. |
| `type` | string | `proof_of_delivery`, `delivery_note` or `commercial_invoice`. |
| `url` | string | PDF download link, valid for one hour. |
| `created_at` | string | When it was produced. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/documents?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "doc_4S9B2K",
      "shipment_id": "shp_4K9T2B",
      "type": "proof_of_delivery",
      "url": "https://files.partner.example/documents/doc_4S9B2K.pdf",
      "created_at": "2026-02-05T16:20:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.9 GET /v2/documents/{id}

Returns one document.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Document id. |

Response `200`: the document:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Document id. |
| `shipment_id` | string | Shipment it belongs to. |
| `type` | string | `proof_of_delivery`, `delivery_note` or `commercial_invoice`. |
| `url` | string | PDF download link, valid for one hour. |
| `created_at` | string | When it was produced. |

Errors: `404 not_found`.

Example:

```http
GET /v2/documents/doc_4S9B2K HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "doc_4S9B2K",
  "shipment_id": "shp_4K9T2B",
  "type": "proof_of_delivery",
  "url": "https://files.partner.example/documents/doc_4S9B2K.pdf",
  "created_at": "2026-02-05T16:20:00Z"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no document doc_4S9B2K in this account"
  }
}
```

### Events

What happened to a shipment, from scans and status changes. Webhooks deliver the same objects (section 9).

#### 8.10 GET /v2/events

Lists events, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size. Default 100, maximum 1000. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `shipment_id` | query | string | no | Only events of this shipment. |
| `type` | query | string | no | Only events of this type. |
| `since` | query | string | no | Only events after this timestamp. |

Response `200`: a page whose `data` holds events:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Event id. Deduplicate webhook deliveries by it. |
| `shipment_id` | string | Shipment the event belongs to. |
| `type` | string | One of the event types in section 9. |
| `occurred_at` | string | When it happened. |
| `location` | string or null | Depot or city, when known. |
| `description` | string | Text for the recipient, in the language of the request. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/events?limit=100 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "evt_7Q2M4X",
      "shipment_id": "shp_4K9T2B",
      "type": "shipment.in_transit",
      "occurred_at": "2026-02-03T08:15:00Z",
      "location": "Hamburg depot",
      "description": "The parcel left the depot."
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 1000"
  }
}
```

### Invoices

Monthly invoices for labels, pickups and surcharges.

#### 8.11 GET /v2/invoices

Lists invoices, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `status` | query | string | no | Only invoices in this status. |

Response `200`: a page whose `data` holds invoices:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Invoice id. |
| `period_start` | string | First day billed. |
| `period_end` | string | Last day billed. |
| `currency` | string | ISO 4217 code. |
| `total` | integer | Amount due in minor units, VAT included. |
| `status` | string | `open`, `paid` or `overdue`. |
| `due_on` | string | Date by which it must be paid. |
| `pdf_url` | string | Link to the PDF, valid for one hour. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/invoices?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "inv_2026_01",
      "period_start": "2026-01-01",
      "period_end": "2026-01-31",
      "currency": "EUR",
      "total": 184250,
      "status": "open",
      "due_on": "2026-02-15",
      "pdf_url": "https://files.partner.example/invoices/inv_2026_01.pdf"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.12 GET /v2/invoices/{id}

Returns one invoice.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Invoice id. |

Response `200`: the invoice:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Invoice id. |
| `period_start` | string | First day billed. |
| `period_end` | string | Last day billed. |
| `currency` | string | ISO 4217 code. |
| `total` | integer | Amount due in minor units, VAT included. |
| `status` | string | `open`, `paid` or `overdue`. |
| `due_on` | string | Date by which it must be paid. |
| `pdf_url` | string | Link to the PDF, valid for one hour. |

Errors: `404 not_found`.

Example:

```http
GET /v2/invoices/inv_2026_01 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "inv_2026_01",
  "period_start": "2026-01-01",
  "period_end": "2026-01-31",
  "currency": "EUR",
  "total": 184250,
  "status": "open",
  "due_on": "2026-02-15",
  "pdf_url": "https://files.partner.example/invoices/inv_2026_01.pdf"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no invoice inv_2026_01 in this account"
  }
}
```

### Labels

Shipping labels. A shipment is billed once it has a label.

#### 8.13 POST /v2/labels

Creates one label per shipment, for at most 25 shipments per request; a larger batch fails with `422 limit_exceeded`. Each shipment must be in status `created`.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `shipment_ids` | body | array of strings | yes | Shipments to label, at most 25. |
| `format` | body | string | no | `pdf` (default) or `zpl`. |
| `size` | body | string | no | `a6` (default) or `a4`. |

Response `201`: an object whose `data` holds the new labels:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Label id. |
| `shipment_id` | string | Shipment it belongs to. |
| `format` | string | `pdf` or `zpl`. |
| `size` | string | `a6` or `a4`. |
| `url` | string | Download link, valid until `expires_at`. |
| `created_at` | string | When it was created. |
| `expires_at` | string | When `url` stops working. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/labels HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "shipment_ids": [
    "shp_4K9T2B",
    "shp_4K9T2C"
  ],
  "format": "pdf",
  "size": "a6"
}
```

```json
{
  "data": [
    {
      "id": "lbl_8H3N5P",
      "shipment_id": "shp_4K9T2B",
      "format": "pdf",
      "size": "a6",
      "url": "https://files.partner.example/labels/lbl_8H3N5P.pdf",
      "created_at": "2026-02-03T07:58:00Z",
      "expires_at": "2026-02-10T07:58:00Z"
    },
    {
      "id": "lbl_8H3N5P2",
      "shipment_id": "shp_4K9T2C",
      "format": "pdf",
      "size": "a6",
      "url": "https://files.partner.example/labels/lbl_8H3N5P.pdf",
      "created_at": "2026-02-03T07:58:00Z",
      "expires_at": "2026-02-10T07:58:00Z"
    }
  ]
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "shipment_ids is required",
    "details": [
      {
        "field": "shipment_ids",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.14 GET /v2/labels

Lists labels, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `shipment_id` | query | string | no | Only labels of this shipment. |

Response `200`: a page whose `data` holds labels:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Label id. |
| `shipment_id` | string | Shipment it belongs to. |
| `format` | string | `pdf` or `zpl`. |
| `size` | string | `a6` or `a4`. |
| `url` | string | Download link, valid until `expires_at`. |
| `created_at` | string | When it was created. |
| `expires_at` | string | When `url` stops working. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/labels?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "lbl_8H3N5P",
      "shipment_id": "shp_4K9T2B",
      "format": "pdf",
      "size": "a6",
      "url": "https://files.partner.example/labels/lbl_8H3N5P.pdf",
      "created_at": "2026-02-03T07:58:00Z",
      "expires_at": "2026-02-10T07:58:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.15 GET /v2/labels/{id}

Returns one label.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Label id. |

Response `200`: the label:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Label id. |
| `shipment_id` | string | Shipment it belongs to. |
| `format` | string | `pdf` or `zpl`. |
| `size` | string | `a6` or `a4`. |
| `url` | string | Download link, valid until `expires_at`. |
| `created_at` | string | When it was created. |
| `expires_at` | string | When `url` stops working. |

Errors: `404 not_found`.

Example:

```http
GET /v2/labels/lbl_8H3N5P HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "lbl_8H3N5P",
  "shipment_id": "shp_4K9T2B",
  "format": "pdf",
  "size": "a6",
  "url": "https://files.partner.example/labels/lbl_8H3N5P.pdf",
  "created_at": "2026-02-03T07:58:00Z",
  "expires_at": "2026-02-10T07:58:00Z"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no label lbl_8H3N5P in this account"
  }
}
```

### Manifests

End-of-day lists of the labelled shipments a driver collects.

#### 8.16 POST /v2/manifests

Closes a day: lists every labelled shipment of that date that is on no manifest yet. A shipment labelled after the manifest closed goes on the next one.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `date` | body | string | yes | Today or a past date with labelled shipments. |

Response `201`: the new manifest:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Manifest id. |
| `date` | string | Collection date it covers. |
| `shipment_ids` | array of strings | Shipments on the manifest. |
| `pdf_url` | string | Printable manifest for the driver to sign. |
| `created_at` | string | When it was closed. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/manifests HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "date": "2026-02-03"
}
```

```json
{
  "id": "man_3N7Q1Z",
  "date": "2026-02-03",
  "shipment_ids": [
    "shp_4K9T2B",
    "shp_4K9T2C"
  ],
  "pdf_url": "https://files.partner.example/manifests/man_3N7Q1Z.pdf",
  "created_at": "2026-02-03T16:05:00Z"
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "date is required",
    "details": [
      {
        "field": "date",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.17 GET /v2/manifests

Lists manifests, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `date` | query | string | no | Only the manifest of this date. |

Response `200`: a page whose `data` holds manifests:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Manifest id. |
| `date` | string | Collection date it covers. |
| `shipment_ids` | array of strings | Shipments on the manifest. |
| `pdf_url` | string | Printable manifest for the driver to sign. |
| `created_at` | string | When it was closed. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/manifests?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "man_3N7Q1Z",
      "date": "2026-02-03",
      "shipment_ids": [
        "shp_4K9T2B",
        "shp_4K9T2C"
      ],
      "pdf_url": "https://files.partner.example/manifests/man_3N7Q1Z.pdf",
      "created_at": "2026-02-03T16:05:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.18 GET /v2/manifests/{id}

Returns one manifest.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Manifest id. |

Response `200`: the manifest:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Manifest id. |
| `date` | string | Collection date it covers. |
| `shipment_ids` | array of strings | Shipments on the manifest. |
| `pdf_url` | string | Printable manifest for the driver to sign. |
| `created_at` | string | When it was closed. |

Errors: `404 not_found`.

Example:

```http
GET /v2/manifests/man_3N7Q1Z HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "man_3N7Q1Z",
  "date": "2026-02-03",
  "shipment_ids": [
    "shp_4K9T2B",
    "shp_4K9T2C"
  ],
  "pdf_url": "https://files.partner.example/manifests/man_3N7Q1Z.pdf",
  "created_at": "2026-02-03T16:05:00Z"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no manifest man_3N7Q1Z in this account"
  }
}
```

### Pickups

Collections of parcels from a merchant's address.

#### 8.19 POST /v2/pickups

Requests a collection. A request for the same day must arrive before 11:00 local time at the address.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `date` | body | string | yes | Collection date, today or within 14 days. |
| `window_start` | body | string | yes | Earliest time, `HH:MM`. |
| `window_end` | body | string | yes | Latest time, `HH:MM`. |
| `address` | body | object | yes | Collection address. |
| `parcel_count` | body | integer | yes | 1 to 500. |

Response `201`: the new pickup:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Pickup id. |
| `date` | string | Collection date. |
| `window_start` | string | Earliest collection time, local to the address. |
| `window_end` | string | Latest collection time; at least two hours after `window_start`. |
| `address` | object | Where to collect, as in section 10. |
| `parcel_count` | integer | Parcels to collect. |
| `status` | string | `requested`, `confirmed`, `collected` or `cancelled`. |
| `created_at` | string | When it was requested. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/pickups HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "date": "2026-02-04",
  "window_start": "13:00",
  "window_end": "17:00",
  "address": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "parcel_count": 12
}
```

```json
{
  "id": "pck_2W6R9D",
  "date": "2026-02-04",
  "window_start": "13:00",
  "window_end": "17:00",
  "address": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "parcel_count": 12,
  "status": "confirmed",
  "created_at": "2026-02-03T09:12:00Z"
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "date is required",
    "details": [
      {
        "field": "date",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.20 GET /v2/pickups

Lists pickups, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `date` | query | string | no | Only pickups on this date. |
| `status` | query | string | no | Only pickups in this status. |

Response `200`: a page whose `data` holds pickups:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Pickup id. |
| `date` | string | Collection date. |
| `window_start` | string | Earliest collection time, local to the address. |
| `window_end` | string | Latest collection time; at least two hours after `window_start`. |
| `address` | object | Where to collect, as in section 10. |
| `parcel_count` | integer | Parcels to collect. |
| `status` | string | `requested`, `confirmed`, `collected` or `cancelled`. |
| `created_at` | string | When it was requested. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/pickups?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "pck_2W6R9D",
      "date": "2026-02-04",
      "window_start": "13:00",
      "window_end": "17:00",
      "address": {
        "name": "Shop Fulfilment",
        "line1": "Hafenstrasse 4",
        "postal_code": "20457",
        "city": "Hamburg",
        "country": "DE",
        "phone": "+494012345678"
      },
      "parcel_count": 12,
      "status": "confirmed",
      "created_at": "2026-02-03T09:12:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.21 GET /v2/pickups/{id}

Returns one pickup.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Pickup id. |

Response `200`: the pickup:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Pickup id. |
| `date` | string | Collection date. |
| `window_start` | string | Earliest collection time, local to the address. |
| `window_end` | string | Latest collection time; at least two hours after `window_start`. |
| `address` | object | Where to collect, as in section 10. |
| `parcel_count` | integer | Parcels to collect. |
| `status` | string | `requested`, `confirmed`, `collected` or `cancelled`. |
| `created_at` | string | When it was requested. |

Errors: `404 not_found`.

Example:

```http
GET /v2/pickups/pck_2W6R9D HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "pck_2W6R9D",
  "date": "2026-02-04",
  "window_start": "13:00",
  "window_end": "17:00",
  "address": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "parcel_count": 12,
  "status": "confirmed",
  "created_at": "2026-02-03T09:12:00Z"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no pickup pck_2W6R9D in this account"
  }
}
```

#### 8.22 DELETE /v2/pickups/{id}

Cancels a pickup that has not been collected; a collected pickup fails with `409 conflict`.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Pickup id. |

Response `204` with no body.

Errors: `404 not_found`.

Example:

```http
DELETE /v2/pickups/pck_2W6R9D HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no pickup pck_2W6R9D in this account"
  }
}
```

### Rates

Prices and transit times before a shipment exists.

#### 8.23 GET /v2/rates

Quotes the price and transit time of each service for one parcel. A quote is not a booking; prices can change until a label exists.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `from_country` | query | string | yes | Sender country. |
| `to_country` | query | string | yes | Recipient country. |
| `weight` | query | integer | yes | Grams. |
| `length` | query | integer | yes | Millimetres. |
| `width` | query | integer | yes | Millimetres. |
| `height` | query | integer | yes | Millimetres. |
| `service` | query | string | no | Quote only this service. |

Response `200`: an object whose `data` holds one quote per service:

| Field | Type | Description |
| --- | --- | --- |
| `service` | string | Service code, see section 11. |
| `price` | integer | Price in minor units, VAT excluded. |
| `currency` | string | ISO 4217 code. |
| `transit_days` | string | Range of working days. |
| `order_by` | string | Local time by which the label must exist for the day's pickup. |

Errors: `422 validation_failed` for a parcel over the limits of section 10.

Example:

```http
GET /v2/rates?from_country=DE&to_country=SE&weight=1250&length=400&width=300&height=200 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "service": "standard",
      "price": 1290,
      "currency": "EUR",
      "transit_days": "3-5",
      "order_by": "17:00"
    },
    {
      "service": "express",
      "price": 2890,
      "currency": "EUR",
      "transit_days": "2",
      "order_by": "15:00"
    }
  ]
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "weight must be at most 31500",
    "details": [
      {
        "field": "weight",
        "rule": "maximum"
      }
    ]
  }
}
```

### Returns

Return labels for delivered shipments.

#### 8.24 POST /v2/returns

Creates a return label for a delivered shipment. An account without the returns service gets `403 forbidden`.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `shipment_id` | body | string | yes | A delivered shipment of this account. |
| `reason` | body | string | yes | One of the reasons above. |

Response `201`: the new return:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Return id. |
| `shipment_id` | string | Shipment being returned. |
| `reason` | string | `damaged`, `wrong_item`, `not_wanted` or `other`. |
| `status` | string | `created`, `in_transit`, `received` or `cancelled`. |
| `label_url` | string | Return label for the recipient to print. |
| `created_at` | string | When it was created. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/returns HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "shipment_id": "shp_4K9T2B",
  "reason": "not_wanted"
}
```

```json
{
  "id": "ret_5T1K8V",
  "shipment_id": "shp_4K9T2B",
  "reason": "not_wanted",
  "status": "created",
  "label_url": "https://files.partner.example/returns/ret_5T1K8V.pdf",
  "created_at": "2026-02-06T10:40:00Z"
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "shipment_id is required",
    "details": [
      {
        "field": "shipment_id",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.25 GET /v2/returns

Lists returns, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `status` | query | string | no | Only returns in this status. |

Response `200`: a page whose `data` holds returns:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Return id. |
| `shipment_id` | string | Shipment being returned. |
| `reason` | string | `damaged`, `wrong_item`, `not_wanted` or `other`. |
| `status` | string | `created`, `in_transit`, `received` or `cancelled`. |
| `label_url` | string | Return label for the recipient to print. |
| `created_at` | string | When it was created. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/returns?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "ret_5T1K8V",
      "shipment_id": "shp_4K9T2B",
      "reason": "not_wanted",
      "status": "created",
      "label_url": "https://files.partner.example/returns/ret_5T1K8V.pdf",
      "created_at": "2026-02-06T10:40:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.26 GET /v2/returns/{id}

Returns one return.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Return id. |

Response `200`: the return:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Return id. |
| `shipment_id` | string | Shipment being returned. |
| `reason` | string | `damaged`, `wrong_item`, `not_wanted` or `other`. |
| `status` | string | `created`, `in_transit`, `received` or `cancelled`. |
| `label_url` | string | Return label for the recipient to print. |
| `created_at` | string | When it was created. |

Errors: `404 not_found`.

Example:

```http
GET /v2/returns/ret_5T1K8V HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "ret_5T1K8V",
  "shipment_id": "shp_4K9T2B",
  "reason": "not_wanted",
  "status": "created",
  "label_url": "https://files.partner.example/returns/ret_5T1K8V.pdf",
  "created_at": "2026-02-06T10:40:00Z"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no return ret_5T1K8V in this account"
  }
}
```

### Service points

Shops and lockers where recipients collect parcels and senders drop them off.

#### 8.27 GET /v2/service-points

Lists service points, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size. Default 10, maximum 50. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `country` | query | string | no | Required. Country to search in. |
| `postal_code` | query | string | no | Nearest first to this postal code. |
| `radius_km` | query | integer | no | Search radius, 1 to 25; default 5. |

Response `200`: a page whose `data` holds service points:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Service point id. |
| `name` | string | Name shown to recipients. |
| `address` | object | Street address, as in section 10. |
| `opening_hours` | array of strings | One entry per weekday, Monday first. |
| `services` | array of strings | `drop_off`, `collection` or both. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/service-points?limit=10 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "spt_3C7L1Q",
      "name": "Kiosk Odenplan",
      "address": {
        "line1": "Odengatan 60",
        "postal_code": "11322",
        "city": "Stockholm",
        "country": "SE"
      },
      "opening_hours": [
        "08:00-20:00",
        "08:00-20:00",
        "08:00-20:00",
        "08:00-20:00",
        "08:00-20:00",
        "10:00-16:00",
        "closed"
      ],
      "services": [
        "drop_off",
        "collection"
      ]
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 50"
  }
}
```

#### 8.28 GET /v2/service-points/{id}

Returns one service point.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Service point id. |

Response `200`: the service point:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Service point id. |
| `name` | string | Name shown to recipients. |
| `address` | object | Street address, as in section 10. |
| `opening_hours` | array of strings | One entry per weekday, Monday first. |
| `services` | array of strings | `drop_off`, `collection` or both. |

Errors: `404 not_found`.

Example:

```http
GET /v2/service-points/spt_3C7L1Q HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "spt_3C7L1Q",
  "name": "Kiosk Odenplan",
  "address": {
    "line1": "Odengatan 60",
    "postal_code": "11322",
    "city": "Stockholm",
    "country": "SE"
  },
  "opening_hours": [
    "08:00-20:00",
    "08:00-20:00",
    "08:00-20:00",
    "08:00-20:00",
    "08:00-20:00",
    "10:00-16:00",
    "closed"
  ],
  "services": [
    "drop_off",
    "collection"
  ]
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no service point spt_3C7L1Q in this account"
  }
}
```

### Shipments

A consignment of one to twenty parcels from a sender to a recipient.

#### 8.29 POST /v2/shipments

Creates a shipment in status `created`. It is billed once it has a label.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `reference` | body | string | no | Your reference, at most 64 characters. |
| `service` | body | string | yes | Service code, see section 11. |
| `sender` | body | object | yes | Sender address. |
| `recipient` | body | object | yes | Recipient address. |
| `parcels` | body | array of objects | yes | 1 to 20 parcels. |

Response `201`: the new shipment:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Shipment id. |
| `reference` | string | The merchant's own reference, such as an order number. |
| `status` | string | `created`, `labelled`, `in_transit`, `delivered`, `returned` or `cancelled`. |
| `service` | string | Service code, see section 11. |
| `sender` | object | Sender address, as in section 10. |
| `recipient` | object | Recipient address, as in section 10. |
| `parcels` | array of objects | Weight and dimensions of each parcel. |
| `tracking_number` | string or null | Set once a label exists. |
| `label_id` | string or null | The shipment's label, once created. |
| `legacy_id` | integer or null | Id of a shipment created through version 1. |
| `created_at` | string | When it was created. |
| `updated_at` | string | When it last changed. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/shipments HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "reference": "order-10482",
  "service": "standard",
  "sender": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "recipient": {
    "name": "Lina Berg",
    "line1": "Storgatan 12",
    "postal_code": "11451",
    "city": "Stockholm",
    "country": "SE",
    "phone": "+46701234567"
  },
  "parcels": [
    {
      "weight": 1250,
      "length": 400,
      "width": 300,
      "height": 200
    }
  ]
}
```

```json
{
  "id": "shp_4K9T2B",
  "reference": "order-10482",
  "status": "in_transit",
  "service": "standard",
  "sender": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "recipient": {
    "name": "Lina Berg",
    "line1": "Storgatan 12",
    "postal_code": "11451",
    "city": "Stockholm",
    "country": "SE",
    "phone": "+46701234567"
  },
  "parcels": [
    {
      "weight": 1250,
      "length": 400,
      "width": 300,
      "height": 200
    }
  ],
  "tracking_number": "PX00438812SE",
  "label_id": "lbl_8H3N5P",
  "legacy_id": null,
  "created_at": "2026-02-03T07:41:00Z",
  "updated_at": "2026-02-03T08:15:00Z"
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "service is required",
    "details": [
      {
        "field": "service",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.30 GET /v2/shipments

Lists shipments, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size. Default 20, maximum 100. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `status` | query | string | no | Only shipments in this status. |
| `reference` | query | string | no | Only shipments with this reference. |
| `created_after` | query | string | no | Only shipments created after this timestamp. |
| `created_before` | query | string | no | Only shipments created before this timestamp. |

Response `200`: a page whose `data` holds shipments:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Shipment id. |
| `reference` | string | The merchant's own reference, such as an order number. |
| `status` | string | `created`, `labelled`, `in_transit`, `delivered`, `returned` or `cancelled`. |
| `service` | string | Service code, see section 11. |
| `sender` | object | Sender address, as in section 10. |
| `recipient` | object | Recipient address, as in section 10. |
| `parcels` | array of objects | Weight and dimensions of each parcel. |
| `tracking_number` | string or null | Set once a label exists. |
| `label_id` | string or null | The shipment's label, once created. |
| `legacy_id` | integer or null | Id of a shipment created through version 1. |
| `created_at` | string | When it was created. |
| `updated_at` | string | When it last changed. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/shipments?limit=20 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "shp_4K9T2B",
      "reference": "order-10482",
      "status": "in_transit",
      "service": "standard",
      "sender": {
        "name": "Shop Fulfilment",
        "line1": "Hafenstrasse 4",
        "postal_code": "20457",
        "city": "Hamburg",
        "country": "DE",
        "phone": "+494012345678"
      },
      "recipient": {
        "name": "Lina Berg",
        "line1": "Storgatan 12",
        "postal_code": "11451",
        "city": "Stockholm",
        "country": "SE",
        "phone": "+46701234567"
      },
      "parcels": [
        {
          "weight": 1250,
          "length": 400,
          "width": 300,
          "height": 200
        }
      ],
      "tracking_number": "PX00438812SE",
      "label_id": "lbl_8H3N5P",
      "legacy_id": null,
      "created_at": "2026-02-03T07:41:00Z",
      "updated_at": "2026-02-03T08:15:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 100"
  }
}
```

#### 8.31 GET /v2/shipments/{id}

Returns one shipment.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Shipment id. |

Response `200`: the shipment:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Shipment id. |
| `reference` | string | The merchant's own reference, such as an order number. |
| `status` | string | `created`, `labelled`, `in_transit`, `delivered`, `returned` or `cancelled`. |
| `service` | string | Service code, see section 11. |
| `sender` | object | Sender address, as in section 10. |
| `recipient` | object | Recipient address, as in section 10. |
| `parcels` | array of objects | Weight and dimensions of each parcel. |
| `tracking_number` | string or null | Set once a label exists. |
| `label_id` | string or null | The shipment's label, once created. |
| `legacy_id` | integer or null | Id of a shipment created through version 1. |
| `created_at` | string | When it was created. |
| `updated_at` | string | When it last changed. |

Errors: `404 not_found`.

Example:

```http
GET /v2/shipments/shp_4K9T2B HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "id": "shp_4K9T2B",
  "reference": "order-10482",
  "status": "in_transit",
  "service": "standard",
  "sender": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "recipient": {
    "name": "Lina Berg",
    "line1": "Storgatan 12",
    "postal_code": "11451",
    "city": "Stockholm",
    "country": "SE",
    "phone": "+46701234567"
  },
  "parcels": [
    {
      "weight": 1250,
      "length": 400,
      "width": 300,
      "height": 200
    }
  ],
  "tracking_number": "PX00438812SE",
  "label_id": "lbl_8H3N5P",
  "legacy_id": null,
  "created_at": "2026-02-03T07:41:00Z",
  "updated_at": "2026-02-03T08:15:00Z"
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no shipment shp_4K9T2B in this account"
  }
}
```

#### 8.32 PATCH /v2/shipments/{id}

Changes the reference or the recipient of a shipment that has no label yet; once it has one, the request fails with `409 conflict`.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Shipment id. |
| `reference` | body | string | no | New reference. |
| `recipient` | body | object | no | New recipient address. |

Response `200`: the changed shipment:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Shipment id. |
| `reference` | string | The merchant's own reference, such as an order number. |
| `status` | string | `created`, `labelled`, `in_transit`, `delivered`, `returned` or `cancelled`. |
| `service` | string | Service code, see section 11. |
| `sender` | object | Sender address, as in section 10. |
| `recipient` | object | Recipient address, as in section 10. |
| `parcels` | array of objects | Weight and dimensions of each parcel. |
| `tracking_number` | string or null | Set once a label exists. |
| `label_id` | string or null | The shipment's label, once created. |
| `legacy_id` | integer or null | Id of a shipment created through version 1. |
| `created_at` | string | When it was created. |
| `updated_at` | string | When it last changed. |

Errors: `404 not_found`, `409 conflict`, `422 validation_failed`.

Example:

```http
PATCH /v2/shipments/shp_4K9T2B HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "reference": "order-10482-b",
  "recipient": {
    "name": "Lina Berg",
    "line1": "Storgatan 12",
    "postal_code": "11451",
    "city": "Stockholm",
    "country": "SE",
    "phone": "+46701234567"
  }
}
```

```json
{
  "id": "shp_4K9T2B",
  "reference": "order-10482-b",
  "status": "in_transit",
  "service": "standard",
  "sender": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "recipient": {
    "name": "Lina Berg",
    "line1": "Storgatan 12",
    "postal_code": "11451",
    "city": "Stockholm",
    "country": "SE",
    "phone": "+46701234567"
  },
  "parcels": [
    {
      "weight": 1250,
      "length": 400,
      "width": 300,
      "height": 200
    }
  ],
  "tracking_number": "PX00438812SE",
  "label_id": "lbl_8H3N5P",
  "legacy_id": null,
  "created_at": "2026-02-03T07:41:00Z",
  "updated_at": "2026-02-03T08:15:00Z"
}
```

Example error, `409`:

```json
{
  "error": {
    "code": "conflict",
    "message": "the shipment can no longer be changed"
  }
}
```

#### 8.33 POST /v2/shipments/{id}/cancel

Cancels a shipment that has not been collected, and refunds its label. A collected shipment fails with `409 conflict`.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Shipment id. |

Response `200`: the cancelled shipment:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Shipment id. |
| `reference` | string | The merchant's own reference, such as an order number. |
| `status` | string | `created`, `labelled`, `in_transit`, `delivered`, `returned` or `cancelled`. |
| `service` | string | Service code, see section 11. |
| `sender` | object | Sender address, as in section 10. |
| `recipient` | object | Recipient address, as in section 10. |
| `parcels` | array of objects | Weight and dimensions of each parcel. |
| `tracking_number` | string or null | Set once a label exists. |
| `label_id` | string or null | The shipment's label, once created. |
| `legacy_id` | integer or null | Id of a shipment created through version 1. |
| `created_at` | string | When it was created. |
| `updated_at` | string | When it last changed. |

Errors: `404 not_found`, `409 conflict`.

Example:

```http
POST /v2/shipments/shp_4K9T2B/cancel HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{}
```

```json
{
  "id": "shp_4K9T2B",
  "reference": "order-10482",
  "status": "cancelled",
  "service": "standard",
  "sender": {
    "name": "Shop Fulfilment",
    "line1": "Hafenstrasse 4",
    "postal_code": "20457",
    "city": "Hamburg",
    "country": "DE",
    "phone": "+494012345678"
  },
  "recipient": {
    "name": "Lina Berg",
    "line1": "Storgatan 12",
    "postal_code": "11451",
    "city": "Stockholm",
    "country": "SE",
    "phone": "+46701234567"
  },
  "parcels": [
    {
      "weight": 1250,
      "length": 400,
      "width": 300,
      "height": 200
    }
  ],
  "tracking_number": "PX00438812SE",
  "label_id": "lbl_8H3N5P",
  "legacy_id": null,
  "created_at": "2026-02-03T07:41:00Z",
  "updated_at": "2026-02-03T08:15:00Z"
}
```

Example error, `409`:

```json
{
  "error": {
    "code": "conflict",
    "message": "the shipment was already collected"
  }
}
```

### Surcharges

Charges added to a shipment after it was labelled, billed on the next invoice.

#### 8.34 GET /v2/surcharges

Lists surcharges, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |
| `shipment_id` | query | string | no | Only surcharges of this shipment. |
| `invoice_id` | query | string | no | Only surcharges billed on this invoice. |
| `type` | query | string | no | Only surcharges of this type. |

Response `200`: a page whose `data` holds surcharges:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Surcharge id. |
| `shipment_id` | string | Shipment it applies to. |
| `type` | string | `fuel`, `oversize`, `remote_area` or `address_correction`. |
| `amount` | integer | Amount in minor units, VAT excluded. |
| `currency` | string | ISO 4217 code. |
| `invoice_id` | string or null | Invoice that bills it, once issued. |
| `created_at` | string | When it was added. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/surcharges?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "sur_8C5T2L",
      "shipment_id": "shp_4K9T2B",
      "type": "address_correction",
      "amount": 450,
      "currency": "EUR",
      "invoice_id": null,
      "created_at": "2026-02-04T06:10:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

### Tracking

Public tracking by the number printed on a label.

#### 8.35 GET /v2/tracking/{tracking_number}

Tracks one parcel by its tracking number. It needs no key, so a storefront can call it for the recipient; it returns no addresses.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `tracking_number` | path | string | yes | Number printed on the label. |

Response `200`: the parcel's tracking:

| Field | Type | Description |
| --- | --- | --- |
| `tracking_number` | string | The number asked for. |
| `status` | string | Status of the shipment, as in the shipments entries. |
| `estimated_delivery` | string or null | Expected date of the first delivery attempt. |
| `events` | array of objects | The parcel's events, newest first, with `type`, `occurred_at`, `location` and `description`. |

Errors: `404 not_found` for an unknown number.

Example:

```http
GET /v2/tracking/PX00438812SE HTTP/1.1
Host: api.partner.example
```

```json
{
  "tracking_number": "PX00438812SE",
  "status": "in_transit",
  "estimated_delivery": "2026-02-06",
  "events": [
    {
      "type": "shipment.in_transit",
      "occurred_at": "2026-02-03T08:15:00Z",
      "location": "Hamburg depot",
      "description": "The parcel left the depot."
    }
  ]
}
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no parcel with tracking number PX00438812SX"
  }
}
```

### Webhooks

Subscriptions that send events to a merchant's endpoint (section 9).

#### 8.36 POST /v2/webhooks

Subscribes an endpoint to event types. Only this response carries `secret`, the key for checking signatures; store it.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `url` | body | string | yes | HTTPS URL. |
| `events` | body | array of strings | yes | At least one event type. |

Response `201`: the new webhook subscription:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Subscription id. |
| `url` | string | HTTPS endpoint the partner posts to. |
| `events` | array of strings | Event types to send, from section 9. |
| `active` | boolean | `false` once every delivery failed for 3 days; see section 9. |
| `created_at` | string | When it was created. |
| `secret` | string | Signing key, returned only here. |

Errors: `422 validation_failed`, `409 idempotency_conflict`.

Example:

```http
POST /v2/webhooks HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
Content-Type: application/json
Idempotency-Key: 7c1e9a52-4b0d-4e8f-9a61-2d5f0c3b8e47

{
  "url": "https://shop.example/hooks/partner",
  "events": [
    "shipment.delivered",
    "shipment.exception"
  ]
}
```

```json
{
  "id": "whk_9J4D2S",
  "url": "https://shop.example/hooks/partner",
  "events": [
    "shipment.delivered",
    "shipment.exception"
  ],
  "active": true,
  "created_at": "2026-01-12T14:03:00Z",
  "secret": "whsec_2f8e6a0c4b1d"
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "url is required",
    "details": [
      {
        "field": "url",
        "rule": "required"
      }
    ]
  }
}
```

#### 8.37 GET /v2/webhooks

Lists webhook subscriptions, newest first, one page at a time (section 7).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size; see section 7. |
| `cursor` | query | string | no | `next_cursor` of the previous page. |
| `order` | query | string | no | `desc` (default) or `asc`. |

Response `200`: a page whose `data` holds webhook subscriptions:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Subscription id. |
| `url` | string | HTTPS endpoint the partner posts to. |
| `events` | array of strings | Event types to send, from section 9. |
| `active` | boolean | `false` once every delivery failed for 3 days; see section 9. |
| `created_at` | string | When it was created. |

Errors: `422 limit_exceeded` for a `limit` above the maximum, `400 invalid_request` for an expired cursor.

Example:

```http
GET /v2/webhooks?limit=50 HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

```json
{
  "data": [
    {
      "id": "whk_9J4D2S",
      "url": "https://shop.example/hooks/partner",
      "events": [
        "shipment.delivered",
        "shipment.exception"
      ],
      "active": true,
      "created_at": "2026-01-12T14:03:00Z"
    }
  ],
  "next_cursor": "c_9f2a71",
  "has_more": true
}
```

Example error, `422`:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "limit must be at most 200"
  }
}
```

#### 8.38 DELETE /v2/webhooks/{id}

Removes a subscription. Deliveries already under way are still attempted.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | Webhook subscription id. |

Response `204` with no body.

Errors: `404 not_found`.

Example:

```http
DELETE /v2/webhooks/whk_9J4D2S HTTP/1.1
Host: api.partner.example
Authorization: Bearer <api-key>
```

Example error, `404`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no webhook subscription whk_9J4D2S in this account"
  }
}
```

## 9. Webhooks

A webhook subscription (see Webhooks in section 8) tells the partner where to send events.

| Event type | Sent when |
| --- | --- |
| `shipment.labelled` | A label was created for the shipment. |
| `shipment.in_transit` | A depot scanned the parcel. |
| `shipment.out_for_delivery` | The parcel is on the last vehicle. |
| `shipment.delivered` | The recipient or a neighbour signed for it. |
| `shipment.exception` | Delivery failed; `description` says why. |
| `shipment.returned` | The parcel is on its way back to the sender. |
| `pickup.confirmed` | A pickup request was accepted. |
| `pickup.collected` | The driver collected the parcels. |
| `invoice.issued` | A new invoice is available. |

### Delivery

The partner sends each event as a `POST` whose body is the event object. The endpoint must answer with a `2xx` status within 10 seconds; anything else is a failed delivery. Events can arrive out of order and more than once, so deduplicate by `id` and order by `occurred_at`.

### Retries

A failed delivery is retried 6 times: 1, 5, 15, 60, 240 and 720 minutes after the first attempt. After the last retry the event is dropped. A subscription whose deliveries all fail for 3 days in a row is set to `active: false`, and the merchant's technical contact is told.

### Signatures

Each delivery carries a `Partner-Signature` header:

```http
Partner-Signature: t=1770106500,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

`v1` is the hex HMAC-SHA256 of the timestamp, a period and the raw body, keyed with the subscription's secret. Reject a delivery whose signature does not match or whose `t` is more than 5 minutes old.

## 10. Data formats

| Value | Format | Example |
| --- | --- | --- |
| Country | ISO 3166-1 alpha-2, upper case | `SE` |
| Weight | Integer grams | `1250` |
| Dimension | Integer millimetres | `400` |
| Money | Integer minor units with an ISO 4217 `currency` | `1490` with `EUR` |
| Timestamp | RFC 3339 in UTC | `2026-02-03T08:15:00Z` |
| Date | `YYYY-MM-DD` | `2026-02-04` |
| Phone | E.164 | `+46701234567` |

### Addresses

| Field | Required | Rule |
| --- | --- | --- |
| `name` | yes | At most 35 characters. |
| `company` | no | At most 35 characters. |
| `line1` | yes | At most 35 characters. |
| `line2` | no | At most 35 characters. |
| `postal_code` | yes | A postal code of `country`, in that country's format. |
| `city` | yes | At most 35 characters. |
| `region` | no | A subdivision code; required for `US`, `CA` and `AU`. |
| `country` | yes | As in the table above. |
| `phone` | no | E.164; required for `express` and `same_day`. |
| `email` | no | Used for delivery notifications when present. |

### Parcels

A shipment carries 1 to 20 parcels, each with `weight`, `length`, `width` and `height`. A parcel may weigh at most 31500 grams, and its length plus twice its width plus twice its height may be at most 3000 millimetres.

## 11. Service levels

| Service | Domestic | EU | Nordic | World | Order by |
| --- | --- | --- | --- | --- | --- |
| `economy` | 3-5 | 5-8 | 5-8 | 10-20 | 16:00 |
| `standard` | 1-2 | 2-4 | 3-5 | 5-10 | 17:00 |
| `express` | 1 | 1-2 | 2 | 2-4 | 15:00 |
| `same_day` | 0 | - | - | - | 11:00 |

The zone columns give transit in working days, from pickup to the first delivery attempt. "Order by" is the local time at the sender's address by which a label must exist for that day's pickup. `same_day` is available within the sender's city only.

The partner refunds the price of an `express` or `same_day` shipment it delivers late, on request within 30 days. Liability per parcel is limited to 500.00 EUR for `economy` and `standard`, and to 2500.00 EUR for `express` and `same_day`.

## 12. Change log

| Version | Date | Change |
| --- | --- | --- |
| 2.6 | 2026-02-01 | Smaller pages for `GET /v2/shipments`; see its entry in section 8. The rate limit went from 100 to 120 requests per minute. |
| 2.5 | 2025-10-15 | Added the service point endpoints. |
| 2.4 | 2025-07-01 | Webhook signatures use HMAC-SHA256 (`v1=`); the `sha1=` value is no longer sent. |
| 2.3 | 2025-06-30 | Version 1 retired; see Appendix A. |
| 2.2 | 2025-03-10 | Added returns. |
| 2.1 | 2024-11-04 | `Idempotency-Key` is required on every `POST`. |
| 2.0 | 2024-06-01 | First release of version 2. |

## Appendix A. Retired v1 API

Version 1 stopped answering on 2025-06-30; every `/v1/` request now fails with `410 gone`. This appendix describes it only so that records created through it can be mapped to version 2.

| v1 endpoint | v2 replacement | Notes |
| --- | --- | --- |
| `GET /v1/shipments` | `GET /v2/shipments` | v1 paged with `page` and `per_page`; `per_page` defaulted to 25 and allowed at most 250. |
| `POST /v1/shipments` | `POST /v2/shipments` | v1 took weights in kilograms with decimals. |
| `GET /v1/shipments/{id}` | `GET /v2/shipments/{id}` | v1 ids are numbers; version 2 returns them as `legacy_id`. |
| `POST /v1/labels` | `POST /v2/labels` | v1 created one label per request. |
| `GET /v1/tracking/{number}` | `GET /v2/tracking/{tracking_number}` | Same numbers. |
| `GET /v1/pickups` | `GET /v2/pickups` | v1 listed only future pickups. |

### Status mapping

| v1 status | v2 status |
| --- | --- |
| `NEW` | `created` |
| `PRINTED` | `labelled` |
| `ON_ROUTE` | `in_transit` |
| `DONE` | `delivered` |
| `BACK` | `returned` |
| `VOID` | `cancelled` |
