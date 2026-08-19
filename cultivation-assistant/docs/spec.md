# Cultivation Assistant for Home Assistant

## Product and Technical Specification

## 1. Product Summary

Cultivation Assistant is a local-first Home Assistant app for home growers.

It combines:

* Plant lifecycle tracking
* Breeder-specific strain timelines
* Nutrient and feeding-plan management
* ESPHome sensor monitoring
* Reservoir and irrigation monitoring
* Environmental guidance
* Equipment-state correlation
* Energy and material cost tracking
* Yield and break-even projections
* Home Assistant automations, notifications, and entities

The primary deployment target is Home Assistant OS as an installable Home Assistant app with an Ingress-based web interface.

A companion Home Assistant custom integration exposes cultivation-specific entities, actions, events, calendars, and diagnostics.

A standalone OCI container may later support Home Assistant Container users.

---

# 2. Product Principles

## 2.1 Local First

All plant records, sensor summaries, feeding plans, photos, cost data, and guidance should remain on the user’s Home Assistant host unless the user explicitly exports them.

The core application must not require a cloud account.

## 2.2 Home Assistant Owns Physical Safety

Home Assistant remains responsible for:

* Device integrations
* ESPHome connectivity
* Lighting schedules
* Pump runtime limits
* Leak shutdowns
* Reservoir overflow protection
* Fan safety automations
* Equipment interlocks
* Mobile notifications
* Emergency stops

Cultivation Assistant may recommend or request actions, but critical controls must be enforced locally by Home Assistant scripts or automations.

## 2.3 Evidence-Based Guidance

Guidance must clearly distinguish:

* Measured facts
* Calculated values
* Manufacturer instructions
* Breeder estimates
* Community observations
* User-defined targets
* Application suggestions

The application should not claim certainty where only correlation exists.

## 2.4 Plan Versus Actual

Projected timelines, feeding charts, cost estimates, and yield scenarios are plans.

Actual plant events, feedings, sensor readings, purchases, harvest dates, and yields must be recorded separately.

## 2.5 Explainability

Every alert or recommendation should show:

* What changed
* Which data was used
* How long the condition existed
* Which target or rule was exceeded
* Relevant equipment states
* Suggested checks
* Confidence level

---

# 3. Target User

The initial target user is a home grower operating one or more indoor grow spaces.

Typical setup:

* One or more tents or rooms
* ESP32 devices using ESPHome
* Temperature and humidity sensors
* CO₂ sensor
* PAR or PPFD sensor
* Grow lights
* Fans
* Humidifier or dehumidifier
* Irrigation pump or AutoPot system
* Optional reservoir level sensor
* Optional pH, EC, flow, leak, or energy sensors

Commercial compliance, seed-to-sale tracking, and regulated inventory management are outside the initial scope.

---

# 4. System Architecture

```text
ESP32 and other devices
        │
        │ ESPHome and Home Assistant integrations
        ▼
Home Assistant Core
        │
        ├── Raw sensor entities
        ├── Equipment entities
        ├── Scripts and automations
        ├── Energy history
        └── Notifications
        │
        ├──────────────────────────────┐
        ▼                              ▼
Companion integration          Cultivation Assistant app
Custom component               Containerized service
        │                              │
        ├── Derived entities           ├── REST API
        ├── Actions                    ├── Event subscriber
        ├── Events                     ├── Guidance engine
        ├── Calendar                   ├── Timeline engine
        ├── Diagnostics                ├── Feeding engine
        └── Config flow                ├── Cost engine
                                       ├── SQLite database
                                       ├── Photo storage
                                       └── Ingress web UI
```

## 4.1 Home Assistant App

The Home Assistant app owns:

* Ingress UI
* Application API
* Cultivation database
* Photo and attachment storage
* Breeder and strain library
* Nutrient-product library
* Feeding plans
* Plant timelines
* Environment aggregation
* Reservoir analytics
* Cost and yield calculations
* Reports
* Guidance generation

## 4.2 Companion Integration

The custom integration owns:

* Configuration flow
* Discovery of the running app
* Derived Home Assistant entities
* Home Assistant actions
* Event forwarding
* Calendar integration
* Diagnostics
* Availability and health reporting

## 4.3 Embedded Frontend

The user interface may be implemented as a SPA, but it is deployed as the Ingress frontend inside the Home Assistant app.

Recommended frontend stack:

```text
React
TypeScript
Vite
TanStack Query
TanStack Router
React Hook Form
Zod
Tailwind CSS
Recharts
```

## 4.4 Backend

Recommended backend stack:

```text
Python
FastAPI
Pydantic
SQLAlchemy 2
Alembic
SQLite
httpx
asyncio
pytest
```

SQLite should use WAL mode.

The domain layer should not depend directly on FastAPI or Home Assistant so the core logic can be tested independently.

---

# 5. Main Navigation

```text
Overview
Plants
Timeline
Environment
Reservoirs
Feeding
Tasks
Costs
Library
Reports
Settings
```

---

# 6. Core Domain Model

```text
Installation
 ├── Grow Spaces
 │    ├── Home Assistant Entity Mappings
 │    ├── Environment Targets
 │    ├── Reservoirs
 │    ├── Irrigation Zones
 │    └── Grows
 │         ├── Plants
 │         ├── Projected Timelines
 │         ├── Actual Stage Events
 │         ├── Journal Entries
 │         ├── Photos
 │         ├── Measurements
 │         ├── Feeding Plans
 │         ├── Feeding Events
 │         ├── Costs
 │         ├── Yield Projections
 │         └── Harvest Results
 ├── Breeders
 ├── Strain Cultivars
 ├── Nutrient Manufacturers
 ├── Nutrient Lines
 ├── Nutrient Products
 ├── Guidance Rules
 └── Application Settings
```

---

# 7. Grow Spaces

A grow space represents a tent, room, cabinet, greenhouse zone, or hydroponic system.

## 7.1 Grow Space Fields

```text
Name
Description
Location
Active status
Default light schedule
Default electricity tariff
Area
Volume
Default environment targets
```

## 7.2 Entity Mapping

Users map existing Home Assistant entities to semantic roles.

Supported environmental roles:

```text
Air temperature
Canopy temperature
Root-zone temperature
Relative humidity
CO₂
Illuminance
PAR or PPFD
Water temperature
VPD source, if externally calculated
Power
Energy
Leak detection
```

Supported equipment roles:

```text
Grow light
Exhaust fan
Intake fan
Circulation fan
Humidifier
Dehumidifier
Heater
Irrigation pump
Fill pump
Circulation pump
Valve
Emergency-stop script
```

Multiple entities may be mapped to the same role.

Each mapping stores:

```text
Entity ID
Role
Display name
Priority
Source unit
Normalized unit
Enabled status
Calibration metadata
Stale-data threshold
```

---

# 8. Plant Lifecycle Tracking

## 8.1 Plant Record

```text
Plant name
Grow
Strain cultivar
Breeder
Seed or clone
Seed type
Start date
Current stage
Status
Container
Medium
Location
Expected harvest window
Actual harvest date
Notes
Primary photo
```

Plant status:

```text
Planned
Active
Harvested
Completed
Lost
Archived
```

## 8.2 Lifecycle Stages

Default stages:

```text
Seed
Germination
Seedling
Vegetative
Flowering
Harvest
Drying
Curing
```

Users may rename, disable, or add custom stages.

## 8.3 Stage Events

Every stage transition stores:

```text
Plant
Stage
Projected start
Projected end
Actual start
Actual end
Source
Notes
Created timestamp
```

Sources:

```text
Generated
User confirmed
User adjusted
Imported
Application recalculation
```

## 8.4 Activity Timeline

Supported events include:

```text
Watered
Fed
Transplanted
Topped
Trained
Defoliated
Light schedule changed
Flowering initiated
First flowers observed
Reservoir refilled
Irrigation completed
Problem observed
Treatment applied
Harvested
Drying started
Jarred
Cure milestone
Photo added
Measurement recorded
Note
```

---

# 9. Breeder and Strain Database

## 9.1 Breeder-Specific Cultivars

Cultivars with the same common name but different breeders must be separate records.

Example:

```text
Northern Lights — Breeder A
Northern Lights — Breeder B
```

## 9.2 Cultivar Fields

```text
Canonical name
Breeder
Breeder product name
Seed type
Lineage
Photoperiod or autoflower
Indica percentage
Sativa percentage
Breeder flowering minimum
Breeder flowering maximum
Seed-to-harvest minimum
Seed-to-harvest maximum
Expected stretch range
Indoor yield range
Outdoor yield range
Difficulty
Feeding sensitivity
Preferred training methods
Climate notes
Terpene profile
Breeder description
Verification status
Last verified date
```

Verification status:

```text
Breeder verified
Secondary source
Community supplied
User supplied
Unverified
```

## 9.3 Source Provenance

Every factual strain claim should store:

```text
Source type
Source reference
Retrieved date
Claim type
Original value
Normalized value
Notes
```

## 9.4 User Overrides

Users may override any timeline or cultivation attribute for their own installation without changing the base library record.

---

# 10. Projected Plant Timeline

## 10.1 Inputs

Timeline generation uses:

* Breeder and cultivar
* Seed or clone
* Autoflower or photoperiod
* Start date
* Planned vegetative duration
* Grow medium
* Previous grows
* User overrides
* Actual stage transitions
* Delays and recorded stress events

## 10.2 Output

The engine generates:

```text
Projected germination range
Projected seedling period
Projected vegetative period
Projected transition period
Projected flowering period
Projected harvest window
Projected drying period
Projected curing milestones
```

## 10.3 Confidence

```text
Low
Medium
High
```

Confidence inputs:

* Quality of breeder data
* Number of previous matching grows
* Amount of actual stage data
* Degree of manual customization
* Recent timeline variance

## 10.4 Recalculation

Timeline projections recalculate when:

* Germination differs from plan
* Vegetative duration changes
* Actual flowering begins
* The grower changes the light schedule
* A stage is manually adjusted
* Major stress or interruption is recorded
* Previous cultivar history becomes available

The application must preserve projection versions.

Example:

```text
Original harvest window: October 12–19
Current harvest window: October 18–25
Timeline variance: +6 days
```

---

# 11. Visual Timeline

## 11.1 Plant Timeline

The visual timeline displays:

* Completed stages
* Current stage
* Upcoming stages
* Planned dates
* Actual dates
* Progress
* Confidence
* Timeline variance
* Tasks
* Feed phases
* Environment incidents
* Photos
* Training events
* Irrigation events
* Cost milestones

## 11.2 Grow Timeline

A multi-plant view aligns plants by calendar date.

```text
Plant A  Seedling ─ Veg ───────── Flower ───── Harvest
Plant B     Seedling ─ Veg ─────── Flower ───── Harvest
Plant C  Seedling ─── Veg ────────── Flower ─────── Harvest
```

## 11.3 Stage Detail

Selecting a stage displays:

```text
Stage description
Expected plant changes
Projected and actual dates
Environmental targets
Feeding phase
Measurements
Photos
Tasks
Journal events
Relevant guidance
```

---

# 12. Journal, Photos, and Measurements

## 12.1 Journal Entry

```text
Plant or grow
Date and time
Title
Notes
Tags
Related stage
Related issue
Attachments
```

## 12.2 Photos

Store:

```text
Plant
Date
Stage
Caption
Tags
Original file
Thumbnail
Optional measurement reference
```

Features:

* Timeline view
* Grid view
* Before-and-after comparison
* Weekly comparison
* Export in reports

## 12.3 Measurements

Supported measurements:

```text
Height
Width
Canopy diameter
Stem diameter
Node count
Container weight
Plant weight
Custom metric
```

---

# 13. Environment Monitoring

## 13.1 Supported Metrics

```text
Temperature
Relative humidity
CO₂
PAR or PPFD
Illuminance
VPD
DLI
Water temperature
Power
Energy
```

Normalized units:

```text
Temperature: °C
Humidity: %
CO₂: ppm
PPFD: µmol/m²/s
Illuminance: lux
VPD: kPa
DLI: mol/m²/day
Energy: kWh
Power: W
Volume: L
Flow: L/min
```

## 13.2 Data Collection

The app subscribes to relevant Home Assistant state changes.

Suggested storage:

```text
Immediate state: in memory
One-minute aggregates: 30 days
Five-minute aggregates: 12 months
Hourly summaries: indefinite
Daily summaries: indefinite
```

The Home Assistant recorder remains the source of raw general-purpose history.

## 13.3 Derived Metrics

The app calculates:

* VPD
* DLI
* Lights-on average PPFD
* Day and night averages
* Time in target
* Time above target
* Time below target
* Rate of change
* Sensor freshness
* Environment stability score

## 13.4 Targets

Targets are user-editable and may vary by:

* Grow space
* Plant stage
* Lights on or off
* Cultivar
* User profile

No cultivation target should be hard-coded as universally correct.

---

# 14. Environmental Guidance Engine

## 14.1 First-Version Approach

The first version uses deterministic rules.

AI-generated prose may summarize validated findings later, but it must not create unsupported observations.

## 14.2 Processing Pipeline

```text
Home Assistant state changes
        ↓
Unit normalization
        ↓
Freshness and validity checks
        ↓
Aggregation and smoothing
        ↓
Stage-aware target evaluation
        ↓
Duration and trend evaluation
        ↓
Equipment-state correlation
        ↓
Guidance observation
```

## 14.3 Guidance Output

Each observation stores:

```text
Title
Severity
Category
Measured evidence
Target evidence
Duration
Relevant stage
Relevant equipment state
Possible explanations
Suggested checks
Confidence
Opened time
Acknowledged time
Resolved time
```

Severity:

```text
Information
Attention
Warning
Critical
```

## 14.4 Example Guidance

```text
Nighttime humidity remained above your configured flowering target for
74 minutes.

Evidence:
Current stage: Flowering
Configured maximum: 65%
Maximum measured humidity: 74%
Temperature fell by 3.1°C after lights-off
Exhaust fan remained at 30%
Irrigation completed 48 minutes before lights-off

Suggested checks:
- Confirm the reading using another sensor
- Inspect airflow below the canopy
- Review the nighttime fan preset
- Consider whether irrigation timing contributes to the pattern

Confidence: High
```

## 14.5 Sensor Reliability

Guidance should pause or reduce confidence when:

* Data is stale
* Values are impossible
* Sensors disagree materially
* A sensor has recently restarted
* Calibration is overdue
* Connectivity is unstable

---

# 15. Reservoir and Tank Monitoring

## 15.1 Supported Systems

```text
AutoPot reservoir
DWC bucket
RDWC control reservoir
Irrigation supply tank
Mixing tank
Top-off tank
RO or source-water tank
Runoff or waste tank
Custom reservoir
```

## 15.2 Sensor Types

Continuous:

```text
Percentage
Liquid depth
Distance to liquid
Pressure
Capacitance
Ultrasonic
Radar
Weight
Flow-derived volume
```

Binary:

```text
Low level
Empty
High level
Overflow
Leak
```

## 15.3 Reservoir Fields

```text
Name
Type
Capacity
Usable capacity
Minimum safe volume
Refill threshold
Overflow threshold
Tank geometry
Sensor mappings
Pump mapping
Fill-valve mapping
Flow mapping
Leak-sensor mapping
Grow-space relationships
```

## 15.4 Geometry and Calibration

Supported tank models:

* Rectangular
* Vertical cylinder
* Horizontal cylinder
* Custom calibration table
* Load-cell conversion
* Flow-derived estimate

A custom calibration table maps raw readings to known volume values.

## 15.5 Reservoir Dashboard

Display:

```text
Current level
Current volume
Usable remaining volume
Daily consumption
Seven-day average consumption
Estimated refill time
Estimated irrigation cycles remaining
Last refill
Last sensor update
Current flow
Pump state
Valve state
Water temperature
Data quality
```

## 15.6 Reservoir Guidance

Examples:

* Low-level warning
* Refill forecast
* Unexpected rapid loss
* Possible leak
* No level change despite expected demand
* Possible blocked line
* Unexpected fill
* Sensor stuck
* Top-off running too long
* RDWC return-flow mismatch

---

# 16. Irrigation Monitoring

## 16.1 Irrigation Zone

```text
Name
Grow space
Source reservoir
Pump entity
Valve entity
Flow entity
Maximum runtime
Expected flow range
Emergency-stop script
```

## 16.2 Irrigation Event

```text
Trigger
Requested duration
Actual duration
Requested volume
Measured volume
Source volume before
Source volume after
Average flow
Start time
Completion time
Result
Home Assistant context
```

Triggers:

```text
Manual
Schedule
Moisture
Weight
Home Assistant automation
Cultivation plan
```

Results:

```text
Completed
Stopped
Failed
Low reservoir
No flow
Unexpected flow
Leak detected
Emergency stopped
```

## 16.3 Safety

The app must not directly implement critical pump safety.

Home Assistant scripts or automations must enforce:

* Maximum runtime
* Minimum reservoir level
* Leak shutdown
* Pump dry-run protection
* Flow validation
* Valve sequencing
* Cooldown
* Emergency stop

The app should invoke approved scripts rather than raw switches whenever possible.

---

# 17. Nutrient Database

## 17.1 Manufacturer

```text
Name
Website
Country
Notes
```

## 17.2 Nutrient Line

```text
Manufacturer
Name
Supported media
Description
Source
```

## 17.3 Nutrient Product

```text
Manufacturer
Nutrient line
Product name
Category
Formulation
NPK
Guaranteed analysis
Default unit
Container size
Container cost
Compatible media
Application method
Manufacturer dose minimum
Manufacturer dose maximum
Dose basis
Warnings
Mixing-order notes
Source
Last verified date
```

Categories include:

```text
Base nutrient
Calcium and magnesium
Micronutrient
Root additive
Silica
Enzyme
Biological
Bloom additive
Carbohydrate
pH adjustment
Finishing product
Custom
```

## 17.4 Custom Products

Users may add private products and prices.

---

# 18. Feeding-Chart Generator

## 18.1 Inputs

```text
Grow
Cultivar
Medium
Container size
Water source
Starting-water EC
Nutrient line
Selected products
Reservoir or batch volume
Feeding frequency
Feeding strength
Target EC or PPM
Target pH
Projected timeline
```

## 18.2 Feeding Strength

```text
Light
Standard
Heavy
Custom percentage
```

The interface must show both manufacturer guidance and user-adjusted values.

## 18.3 Generated Plan

Each phase contains:

```text
Stage
Week
Start and end date
Products
Dose per liter
Total dose
Target EC
Target pH
Water volume
Estimated cost
Mixing order
Notes
```

Views:

* Weekly
* Stage
* Calendar
* Per-event
* Printable
* Mobile checklist

## 18.4 Versioning

Every meaningful modification creates a new plan version.

```text
Version 1: Imported manufacturer plan
Version 2: Reduced strength to 75%
Version 3: Extended vegetative phase by seven days
```

## 18.5 Planned Versus Actual

Actual feeding records:

```text
Date
Water volume
Products and quantities
Starting EC
Final EC
pH
Runoff EC
Runoff pH
Reservoir
Plant response
Notes
```

## 18.6 Safety Checks

Flag:

* Large dose increases
* Duplicate nutrient sources
* Product incompatibilities
* High starting-water EC
* Target values outside user limits
* Mixing-order concerns
* Repeated runoff changes
* Signs associated with overfeeding

All product-label guidance should be treated as source material, not as a guaranteed optimal schedule.

---

# 19. Tasks and Calendar

Tasks may be generated from:

* Plant stage
* Feeding plan
* Timeline milestones
* Reservoir forecast
* Environmental guidance
* Drying and curing schedule
* User-created recurring tasks

Examples:

```text
Record weekly measurements
Prepare feeding solution
Refill reservoir
Inspect irrigation lines
Review nighttime humidity
Calibrate pH sensor
Take weekly photo
Review harvest window
Burp curing jars
```

The integration may expose:

* Home Assistant calendar events
* Home Assistant to-do items
* Due-task sensors
* Mobile notifications

---

# 20. Cost and Break-Even Calculator

## 20.1 Cost Categories

```text
Electricity
Seeds or clones
Nutrients
Medium
Containers
Water
Filters
Calibration solutions
Training materials
Pest-management supplies
Drying supplies
Curing supplies
Equipment allocation
Repairs
Miscellaneous
```

## 20.2 Energy Inputs

Preferred source order:

1. Measured Home Assistant energy entity
2. Measured power and runtime
3. Rated wattage and runtime
4. Manual estimate

Support:

* Fixed electricity rate
* Day and night tariff
* Time-based tariff periods
* Manual price changes

## 20.3 Equipment Allocation

```text
Allocated grow cost =
Purchase price ÷ expected number of grows
```

Users may instead choose depreciation by hours or years.

## 20.4 Timeline-Based Projection

Projected energy cost uses:

* Device wattage
* Stage duration
* Lighting schedule
* Expected fan runtime
* Expected humidity-control runtime
* Irrigation runtime
* Drying runtime
* Electricity tariff

Timeline changes must update cost projections.

## 20.5 Nutrient Cost

```text
Product cost per unit
× projected quantity consumed
```

## 20.6 Outputs

```text
Spent to date
Projected remaining cost
Projected total cost
Energy cost
Material cost
Equipment allocation
Cost per plant
Projected cost per gram
Break-even yield
Comparison savings
```

## 20.7 Scenarios

```text
Conservative yield
Expected yield
Optimistic yield
```

Users manually enter a comparison value per gram.

The application should not maintain a cannabis marketplace-price database.

---

# 21. Yield Projection

Initial projections use:

* Breeder claims
* Grow-space area
* Light power
* Cultivar
* Plant count
* Previous grows
* User estimate
* Current measurements
* Environmental stability

The initial output should be a range.

```text
Projected dry yield: 220–320 g
Confidence: Low
```

Prediction history must be retained.

---

# 22. Dashboard

## 22.1 Grow Overview

```text
Current stage
Stage day
Projected harvest window
Timeline variance
Active plants
Tasks due
Next feeding
Environment status
Reservoir status
Cost to date
Projected total cost
Yield range
```

## 22.2 Today View

Example:

```text
Flowering · Day 18
Projected harvest: 45–52 days
Timeline status: On schedule

Environment:
Humidity above target for 22 minutes
DLI is 64% complete
Sensor quality is good

Reservoir:
68% full
Estimated refill in 4.2 days

Feeding:
Next feeding tomorrow
Planned batch: 12 L

Costs:
Spent to date: €214
Projected total: €421
```

## 22.3 Action Cards

Examples:

* Review elevated nighttime humidity
* Refill reservoir within four days
* Prepare tomorrow’s feeding
* Record weekly measurements
* Confirm PAR sensor calibration

---

# 23. Native Home Assistant Entities

## 23.1 Plant and Timeline

```text
sensor.cultivation_current_stage
sensor.cultivation_stage_day
sensor.cultivation_projected_harvest
sensor.cultivation_days_until_harvest
sensor.cultivation_timeline_variance
sensor.cultivation_active_plants
```

## 23.2 Environment

```text
sensor.cultivation_vpd
sensor.cultivation_dli
sensor.cultivation_environment_score
sensor.cultivation_time_in_target
sensor.cultivation_active_guidance_count
binary_sensor.cultivation_environment_attention
binary_sensor.cultivation_sensor_data_reliable
```

## 23.3 Feeding

```text
sensor.cultivation_next_feeding
sensor.cultivation_feed_plan_week
sensor.cultivation_next_feeding_volume
sensor.cultivation_next_feeding_target_ec
binary_sensor.cultivation_feeding_due
```

## 23.4 Reservoirs

```text
sensor.cultivation_reservoir_level
sensor.cultivation_reservoir_volume
sensor.cultivation_reservoir_days_remaining
sensor.cultivation_reservoir_cycles_remaining
sensor.cultivation_reservoir_consumption_today
sensor.cultivation_next_refill
binary_sensor.cultivation_reservoir_low
binary_sensor.cultivation_reservoir_anomaly
binary_sensor.cultivation_irrigation_flow_confirmed
```

## 23.5 Costs

```text
sensor.cultivation_cost_to_date
sensor.cultivation_projected_total_cost
sensor.cultivation_energy_cost_today
sensor.cultivation_projected_cost_per_gram
sensor.cultivation_break_even_yield
```

Do not duplicate raw ESPHome entities unless normalization is necessary.

---

# 24. Home Assistant Actions

```text
cultivation.record_watering
cultivation.record_feeding
cultivation.record_measurement
cultivation.record_reservoir_refill
cultivation.record_manual_topoff
cultivation.advance_stage
cultivation.recalculate_timeline
cultivation.run_irrigation
cultivation.stop_irrigation
cultivation.request_reservoir_fill
cultivation.cancel_reservoir_fill
cultivation.acknowledge_guidance
cultivation.generate_daily_summary
```

Physical-control actions should invoke configured Home Assistant scripts wherever possible.

---

# 25. Home Assistant Events

```text
cultivation_stage_changed
cultivation_feeding_due
cultivation_harvest_window_opened
cultivation_environment_guidance_created
cultivation_sensor_anomaly_detected
cultivation_reservoir_low
cultivation_reservoir_anomaly
cultivation_possible_leak
cultivation_possible_blockage
cultivation_irrigation_completed
cultivation_irrigation_failed
cultivation_cost_projection_changed
```

---

# 26. Notifications

Support:

* In-app notifications
* Home Assistant persistent notifications
* Home Assistant mobile notifications
* Optional email through existing Home Assistant notification services

Alerts should use:

* Duration thresholds
* Hysteresis
* Cooldowns
* Deduplication
* Acknowledgement
* Automatic resolution

---

# 27. Reports and Export

## 27.1 Grow Plan Report

Contains:

* Cultivar and breeder
* Projected timeline
* Feeding chart
* Environment targets
* Reservoir plan
* Cost projection
* Yield scenarios

## 27.2 Weekly Report

Contains:

* Plant progress
* Timeline variance
* Measurements
* Feeding events
* Reservoir usage
* Environment summary
* Guidance
* Equipment runtime
* Cost changes
* Photo comparison

## 27.3 Final Grow Report

Contains:

* Original versus actual timeline
* Feeding history
* Environment stability
* Reservoir consumption
* Irrigation events
* Total energy
* Total cost
* Harvest result
* Cost per gram
* Problems and treatments
* Lessons and notes

## 27.4 Export Formats

```text
JSON
CSV
PDF
ZIP archive containing records and photos
```

---

# 28. Database Schema

Minimum entities:

```text
app_settings
grow_spaces
entity_mappings
grows
plants
plant_stage_events
timeline_projections
timeline_projection_stages
journal_entries
photos
measurements

breeders
strain_cultivars
strain_sources
strain_user_overrides

nutrient_manufacturers
nutrient_lines
nutrient_products
nutrient_sources
feeding_plans
feeding_plan_versions
feeding_plan_phases
feeding_plan_items
feeding_events
feeding_event_items

environment_targets
environment_aggregates
environment_daily_summaries
guidance_rules
guidance_observations
guidance_feedback

reservoirs
reservoir_entity_mappings
reservoir_calibration_points
reservoir_readings
reservoir_events
reservoir_forecasts
reservoir_anomalies
irrigation_zones
irrigation_events

tasks
cost_items
equipment_cost_profiles
energy_cost_periods
yield_projections
harvest_results

integration_status
audit_log
schema_migrations
```

All records should use stable UUID identifiers.

All timestamps should be stored in UTC and displayed in the Home Assistant user’s timezone.

---

# 29. API Requirements

The backend should expose a versioned API.

```text
/api/v1/health
/api/v1/settings
/api/v1/grow-spaces
/api/v1/entity-mappings
/api/v1/grows
/api/v1/plants
/api/v1/timelines
/api/v1/journal
/api/v1/photos
/api/v1/measurements
/api/v1/strains
/api/v1/breeders
/api/v1/nutrients
/api/v1/feeding-plans
/api/v1/feeding-events
/api/v1/environment
/api/v1/guidance
/api/v1/reservoirs
/api/v1/irrigation
/api/v1/costs
/api/v1/yields
/api/v1/tasks
/api/v1/reports
/api/v1/import
/api/v1/export
```

Requirements:

* OpenAPI schema
* Pydantic validation
* Pagination
* Filtering
* Consistent error format
* Optimistic concurrency for editable plans
* Idempotency for Home Assistant action callbacks
* Health and readiness endpoints
* Structured logs
* Request correlation IDs

---

# 30. Security

## 30.1 Authentication

Ingress access should rely on Home Assistant authentication.

The app should not expose a public unauthenticated interface by default.

## 30.2 Secrets

Do not store user-generated long-lived Home Assistant tokens.

Use the Supervisor-provided token for internal communication.

## 30.3 Control Permissions

Separate permissions conceptually for:

```text
View plant data
Edit plant data
View costs
Control environment equipment
Control irrigation
Request reservoir fill
Configure integrations
Edit libraries
Export data
```

The first local-only release may assume Home Assistant administrator access, but the internal API should be designed so finer permissions can be added later.

## 30.4 Audit Log

Record:

* Equipment commands
* Irrigation requests
* Fill requests
* Stage changes
* Feeding changes
* Timeline recalculations
* Cost modifications
* Library edits
* Imports and exports

---

# 31. Backup and Restore

Persistent app data should live in the app data directory.

Backups should include:

* SQLite database
* Configuration
* Custom strain records
* Custom nutrient records
* Guidance rules
* Photos, optionally
* Generated reports, optionally

The app should provide configurable backup categories because original photos may be large.

Database migrations must be backward-compatible and tested before release.

---

# 32. Diagnostics

Diagnostics should include:

```text
App version
Schema version
Home Assistant connection status
Mapped entity counts
Unavailable entity counts
Last event received
Database size
Photo-storage size
Aggregate record counts
Last successful summary job
Last failed task
Integration version
```

Diagnostics must redact:

* Personal notes
* Plant names when requested
* Costs
* Photos
* Exact entity states where sensitive
* Tokens and secrets

---

# 33. Nonfunctional Requirements

## Performance

* Overview should load in under two seconds on typical Home Assistant hardware after initial cache warm-up.
* Entity updates should appear in the UI within five seconds.
* The app should remain responsive with at least 50 plants and one year of five-minute aggregates.
* Expensive reports should run as background jobs within the current process and expose progress, but critical monitoring must not depend on report completion.

## Reliability

* Home Assistant disconnections should not corrupt data.
* State subscriptions should reconnect automatically.
* Duplicate state events must be safe.
* Jobs must be restart-safe where practical.
* Failed migrations must not start the app against a partially upgraded schema.

## Accessibility

* Keyboard-accessible navigation
* Visible focus states
* Semantic headings
* Accessible forms
* Text alternatives for visual status
* No information communicated by color alone

## Responsive Design

The Ingress interface must support:

* Desktop
* Tablet
* Mobile
* Home Assistant companion app webview

---

# 34. Testing Strategy

## Unit Tests

* VPD calculation
* DLI integration
* Timeline projection
* Projection versioning
* Tank-volume conversion
* Calibration interpolation
* Reservoir forecasts
* Irrigation volume reconciliation
* Feeding-dose calculation
* Nutrient cost calculation
* Energy-cost calculation
* Break-even calculation
* Guidance-rule evaluation
* Unit normalization

## Integration Tests

* Home Assistant state subscription
* Supervisor API communication
* Entity mapping
* Integration-to-app communication
* Action idempotency
* Event publishing
* Database migrations
* Backup and restore
* Ingress path handling

## UI Tests

* New-grow wizard
* Entity mapping
* Timeline interaction
* Feeding-plan generation
* Reservoir setup
* Cost scenario editing
* Guidance acknowledgement
* Mobile layouts

## Safety Tests

* Pump requests fail when no approved script is configured
* Maximum duration is always transmitted and enforced
* Stale reservoir readings prevent automated refill recommendations
* Leak state blocks refill requests
* Duplicate irrigation requests do not create duplicate physical actions
* App disconnection does not disable existing Home Assistant safety automations

---

# 35. Delivery Phases

## Phase 1: Native Foundation

* Home Assistant app packaging
* Ingress UI
* FastAPI backend
* SQLite and migrations
* Companion integration
* Home Assistant connection
* Entity mapping
* Grow spaces
* Plants
* Journals
* Basic timeline
* Environment dashboard
* VPD and DLI

## Phase 2: Reservoirs and Planning

* Reservoir records
* Tank calibration
* Level visualization
* Consumption summaries
* Refill forecasts
* Irrigation event logging
* Breeder and strain library
* Timeline projection
* Visual timeline
* Tasks

## Phase 3: Feeding

* Nutrient library
* Nutrient-line structure
* Feeding-plan generator
* Versioned plans
* Planned versus actual feeding
* Feeding reminders
* Cost-per-feeding calculation

## Phase 4: Guidance and Economics

* Deterministic guidance engine
* Equipment-state correlation
* Environment daily summaries
* Energy import
* Material costs
* Break-even calculator
* Yield scenarios
* Weekly reports

## Phase 5: Release Hardening

* Backup and restore
* Import and export
* Diagnostics
* Accessibility
* Localization
* Performance optimization
* Stable migrations
* Full documentation
* Release automation

---

# 36. MVP Acceptance Criteria

The MVP is complete when a user can:

1. Install the Home Assistant app.
2. Open it through Ingress.
3. Install and configure the companion integration.
4. Create a grow space.
5. Map temperature, humidity, CO₂, PAR, light, fan, and reservoir entities.
6. Create a plant from a breeder-specific cultivar.
7. See a projected lifecycle and harvest window.
8. View a visual plant timeline.
9. Receive live environmental readings.
10. View calculated VPD and DLI.
11. Configure stage-specific targets.
12. Receive explainable environment guidance.
13. Configure a reservoir and calibrate its level sensor.
14. View current reservoir volume and refill forecast.
15. Log irrigation and reservoir refill events.
16. Select nutrient products and generate a feeding chart.
17. Record actual feedings.
18. Enter energy and material costs.
19. View projected total cost and break-even yield.
20. Export the grow data.

---

# 37. Out of Scope for Initial Release

* Commercial compliance
* Seed-to-sale inventory
* Public social network
* Cannabis marketplace pricing
* Automatic nutrient dosing
* Autonomous diagnosis from plant photos
* Automatic changes to safety-critical equipment without Home Assistant safeguards
* Cloud-only accounts
* Unverified claims presented as facts
* Medical or legal advice

---

# 38. Definition of Done

A feature is complete only when it includes:

* Domain model
* Database migration
* API
* Input validation
* UI
* Empty state
* Loading state
* Error state
* Audit behavior where relevant
* Unit tests
* Integration tests where relevant
* Documentation
* Backup compatibility
* Mobile usability
* Accessibility review
