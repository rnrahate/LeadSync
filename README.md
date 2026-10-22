# IndiaMART BuyLead Assistant

> Automated BuyLead acquisition for IndiaMART sellers with intelligent product-name matching, strict country filtering, lead scoring, acquisition automation, and Supabase CRM synchronization.

**Version:** 6.2.0  
**Developed by:** [Keyn Labs](https://leadsync-tau-sand.vercel.app/)

---

## Overview

**IndiaMART BuyLead Assistant** is a browser extension designed to automate the discovery, filtering, qualification, and acquisition of BuyLeads from IndiaMART seller pages.

The extension continuously monitors IndiaMART BuyLead pages, identifies new leads, validates them against configurable product and keyword rules, applies country and scoring filters, and automatically acquires qualified leads according to the selected operating mode.

The system is designed with a strong focus on:

- Accurate product-name matching
- False-positive prevention
- Country-based filtering
- Lead scoring
- Duplicate detection
- Acquisition automation
- Rate limiting and safety controls
- Supabase CRM synchronization
- Detailed debugging and decision logging

---

## Table of Contents

1. [Features](#features)
2. [How the Lead Matching System Works](#how-the-lead-matching-system-works)
3. [Lead Data Extraction](#lead-data-extraction)
4. [Matching Pipeline](#matching-pipeline)
5. [Product Name Matching](#product-name-matching)
6. [Keyword Matching](#keyword-matching)
7. [Word-Boundary Matching](#word-boundary-matching)
8. [Country Filtering](#country-filtering)
9. [Lead Scoring](#lead-scoring)
10. [Operating Modes](#operating-modes)
11. [Automation Flow](#automation-flow)
12. [Speed Configuration](#speed-configuration)
13. [Safety and Rate Limits](#safety-and-rate-limits)
14. [Supabase Integration](#supabase-integration)
15. [Project Structure](#project-structure)
16. [Installation](#installation)
17. [First-Time Configuration](#first-time-configuration)
18. [Upgrade and Migration](#upgrade-and-migration)
19. [Development Workflow](#development-workflow)
20. [Debugging](#debugging)
21. [Troubleshooting](#troubleshooting)
22. [Testing](#testing)
23. [Important Development Rules](#important-development-rules)
24. [Credits](#credits)

---

# Features

### Lead Discovery

- Automatically monitors IndiaMART BuyLead pages.
- Detects newly loaded lead cards.
- Supports dynamically loaded leads.
- Automatically scrolls through the page.
- Handles "Show More BuyLeads" actions.
- Continues processing until the available leads are exhausted.

### Intelligent Filtering

- Product-name based filtering.
- Required keyword filtering.
- Negative keyword filtering.
- Strict country filtering.
- Location filtering.
- Configurable lead scoring.
- Duplicate detection.

### Lead Acquisition

- Automatically identifies qualified leads.
- Supports multiple acquisition modes.
- Handles confirmation and purchase dialogs.
- Prevents duplicate acquisitions.
- Supports configurable cooldowns and rate limits.

### CRM Integration

- Stores leads in Supabase.
- Stores acquisition history.
- Tracks lead status.
- Maintains filter statistics.
- Supports persistent lead records across page reloads.

### Debugging

- Detailed decision logs.
- Product matching logs.
- Rejection reasons.
- Country filtering logs.
- Rate-limit logs.
- Queue activity logs.
- Exportable debug data.

---

# How the Lead Matching System Works

The matching system is one of the most important parts of the extension.

Older implementations could treat the entire IndiaMART lead card as searchable text. This could produce false positives because a lead card may contain unrelated information such as:

- Buyer requirements
- Category information
- Buyer details
- "Buyer also viewed" products
- Recommended products
- Other page content

The current architecture separates the lead into individual fields and evaluates each field according to its purpose.

### Core principle

> **Product matching must be performed against the actual product name/title, not against the complete lead-card text.**

This prevents unrelated text from incorrectly qualifying a lead.

---

# Lead Data Extraction

Each IndiaMART lead is converted into a structured object.

Example:

```javascript
{
    id: "unique-lead-id",

    productName: "Emergency Whitening Serum",

    messageText: "Looking for serum suppliers in bulk quantity.",

    mcatName: "Skin Care Cosmetics > Skin Serum",

    city: "Mumbai",

    state: "Maharashtra",

    country: "India",

    countryIso: "IN",

    mobile: "...",

    email: "..."
}
```

The most important fields are:

| Field | Purpose |
|---|---|
| `productName` | Primary product matching |
| `messageText` | Required keyword matching and scoring |
| `mcatName` | Informational category data |
| `countryIso` | Country filtering |
| `city` | Location filtering |
| `state` | Location filtering |
| `uniqueQueryId` | Lead deduplication |

---

# Matching Pipeline

Every discovered lead passes through a defined validation pipeline.

```text
IndiaMART Lead
      │
      ▼
Parse Lead Data
      │
      ▼
Country Filter
      │
      ▼
Negative Keyword Gate
      │
      ▼
Required Keyword Gate
      │
      ▼
Product Name Gate
      │
      ▼
Location Validation
      │
      ▼
Lead Scoring
      │
      ▼
Duplicate Check
      │
      ▼
Safety / Rate Limits
      │
      ▼
Acquisition Queue
      │
      ▼
Final Validation
      │
      ▼
Acquire Lead
      │
      ▼
Supabase Sync
```

Each stage can reject a lead.

The rejection reason is recorded in the debug system.

---

# Product Name Matching

## Primary Product Gate

The product gate is the primary protection against unrelated leads.

If a filter contains:

```text
Emergency Whitening Serum
```

the extension should compare that value with:

```text
lead.productName
```

and **not with the complete lead-card text**.

### Example

Configured product:

```text
Emergency Whitening Serum
```

Lead:

```text
Product:
Emergency Whitening Serum

Buyer requirement:
Need sunscreen and skin-care products.

Buyer also viewed:
Sunscreen SPF 50
```

Result:

```text
MATCH
```

The unrelated sunscreen information does not affect the product match.

---

## Incorrect Matching

Avoid this pattern:

```javascript
const searchableText = leadCard.innerText;

if (searchableText.includes(keyword)) {
    // Match
}
```

This can produce false positives because the complete card may contain unrelated words.

---

## Correct Matching

Use the structured product field:

```javascript
const productName = lead.productName;

if (matchesProductName(productName, configuredProducts)) {
    // Product matched
}
```

---

# Keyword Matching

The extension uses different keyword groups for different purposes.

## Product Keywords

Product keywords are evaluated against:

```text
productName
```

They are the primary product qualification mechanism.

---

## Required Keywords

Required keywords may be evaluated against:

```text
productName
messageText
```

At least one configured required keyword must match.

Example:

```text
Required keywords:
- serum
- sunscreen
```

A lead containing either valid term can pass the required-keyword gate.

---

## Negative Keywords

Negative keywords are used to reject unwanted leads.

They should be applied to the appropriate product field to prevent unrelated message text from generating false rejections.

Example:

```text
Negative keyword:
repair
```

A message such as:

```text
No repair required.
```

should not automatically reject a product that has nothing to do with repair.

---

# Word-Boundary Matching

The matcher should avoid raw substring matching wherever possible.

Simple substring matching can cause false positives such as:

```text
spf     → sputum
used    → unused
in      → Berlin
serum   → serumfree
```

The token-based matcher instead evaluates individual words.

### Matching rules

For a single-word keyword:

- Exact token match
- Supported plural forms
- Prefix matching for sufficiently long keywords

For multi-word keywords:

- Each keyword component must be present as a token.
- Word order does not necessarily need to be identical.

This provides significantly safer matching than unrestricted `indexOf()` searches.

---

# Country Filtering

The extension supports strict country filtering.

When strict country filtering is enabled, a lead must satisfy the configured country rules before continuing through the qualification pipeline.

### Country detection priority

1. Country flag image `alt` attribute.
2. Location segments split by commas.
3. Exact matching against the supported country list.

The country matcher must never classify a country using a simple substring search.

For example:

```text
Berlin
```

must not be interpreted as:

```text
India
```

simply because the text contains:

```text
in
```

---

## Strict Country Options

### Allowed Countries

Example:

```text
IN, US, AE
```

### Reject Unknown Country

When enabled:

```text
Unknown country → Reject
```

When disabled:

```text
Unknown country → Allow + Log
```

This behavior is visible in the debug logs.

---

# Lead Scoring

Qualified leads can be assigned a score from `0` to `100`.

Scoring can take into account configurable signals such as:

- Product relevance
- Required keyword matches
- Message relevance
- Location relevance
- Contact availability
- Other configured scoring factors

A minimum score can be configured.

Example:

```text
Minimum score: 60
```

A lead below the configured threshold will not enter the acquisition queue.

---

# Operating Modes

The extension supports four primary operating modes.

| Mode | Description |
|---|---|
| **MONITOR** | Detects and displays leads without acquiring them. |
| **DRY_RUN** | Runs the complete filtering and scoring pipeline without performing real acquisition actions. |
| **ASSISTED** | Shows an approval interface for qualified leads and waits for user confirmation. |
| **AUTOMATIC** | Automatically acquires qualified leads that pass all validation and safety checks. |

---

## MONITOR

Use this mode when inspecting IndiaMART behavior or testing lead detection.

No acquisition action is performed.

---

## DRY_RUN

Runs:

```text
Parse
→ Filter
→ Score
→ Queue
```

but does not perform the actual acquisition click.

This is recommended when testing new filters.

---

## ASSISTED

The extension identifies a qualified lead and asks for user confirmation before acquisition.

---

## AUTOMATIC

Qualified leads are automatically processed according to the configured limits and safety rules.

---

# Automation Flow

The automated workflow is:

```text
1. Open IndiaMART BuyLead page
2. Detect lead cards
3. Parse lead information
4. Validate country
5. Apply negative keywords
6. Apply required keywords
7. Validate product name
8. Apply location rules
9. Calculate score
10. Check duplicates
11. Check rate limits
12. Add lead to queue
13. Revalidate lead before acquisition
14. Click "Contact Buyer Now"
15. Handle confirmation/purchase dialog
16. Record acquisition result
17. Sync lead to Supabase
18. Continue with the next lead
19. Scroll / load additional leads
20. Repeat until stopped or exhausted
```

The final re-validation step is important because the DOM can change while a lead is waiting in the queue.

---

# Speed Configuration

The automation speed is configurable through the configuration interface.

Typical parameters include:

| Setting | Purpose |
|---|---|
| Scroll Step | Distance moved during page scanning |
| Scroll Delay | Delay between scroll operations |
| Loop Interval | Queue processing interval |
| Load More Wait | Delay after loading additional leads |
| Bottom Wait | Delay before attempting Load More |
| Popup Poll | Dialog detection frequency |
| Popup Timeout | Maximum dialog wait time |
| Scanner Debounce | Prevents excessive DOM processing |
| Scanner Fallback | Backup scan interval |
| Retry Click | Retry interval for failed actions |
| Cooldown | Delay between acquisitions |
| Rate Limits | Minute/hour/day/session acquisition limits |
| Panel Refresh | Live status refresh interval |

The values should be tuned carefully because excessively aggressive automation can increase page instability and may trigger platform-side restrictions.

---

# Safety and Rate Limits

The extension includes multiple safety controls.

## Rate Limits

Limits can be configured for:

```text
Per Minute
Per Hour
Per Day
Per Session
```

Example:

```text
60 / minute
400 / hour
2000 / day
1000 / session
```

These values are configurable and should be adjusted according to the intended operating environment.

---

## Cooldown

A cooldown prevents immediate repeated acquisition attempts.

Example:

```text
Cooldown: 400ms
```

---

## Emergency Stop

The extension provides an emergency stop mechanism.

When activated:

```text
Automation stops
Queue processing stops
Acquisition actions stop
```

The extension can subsequently be resumed.

---

# Duplicate Detection

Every lead should have a stable identifier such as:

```text
uniqueQueryId
```

The identifier is used to prevent the same lead from being processed repeatedly.

Duplicate handling should work across:

- Current page
- Scrolling
- Page reloads
- Load More operations
- Extension restarts
- Supabase synchronization

---

# Supabase Integration

Supabase is used as the CRM/data layer.

The extension synchronizes:

- Leads
- Lead history
- Filters
- Filter statistics
- Acquisition status

---

## `filters` Table

| Column | Purpose |
|---|---|
| `id` | Primary key |
| `filter_name` | Filter display name |
| `client_id` | Client/tenant identifier |
| `is_active` | Determines whether the filter is active |
| `is_running` | Indicates active processing |
| `product_keywords` | Primary product matching keywords |
| `negative_keywords` | Product rejection keywords |
| `required_keywords` | Required matching alternatives |
| `location_keywords` | Location/country matching |
| `filter_config` | Legacy compatibility field |
| `stats_scanned` | Number of scanned leads |
| `stats_matched` | Number of matched leads |
| `stats_clicked` | Number of acquisition attempts |
| `updated_at` | Last update timestamp |

---

## `leads` Table

The `leads` table stores discovered leads.

Important fields include:

```text
unique_query_id
query_product_name
query_message
sender_city
sender_state
sender_country_iso
sender_mobile
sender_email
is_matched
is_contacted
status
```

A unique lead identifier should be used to prevent duplicate records.

---

## `lead_history` Table

Stores lead state transitions.

Example states:

```text
CONTACTED
REJECTED
COUNTRY_BLOCKED
DUPLICATE
FAILED
```

This provides an audit trail of what happened to each lead.

---

# Recommended Database Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_filters_active_client
    ON filters (is_active, client_id)
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_leads_unique_query
    ON leads (unique_query_id);

CREATE INDEX IF NOT EXISTS idx_leads_contacted
    ON leads (is_contacted, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_status
    ON leads (status);

CREATE INDEX IF NOT EXISTS idx_history_lead
    ON lead_history (lead_id);
```

---

# Project Structure

```text
.
├── manifest.json
├── plugin.png
├── service-worker.js
│
├── src/
│   ├── bundle.js
│   └── supabase-service.js
│
├── config/
│   ├── index.html
│   ├── config.js
│   └── style.css
│
├── popup/
│   ├── index.html
│   ├── popup.js
│   └── style.css
│
├── debug/
│   ├── index.html
│   └── debug.js
│
├── migration/
│   ├── index.html
│   ├── app.js
│   └── style.css
│
└── README.md
```

---

# Installation

## Chrome / Edge

The extension can be installed as an unpacked extension during development.

### Steps

1. Clone or download the repository.
2. Open:

```text
chrome://extensions
```

3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Select the project directory.
6. Pin the extension.
7. Open an IndiaMART seller BuyLead page.

---

## Firefox

For temporary development installation:

1. Open:

```text
about:debugging#/runtime/this-firefox
```

2. Select **This Firefox**.
3. Click **Load Temporary Add-on**.
4. Select `manifest.json`.
5. Open an IndiaMART BuyLead page.

Temporary extensions normally remain installed until the browser session is restarted.

---

# First-Time Configuration

After installation:

### 1. Open Configuration

Open:

```text
Extension → Config
```

### 2. Configure Supabase

Verify that the Supabase integration is enabled and correctly configured.

### 3. Create a Filter

Go to:

```text
Config → Filters
```

Create a filter containing the desired:

- Product names
- Product keywords
- Required keywords
- Negative keywords
- Locations
- Countries

### 4. Configure Scoring

Set the desired minimum score.

Example:

```text
Minimum Score: 60
```

### 5. Select Operating Mode

Start with:

```text
DRY_RUN
```

for testing.

After confirming that the matching behavior is correct, switch to:

```text
ASSISTED
```

or:

```text
AUTOMATIC
```

according to the required workflow.

---

# Upgrade and Migration

When upgrading between versions, review the configuration schema and migration requirements.

Legacy filter records may contain:

```text
filter_config
```

while newer versions use dedicated fields such as:

```text
product_keywords
negative_keywords
required_keywords
location_keywords
```

The migration interface can be used to synchronize legacy filter configuration into the newer structure.

---

# Development Workflow

The project does not require a traditional build pipeline when using the current source structure.

Typical development workflow:

```text
1. Modify source files
2. Save changes
3. Reload the extension
4. Reload the IndiaMART tab
5. Open Debug
6. Inspect logs
7. Test the matching pipeline
```

For Chrome:

```text
chrome://extensions
```

Click the extension's **Reload** button.

---

# Debugging

The Debug interface provides detailed visibility into the automation pipeline.

Available filters include:

- Log level
- Module
- Rejection reason
- Country
- Search text

Supported log levels include:

```text
TRACE
DEBUG
INFO
WARN
ERROR
FATAL
```

---

## Important Debug Events

Examples:

```text
PRODUCT_MATCH
PRODUCT_MISMATCH
NEGATIVE_KEYWORD
REQUIRED_KEYWORD
COUNTRY_ALLOWED
COUNTRY_BLOCKED
DUPLICATE
COOLDOWN
MINUTE_LIMIT
HOUR_LIMIT
DAY_LIMIT
SESSION_LIMIT
QUEUE_ADD
QUEUE_REMOVE
ACQUIRE_START
ACQUIRE_SUCCESS
ACQUIRE_FAILED
```

---

## Debugging a Rejected Lead

If a lead is rejected, inspect:

```text
Debug → Reason
```

The log should identify the stage that rejected the lead.

Example:

```text
Reason:
PRODUCT_NAME_MISMATCH
```

or:

```text
Reason:
COUNTRY_BLOCKED
```

This makes filter troubleshooting significantly easier than inspecting the entire lead card manually.

---

# Troubleshooting

## Nothing Happens on IndiaMART

Check:

1. The extension is enabled.
2. The correct IndiaMART page is open.
3. The selected operating mode is correct.
4. Emergency Stop is disabled.
5. The Debug page is receiving logs.
6. The browser extension console contains no errors.

---

## All Leads Are Rejected

Check:

1. The active filter.
2. Product names.
3. Required keywords.
4. Negative keywords.
5. Country restrictions.
6. Minimum score.
7. Debug rejection reasons.

If the reason is:

```text
PRODUCT_NAME_MISMATCH
```

verify that the configured product name corresponds to the actual IndiaMART product title.

---

## Leads Match Too Broadly

Check for overly generic product keywords such as:

```text
cream
gel
oil
mask
skin
serum
```

Generic words can match many unrelated products.

Prefer specific product phrases when possible.

For example:

```text
Retinol Serum
```

is more precise than:

```text
Serum
```

---

## Incorrect Country Detection

Verify:

1. Country code extraction.
2. Location parsing.
3. Strict country configuration.
4. Debug country events.

Avoid substring-based country matching.

For example:

```text
in
```

must not be used as a generic substring to detect:

```text
India
```

because it can incorrectly match words such as:

```text
Berlin
```

---

## Queue Stops During Acquisition

Check:

1. Rate limits.
2. Cooldown.
3. Popup timeout.
4. Confirmation settings.
5. Purchase-action configuration.
6. Emergency Stop.
7. Browser console errors.
8. Debug logs.

---

## Supabase Errors

Check:

1. Supabase URL.
2. Supabase API key.
3. Table names.
4. Row Level Security policies.
5. Database permissions.
6. Network connectivity.
7. Debug logs.

Never expose a Supabase `service_role` key inside a browser extension.

---

# Important Development Rules

These rules should be followed when modifying the matching system.

### Rule 1 — Keep Product Matching Separate

Do not concatenate:

```javascript
productName + messageText + category
```

into a single searchable string.

Always keep the fields separate.

---

### Rule 2 — Product Keywords Match the Product

Product keywords should be evaluated against:

```javascript
lead.productName
```

not the entire lead-card text.

---

### Rule 3 — Required Keywords Are Separate

Required keywords may use:

```text
productName
+
messageText
```

according to the configured matching rules.

Do not use required keywords as a replacement for product validation.

---

### Rule 4 — Negative Keywords Must Be Controlled

Negative keywords should be evaluated against the intended field only.

Do not blindly scan the entire card because unrelated text can cause false rejections.

---

### Rule 5 — Avoid Raw `indexOf()` Matching

Prefer normalized token/phrase matching.

Avoid:

```javascript
text.indexOf(keyword) !== -1
```

for product qualification.

---

### Rule 6 — Log Every Important Decision

A lead should be traceable from:

```text
DISCOVERED
→ PARSED
→ FILTERED
→ SCORED
→ QUEUED
→ ACQUIRED
```

or:

```text
DISCOVERED
→ PARSED
→ REJECTED
```

with a clear rejection reason.

---

### Rule 7 — Revalidate Before Acquisition

A lead should be checked again immediately before performing an acquisition action.

This prevents stale queue entries from being processed incorrectly.

---

# Testing

Before releasing changes to the matching system, test at least the following scenarios.

## Test 1 — Product-Only Matching

Product:

```text
Retiwin Retinol Skin Serum
```

Message:

```text
Need sunscreen for daily use.
```

Keyword:

```text
sunscreen
```

Expected:

```text
REJECT
```

Because the product itself is not sunscreen.

With:

```text
retinol
```

Expected:

```text
MATCH
```

---

## Test 2 — Negative Keyword False Positive

Negative keyword:

```text
used
```

Product:

```text
Unused Sunscreen
```

Expected behavior should be verified against the configured token-matching rules and must not treat `used` as a substring of `unused`.

---

## Test 3 — Country Filtering

Location:

```text
Berlin, Germany
```

Allowed country:

```text
IN
```

Expected:

```text
COUNTRY_BLOCKED
```

Location:

```text
New Delhi, India
```

Expected:

```text
COUNTRY_ALLOWED
```

---

## Test 4 — Required Keyword Alternatives

Required keywords:

```text
serum
sunscreen
```

Product:

```text
Retinol Serum
```

Expected:

```text
PASS
```

Product:

```text
Body Lotion
```

Expected:

```text
FAIL
```

---

## Test 5 — Confirmation vs Purchase Dialog

Verify that confirmation dialogs and purchase dialogs are correctly identified and handled separately.

---

## Test 6 — Duplicate Lead

Process the same lead twice.

Expected:

```text
First attempt → NEW
Second attempt → DUPLICATE
```

---

## Test 7 — Reload Persistence

Reject a lead, reload the IndiaMART page, and verify that the same lead is not incorrectly counted as a completely new lead.

---

# Recommended Production Workflow

For a new filter, use this workflow:

```text
Create Filter
      ↓
DRY_RUN
      ↓
Inspect Debug Logs
      ↓
Verify Product Matching
      ↓
Verify Country Filtering
      ↓
Verify Required / Negative Keywords
      ↓
Verify Duplicate Detection
      ↓
ASSISTED Mode
      ↓
Verify Acquisition Behavior
      ↓
AUTOMATIC Mode
```

Do not immediately enable automatic acquisition for a new filter before validating its matching behavior.

---

# Architecture Overview

```text
┌──────────────────────────────┐
│        IndiaMART Page        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Lead Scanner          │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Lead Parser           │
│ Product / Message / Location │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       Filter Engine          │
│ Product / Required / Negative│
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       Country Filter         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Lead Scorer           │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       Duplicate Manager      │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       Safety Controller      │
│ Limits / Cooldown / Stop     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Lead Queue            │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Acquisition Engine      │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Supabase CRM Sync       │
└──────────────────────────────┘
```

---

# Performance Considerations

The extension is designed to process dynamically loaded IndiaMART leads efficiently.

Performance-sensitive areas include:

- DOM scanning
- Mutation observation
- Scroll operations
- Lead parsing
- Queue processing
- Popup detection
- Supabase synchronization

When modifying timing values, balance processing speed with page stability.

Aggressive polling or extremely short delays can increase:

- CPU usage
- DOM processing
- Network activity
- Race conditions
- Duplicate events
- UI instability

---

# Security Considerations

The extension interacts with external CRM infrastructure and therefore requires careful handling of credentials and permissions.

### Recommended practices

- Never embed privileged Supabase credentials.
- Use appropriate Row Level Security policies.
- Restrict database access to the required operations.
- Avoid exposing unnecessary API endpoints.
- Validate data before database insertion.
- Avoid storing sensitive information unnecessarily.
- Keep browser permissions limited to what the extension actually requires.

---

# Versioning

Keep the extension version consistent across:

```text
manifest.json
configuration UI
popup
debug interface
documentation
```

When releasing a new version:

1. Update the version number.
2. Document behavioral changes.
3. Document migration requirements.
4. Test the complete acquisition pipeline.
5. Verify Supabase compatibility.
6. Update the README.

---

# Development Checklist

Before committing changes:

```text
[ ] Product matching tested
[ ] Required keywords tested
[ ] Negative keywords tested
[ ] Country filtering tested
[ ] Duplicate detection tested
[ ] Queue tested
[ ] Rate limits tested
[ ] Emergency Stop tested
[ ] Acquisition dialog tested
[ ] Supabase synchronization tested
[ ] Debug logs verified
[ ] Browser console checked
[ ] Extension reloaded successfully
```

---

# Release Checklist

Before production deployment:

```text
[ ] Version number updated
[ ] README updated
[ ] Database schema verified
[ ] Supabase RLS verified
[ ] Product matching verified
[ ] Country filtering verified
[ ] Rate limits configured
[ ] DRY_RUN tested
[ ] ASSISTED mode tested
[ ] AUTOMATIC mode tested
[ ] Duplicate handling verified
[ ] Emergency Stop verified
[ ] Debug logging verified
```

---

# Credits

Developed by:

**[Keyn Labs](https://leadsync-tau-sand.vercel.app/)**

For support, feature requests, improvements, or bug reports, contact the development team or open an issue in the project repository.

---

## Final Notes

The most important design principle of this project is:

> **Discover broadly, validate precisely, and acquire only after final verification.**

IndiaMART search results are used for lead discovery, but the final acquisition decision should be based on structured lead data and explicit filtering rules.

The product name, buyer message, category, country, location, scoring, duplicate state, and acquisition state should remain separate throughout the pipeline.

This separation makes the system easier to debug, safer to maintain, and significantly less prone to false-positive acquisitions.