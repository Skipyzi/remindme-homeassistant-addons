# Cultivation Assistant UI foundation

## Direction

**Subject:** a local-first control and planning workspace for a home grower using Home Assistant.

**Visual idea:** “the cultivation registry.” Following the Ministry of Elsewhere style at Standard intensity, the interface treats grows as carefully administered case files. A slight Art Nouveau influence appears only in arched frames, leaf-shaped terminals, and marginal linework. Dense data and controls stay square, aligned, and unambiguous.

**Institution:** the fictional Office of Home Agriculture administers local cultivation records. The deadpan procedural contradiction is that a grow remains officially acceptable only “until conditions change.” The signature artifact is one red status-determination stamp on the active cultivation file.

## Tokens

| Token | Value | Use |
| --- | ---: | --- |
| Archive paper | `#E9E2D2` | Application canvas |
| Raised paper | `#F5EFE3` | Files, forms, and controls |
| Registry ink | `#29241F` | Primary copy and structural contrast |
| File gray | `#C8C0B1` | Tabs, fields, and inactive records |
| Stamp red | `#9F352F` | The single official determination artifact |
| Routing violet | `#62529A` | Active route and primary actions |
| Herbarium sage | `#667C62` | Healthy state and organic linework |

- Display type: **Newsreader Variable** for case titles and plant names.
- Body type: **Manrope Variable** for readable interface copy.
- Administrative type: **IBM Plex Mono** for references, dates, labels, freshness, and statuses.
- Controls use 2–3 px corners. Art Nouveau arches and asymmetric botanical corners are reserved for framing and identity, never dense task controls.
- Shadows resemble stacked paper rather than floating SaaS cards.

## Layout

```text
Desktop
┌──────────────┬──────────────────────────────────────┐
│ product      │ active grow space            alerts │
│ navigation   ├──────────────────────────────────────┤
│              │ page heading                  action │
│ cultivation  │ ┌ plant lifecycle rail ───────────┐ │
│ operations   │ └─────────────────────────────────┘ │
│ reference    │ live readings                       │
│              │ guidance | reservoir | activity     │
│ HA status    │                                      │
└──────────────┴──────────────────────────────────────┘

Mobile
┌─────────────────────────┐
│ menu   grow space  alert│
├─────────────────────────┤
│ heading          action │
│ lifecycle rail          │
│ metric grid             │
│ guidance                │
│ reservoir               │
└─────────────────────────┘
```

The shell uses hash history and Vite's relative asset base so route refreshes and static assets remain safe under a variable Home Assistant Ingress path.

## Component inventory

- `Button`: primary, secondary, ghost, compact, and icon variants.
- `Badge`: healthy, attention, informational, and neutral semantic tones.
- `Card`: surface, header, title, and content primitives.
- `StatePanel`: reusable loading, empty, and error states.
- `MetricCard`: current reading with unit, freshness/status, and metric icon.
- `GrowthRail`: responsive plant lifecycle and projection marker.
- `AppShell`: grouped navigation, grow-space switcher, connection status, and mobile drawer.

## Product language

- Guidance describes evidence and possible explanations, never proven causes.
- Sensor cards always pair readings with freshness or status.
- Projections visibly state confidence.
- Planned and actual records should use explicit labels and never rely on color alone.
- Amber means attention. Stamp red denotes an official determination only when paired with stamp shape and wording; destructive errors must include explicit error language and iconography.
