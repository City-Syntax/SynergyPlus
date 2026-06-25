# SynergyPlus logo

Three logo concepts for **SynergyPlus**, a Kubernetes-native orchestrator for
distributed [EnergyPlus](https://energyplus.net/) building-energy simulations.
The name plays on *EnergyPlus* (Synergy + Plus echoes Energy + Plus), and each
concept is a deliberate, trademark-safe **homage** to the EnergyPlus mark — not
a reproduction of it.

## What we played on (verified from the real EnergyPlus logo)

The current EnergyPlus mark is a lowercase red **`e`** fused with a blue **`+`**
(the "e+" ligature), wrapped by a green **orbital swoosh**, with the wordmark
set as light **`Energy`** + bold **`Plus`** beneath. Colors pulled from the
official assets (`energyplus.net` favicon / `release/ep_nobg.png`):

| EnergyPlus element | Color | Hex |
|---|---|---|
| The "e" / mark | red | `#ED1C2E` |
| The "+" / plus | blue | `#0082C4` |
| The orbit swoosh | green | `#009D57` |

Our three concepts each carry forward at least the **blue plus** and the
**green energy** cue, then add SynergyPlus's own idea: *synergy* = many
distributed parts working together (parallel jobs, nodes, convergence). We
intentionally drop the red "e" wordmark ligature so as not to mimic the
original, and shift the dominant hue toward green/teal.

All wordmarks use a system sans stack (`Helvetica Neue, Arial, Segoe UI,
sans-serif`) as live `<text>` — no external font files. Every SVG is
self-contained and renders standalone in a browser.

## Concepts

### Concept 1 — Synergy Orbit
**Plays on:** the green orbital swoosh + the blue plus, reimagined as an atom-
like orbit with worker nodes circling a central plus **hub**. The orbit is the
EnergyPlus swoosh closed into a full ellipse; the three teal nodes converging on
the hub are the "synergy" (distributed workers feeding one orchestrator).
**Palette:** synergy teal `#0E9E8E`, EnergyPlus blue `#0082C4`, energy green
`#009D57`, ink `#0B1F2A`.
**Files:** `concept-1.svg`, `concept-1-icon.svg`, `concept-1.png`.

### Concept 2 — Convergence Plus
**Plays on:** the blue plus, rebuilt as a **convergence hub** inside a
Kubernetes-style rounded tile. Four parallel streams (sim jobs) flow inward from
worker nodes on each edge and meet at the central plus — the literal picture of
a parametric sweep being orchestrated. The most icon-forward / app-icon-ready
direction.
**Palette:** deep teal-navy tile `#0B3B53`, stream teals `#28C2A8` / `#5BD1BC` /
`#7FE0D0`, plus blue `#0082C4`.
**Files:** `concept-2.svg`, `concept-2-icon.svg`, `concept-2.png`.

### Concept 3 — S+ Mesh
**Plays on:** the plus and the green energy, as a monogram. The **`S`** is drawn
as a green energy ribbon studded with node "pods" (distributed mesh / k8s), and
the bold blue **`+`** sits top-right as the "Plus". Reads as "S+" from full size
down to a 16 px favicon.
**Palette:** energy green `#00A85A`, node green `#0B6E3B`, plus blue `#0082C4`,
ink `#0B2E1E`.
**Files:** `concept-3.svg`, `concept-3-icon.svg`, `concept-3.png`.

## Files

```
concept-1.svg / concept-1-icon.svg / concept-1.png   Synergy Orbit
concept-2.svg / concept-2-icon.svg / concept-2.png   Convergence Plus
concept-3.svg / concept-3-icon.svg / concept-3.png   S+ Mesh
```

- `concept-N.svg` — full horizontal lockup (icon + "SynergyPlus" wordmark + tagline).
- `concept-N-icon.svg` — standalone mark, square `256×256` viewBox, favicon-safe.
- `concept-N.png` — 800 px-wide preview rendered at 2× (1600 px) via headless Chrome.

## Usage notes

- **SVG is the source of truth.** PNGs are previews only; regenerate from SVG for
  any size. The icon SVGs use a square viewBox and stay legible at 16 px.
- Concept 1 colors are defined as CSS custom properties for easy theming;
  Concepts 2 and 3 use inline hex.
- For a dark UI, all three icons sit well on a dark ground; Concept 2 already
  ships its own tile. Concepts 1 and 3 are transparent and inherit the page bg.
- The wordmark splits **Synergy** (regular) / **Plus** (bold blue) to echo the
  EnergyPlus `Energy`+`Plus` weight contrast.

## Regenerating PNG previews

No `rsvg-convert` / `cairosvg` / ImageMagick is installed in this environment;
previews were rasterized with the local Google Chrome in headless mode:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --force-device-scale-factor=2 \
  --window-size=800,284 --default-background-color=FFFFFFFF \
  --screenshot=concept-3.png "file:///abs/path/to/wrapper.html"
```

where the wrapper HTML embeds `<img src="concept-3.svg">` sized to the lockup's
aspect ratio. Any SVG rasterizer produces equivalent output.
