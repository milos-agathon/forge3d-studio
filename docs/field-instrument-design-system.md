# Field Instrument design system

This is the original design spec from Milos's hosted Forge3D Studio, dated 6 July 2026. The desktop app adopts the palette, typography, density, and interaction language. References to web files and phases describe the original implementation.

In the desktop app, the design lives in [styles.css](../src/styles.css) and [fonts.css](../src/fonts.css). The live terrain instruments show bearing, tilt, elevation, footprint, and cursor elevation. The projected grid labels show eastings and northings when the preview retains the projected origin. Relative labels and pixel dimensions cover the other supported terrain cases. The [before and after screenshots](field-instrument-screenshots.md) show the desktop implementation.

## 1. Color tokens — `:root` migration map

Rewrite the existing `:root` variables in `apps/web/src/styles.css`. **Keep the variable names** (so
downstream CSS keeps working); change the values. New tokens are added at the end.

### Surfaces (cool charcoal ladder — the hierarchy lever)
| `styles.css` var | old (warm-dark 9.5) | new (Field Instrument) | role |
|---|---|---|---|
| `--bg-app` | `#0B0D0E` | `#0E1113` | app base (tier 0) |
| `--bg-panel` | `#141517` | `#14181B` | panel (tier 1) |
| `--bg-panel-raised` | `#1b1814` (warm) | `#1B2024` | raised control (tier 2) |
| `--surface` | `#121415` | `#14181B` | generic panel |
| `--surface-lowest` | `#0c0e0f` | `#0B0E10` | sunken |
| `--surface-low` | `#1a1c1d` | `#1B2024` | raised |
| `--surface-mid` | `#1e2021` | `#20262B` | raised+ |
| `--surface-high` | `#282a2b` | `#232A2E` | active (tier 3) |
| `--surface-bright` | `#333536` | `#2C343A` | hover-bright |

### Borders / hairlines (the elevation model)
| var | old | new | role |
|---|---|---|---|
| `--border-subtle` | `#302719` (warm) | `#2A3238` | **the hairline** — default 1px border |
| `--border-active` | `#b87620` (warm) | `#3A444B` | brighter hairline (focus/hover frame) |
| `--outline` | `#9f8e7b` (warm) | `#8A949A` | control outline |
| `--outline-soft` | `#524435` (warm) | `#20272B` | faint divider |
| _new_ `--hairline` | — | `#2A3238` | alias for intent clarity |
| _new_ `--hairline-hi` | — | `#3A444B` | active-frame hairline |

### Text (cool grey ladder)
| var | old | new |
|---|---|---|
| `--text-primary` | `#EDE6D6` (warm) | `#E4E9EC` |
| `--text-secondary` | `#a79d8d` | `#C6CED2` |
| `--text-muted` | `#8D8478` | `#8A949A` |
| _new_ `--text-faint` | — | `#5F686E` (micro-labels, disabled) |

### Accent — amber (kept, re-scoped to data/active) + support cyan
| var | old | new | usage |
|---|---|---|---|
| `--accent-primary` | `#EFA026` | `#EFA026` (**keep**) | data values, primary action fill, AOI |
| `--accent-primary-hover` | `#f2a541` | `#FFB84D` | primary hover |
| `--accent-highlight` | `#ffc06f` | `#FFB84D` | emphasized data |
| `--accent-focus` | `#ffd060` | `#FFC663` | focus ring |
| `--focus-ring` | `= --accent-focus` | `= --accent-focus` (keep alias) | reconcile naming (§6) |
| `--accent-danger` | `#d23c39` | `#E5544B` | error |
| _new_ `--amber-dim` | — | `color-mix(in srgb,rgb(239 160 38) 14%,transparent)` | active-row wash |
| _new_ `--amber-tick` | — | `color-mix(in srgb,rgb(239 160 38) 42%,transparent)` | active left-edge tick |
| _new_ `--measure` (cyan) | — | `#4FB0C4` | measurement / secondary data |
| _new_ `--measure-dim` | — | `color-mix(in srgb,rgb(79 176 196) 16%,transparent)` | cyan wash |

> **No `rgba()` anywhere in `styles.css`** — the guardrail test (`ui-effects-tokens.test.ts`) forbids it;
> all translucency uses `color-mix(in srgb, rgb(R G B) N%, transparent)`. Likewise the app's font tokens
> are `--font-data` / `--font-ui` (never `--font-mono`/`--font-sans`).

### Semantic state tokens (recolor; **keep every name** — the guardrail test requires them present)
Because **amber = active data only**: `--state-current` → `#EFA026`; `--state-source-current` →
`#C9A15C` (muted amber variant); `--state-warning` `#D69A45` → `#EFA026` (attention); `--state-running`
`#b87620` → `#4FB0C4` (cyan, in-progress); `--state-pending` → `#8A949A` (neutral grey — queued, not
active); `--state-failed` → `#E5544B`; `--state-expired` → `#6E767C`; any `--success` → `#57B98F`.
`--control-active-track` / `--control-inactive-track` → the cool amber / hairline gradients defined
verbatim in the plan's Phase 0 `:root` block. **All of the above match the plan's Phase 0 block exactly.**
Retain every token name used by `config/error-codes` copy and job-state mapping.

## 2. Radius — near-sharp (instrument, not pill)
| var | old | new |
|---|---|---|
| `--radius-sm` | `10px` | `2px` |
| `--radius-md` | `12px` | `3px` |
| `--radius-lg` | `14px` | `4px` |
| `--radius-xl` | `18px` | `6px` |
| `--radius-pill` | `999px` | `3px` — **demoted**. Dots/knobs use `border-radius: 50%` (see `styles.css` existing usage), **never inline `999px`** — the guardrail test allows `999px` only as the `--radius-pill` value, and it is now `3px`, so a literal `999px` anywhere fails the test. |

Pills become **tags**: small-radius rectangular chips. Search field, attribution, project pill, canvas
pills, sidebar rows all move to `--radius-md`.

## 3. Elevation model — hairlines, not shadows
Retire the shadow-based depth:
- `--edge-highlight` (`inset 0 1px 0 …`) → `none`.
- `--soft-shadow` (`0 18px 42px …`) → `0 2px 6px color-mix(in srgb,rgb(0 0 0) 35%,transparent)` (used sparingly for the docked
  sidebar / floating HUD only).
Depth = **background tier step + a 1px `--border-subtle` hairline.** The active control adds a **2px**
amber left-edge tick (`box-shadow: inset 3px 0 0 var(--accent-primary)`, matching the reference) +
`--amber-dim` wash + `--hairline-hi` frame.

**Hierarchy is carried by the fill-tier step *first*, hairline second, amber state third — never the
hairline alone** (hairlines are sub-3:1, §9):
- Group/panel separation relies on the background tier step (`--bg-app` → `--bg-panel` → `--surface-low`
  → active `--surface-high`); the hairline only reinforces it.
- An interactive control must be identifiable by more than the hairline: a raised fill tier and/or a
  stronger edge; hover brightens the edge (`--hairline-hi`) **and** steps the fill.
- State is always amber (active tick + `--amber-dim` wash) or the focus ring — all ≥ 3:1, so control
  state stays compliant even though the resting hairline is decorative.
This is the single most important hierarchy change; verify the tier steps read in the visual baselines.

## 4. Typography (incumbent — kept)
- `--font-ui`: **Sora** (unchanged). Weights 700/600/500/400.
- `--font-data`: **JetBrains Mono** (unchanged). `font-variant-numeric: tabular-nums` on every numeric.
- **Mono-forward labeling:** micro-labels (section eyebrows, HUD keys, LOOK, attribution, captions,
  status line) use JetBrains Mono, ~9–10px, `letter-spacing: 1.2–2.4px`, uppercase, **`--text-muted`**
  (the AA-passing muted, §9 — never `--text-faint` for readable labels).
- Scale (px): body/rows 13–13.5 · row/tag 11–12 · pill/tag 11 · micro-label 9–10 (mono, tracked) ·
  mono values 11.5–12.5 · section titles 14. Base body font-size drops from 14 → **13.5** (denser grid).

## 5. Component language
Each maps to an existing selector family in `styles.css`. Restyle in place; keep class names.

- **Buttons.** Primary = amber fill, `#1A1204` text, `--radius-md`, no shadow. Secondary = transparent
  with `--border-subtle` hairline, `--text-primary`; hover → `--surface-low` + `--hairline-hi`.
  Ghost = text-only. Press = `translateY(1px)`, no scale.
- **Tags (ex-pills).** `--radius-md`, `--bg-panel-raised`, 1px `--border-subtle`, mono label; an
  optional leading icon or amber status dot. Replaces every `.pill`.
- **Panels / cards.** `--bg-panel`, 1px `--border-subtle`, `--radius-md`, no shadow/edge-highlight.
- **Sidebar rows (instrument table).** A stacked list of hairline-separated rows: leading 18px icon,
  name (`--text-primary`), right-aligned **mono value in amber** (`--accent-primary`), trailing chevron.
  Row height **42px** (matches the reference `theme.css:229`). **Active row** = `--amber-dim` bg + a
  **3px** amber left tick (`box-shadow: inset 3px 0 0 var(--accent-primary)`, per reference
  `theme.css:238`) + `--hairline-hi` frame; expands
  to reveal its control (e.g. Terrain → tick-marked slider).
- **Sliders.** Thin track (`--surface-lowest`), amber fill, **tick marks** along the track, small square
  knob (`--radius-sm`, amber border). Reads like a calibrated dial.
- **Inputs (search, Ask Assistant).** `--bg-panel-raised`, hairline, `--radius-md`; mono placeholder in
  `--text-muted` (readable — never `--text-faint`, which fails AA per §9); focus = `--accent-focus` 2px ring.
- **Segmented / toggle (Output).** Hairline group, active segment = `--surface-high` + amber text.
- **Dropdown (LOOK).** Hairline field, mono value, chevron; the LOOK swatch shows the terrain colormap.
- **Top bar.** `--bg-panel`, bottom hairline, 56px. Two-tone amber triangular mountain logo (lit
  `#EFA026` / shadow `#B87620` / snow `#FFB84D`); wordmark Sora 700; tagline mono `--text-muted`. Project
  **tag** (not pill) center-right; circular hairline icon-buttons right.
- **Icon buttons.** 34–36px, `--radius-md` (not circle except the recenter/knob), hairline, geometric
  2px-stroke icon.

## 6. Signature structures (the app-layer instrument, new components)
These are **app-layer UI drawn over the fixed basemap / render** — never touching the map or the
backend. **Build on the existing `apps/web/src/features/aoi-map/` module** (`AoiMapPanel`): reuse
`areaLabelForBounds`, the `AoiBbox` type, and the **module-local** `selectionOverlayFromBounds` /
`boundsFromPoints` (not exported — work inside `aoi-map/index.tsx`), plus the existing `.aoi-map-line`
crosshair + `.aoi-selection-rect` overlays — restyle them, don't rebuild, and add no parallel geospatial math.
Telemetry values derive client-side from the AOI bbox the app already holds (bounded by
`config/quotas.yaml` AOI ≤ 100 km²). All overlays are `pointer-events:none` so they never block map
pan/zoom.

- **Coordinate edge rulers (region select).** Thin scales along the top (°W) and left (°N) map edges
  with mono tick labels. Pure chrome; anchors the map to a graticule the user can read.
- **Telemetry HUD (region select).** A top-docked hairline strip of mono readouts: `NW CORNER`
  (lat/lon), `SE CORNER`, `SPAN` (km × km, in `--measure` cyan), `AREA` (km², amber). Derived from the
  selection rectangle.
- **Crosshair-reticle selection.** AOI rectangle in solid amber with **corner crosshair ticks** + a
  **center reticle** + a mono `km²` tag. Replaces the soft dashed selection. **To beat the basemap's
  own amber road network** (an accepted overlap — the roads are the map, not chrome), the AOI line gets
  a **dark halo/backplate** (`outline`/`box-shadow` in `color-mix(in srgb,rgb(8 12 9) 70%,transparent)`) and a **heavier stroke weight
  than roads**, plus the reticle + `--amber-dim` fill; validate dominance (optional pixel-metric, plan
  §nice-to-have).
- **Instrument sidebar (atelier).** The refine controls as the sidebar-rows component above, active-row
  amber tick, tick-mark sliders, mono readouts — an instrument panel, not a stack of cards.
- **Telemetry loading (waiting to start).** A **compact instrument status panel**, *not* a large
  centered cinematic hero (the mockup's weakest screen — revised here per review §7.5). Group in a
  hairline panel: "Waiting to start" at restrained size (avoid a full-bleed Sora hero), a determinate
  progress bar with tick marks + mono `%`, the `WAITING TO START` mono status line, and a small amber
  status dot. Keep only a faint terrain silhouette + minimal glow as background texture — this is an
  instrument booting, not a brand moment. The mockup `b-loading.html` should be revised to match.

## 7. Iconography
Geometric line icons, **2px stroke, sharp corners, 24-grid, `currentColor`** (feather-like but squared).
Replace rounded caps/joins with miter joins where it reads sharper. Keep the amber two-tone logo.

## 8. Motion (intent)
Instant and mechanical; no easing flourish. Durations `--motion-duration-fast` 120 / standard 160.
Hover = hairline brighten (`--border-subtle` → `--hairline-hi`) + bg tier step. Active-press =
`translateY(1px)`. Progress bar reads **determinate** (ticks + %), advancing in steps, not a soft
indeterminate sweep. Panel/row expand = height + opacity, 160ms. Respect `prefers-reduced-motion`.

## 9. Accessibility (WCAG AA — measured ratios)
Measured sRGB contrast against the surface ladder (`#0E1113`/`#14181B`/`#1B2024`/`#232A2E`):
- `--text-primary #E4E9EC`: 9.1–15:1. ✓ body on every tier.
- `--text-secondary #C6CED2`: 9.1–11.9:1. ✓ body.
- `--text-muted #8A949A`: **4.70:1 (active `#232A2E`) … 6.12:1 (app)** — passes AA body on **every**
  tier. This is the color for **all meaningful micro-labels** (section eyebrows, HUD keys, ruler ticks,
  captions, input placeholders).
- `--text-faint #5F686E`: **2.56–3.33:1 — FAILS normal-text AA.** Use for **decorative/disabled only**,
  never for text a user must read. (Corrects the earlier draft's "≥3:1 for ≤10px labels" — WCAG's 3:1
  floor is for *large* text ≥18.66px/24px or non-text UI, not small labels.)
- `--accent-primary #EFA026` on panel **8.27:1**; dark-on-amber `#1A1204` on amber **8.59:1**;
  `--measure #4FB0C4` on panel **7.09:1**. ✓
- **Hairlines are NOT compliant non-text borders.** `--border-subtle #2A3238` = 1.12–1.45:1 and
  `--hairline-hi #3A444B` = 1.46–1.90:1 vs adjacent surfaces — below WCAG **1.4.11** (3:1). A hairline
  may *decorate* a boundary but must never be the sole signal of an interactive control or its state
  (see §3). The compliant state/affordance signals are the **fill tier step**, the **amber active
  tick/wash**, and the **`--accent-focus #FFC663` focus ring** (all ≥ 3:1).
Keyboard: all controls reachable/operable at the denser 13.5px grid; the accessibility suite
(`apps/web/tests/accessibility/browser-accessibility.spec.ts`) must pass.

## 10. Governing-doc reconciliation checklist (apply in **Phase 0, before CSS**; verified in Phase 4)
- `DESIGN.md`: replace warm-dark identity, radii (10/12/14/18 → 2/3/4/6), shadow/edge-highlight
  elevation → hairlines; resolve the stale header-subtitle mandate (DESIGN.md:223); note fonts kept.
- `design-prd.md`: update "warm basalt / amber-warm" and any "backend image dominant" prose (DESIGN.md:539 /
  design-prd.md:220 per the 9.5 audit).
- Token naming: document `--measure`, `--amber-tick`, `--text-faint`; reconcile `--accent-focus` ↔
  `--focus-ring`.
- `config/*` untouched (error-codes, edit-policy, quotas, quality-profiles) — verify no token a copy
  string or job-state color depends on was renamed.
