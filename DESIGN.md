---
name: Docket
description: Café pre-ordering where every screen is a thermal-paper docket laid on a steel-lavender counter.
colors:
  counter: "#CDD3DC"
  counter-night: "#0E1013"
  counter-text: "#14161B"
  counter-text-night: "#ECEDEF"
  counter-sub: "#4A505C"
  counter-sub-night: "#A3A9B5"
  paper: "#FBFBF8"
  ink: "#14161B"
  ink-sub: "#565C69"
  accent-default: "#2B39F0"
  stamp-red: "#C42F17"
  stamp-amber: "#8F5200"
  stamp-green: "#0F6B37"
typography:
  display:
    fontFamily: "Doto, Chivo Mono, ui-monospace, monospace"
    fontSize: "44px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.01em"
  headline:
    fontFamily: "Doto, Chivo Mono, ui-monospace, monospace"
    fontSize: "30px"
    fontWeight: 900
    lineHeight: 1.05
  numeral:
    fontFamily: "Doto, Chivo Mono, ui-monospace, monospace"
    fontSize: "64px"
    fontWeight: 900
    lineHeight: 1
  title:
    fontFamily: "Chivo Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "Chivo Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Chivo Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.16em"
rounded:
  badge: "4px"
  chip: "8px"
  logo: "10px"
  button: "12px"
  sheet: "16px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "22px"
components:
  button-primary:
    backgroundColor: "{colors.accent-default}"
    textColor: "#FFFFFF"
    rounded: "{rounded.button}"
    padding: "16px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.counter-text}"
    rounded: "{rounded.button}"
    padding: "16px"
  button-refund:
    backgroundColor: "transparent"
    textColor: "{colors.stamp-red}"
    rounded: "{rounded.button}"
    padding: "16px"
  docket:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  docket-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "12px 16px"
    height: "52px"
  chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
    padding: "9px 14px"
  chip-on:
    backgroundColor: "{colors.accent-default}"
    textColor: "#FFFFFF"
  badge:
    textColor: "{colors.ink-sub}"
    rounded: "{rounded.badge}"
    padding: "2px 8px"
  stamp:
    textColor: "{colors.stamp-red}"
    rounded: "6px"
    padding: "6px 14px"
    typography: "{typography.headline}"
  sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "8px 18px"
---

# Design System: Docket

## Overview

**Creative North Star: "The Spiked Docket"**

Every piece of content is the slip a café already prints and spikes: light thermal paper laid on a cool steel-lavender counter. The category default (white grouped iOS cards, blue accent, system font) is not used. Paper is the object, so it stays light in dark mode; only the counter goes near-black.

The system is monospaced and tactile. Chivo Mono carries all text; Doto, a dot-matrix face, carries wordmark, headings, order numbers and stamps. Structure comes from dashed rules, dot-leader prices, sawtooth torn edges and a double-line total, not from boxes and shadows. The café's own colour prints as the pre-printed header band and button fill; stamp red, amber and green are reserved for order state. The kitchen view uses the same dockets, scaled up (24px item lines, 40px order numbers) for reading at two metres.

**Key Characteristics:**
- Light paper on a mid-tone counter; paper does not invert in dark mode.
- One typeface family pair, Doto for display and numerals only, Chivo Mono for everything else.
- Dashed hairlines divide; dotted leaders connect name to price.
- Café colour is a runtime variable (`--accent`) with automatic WCAG-based text colour.
- Motion is stepped, like a printer: the docket prints in, the stamp thunks.

## Colors

A cool, desaturated steel-lavender counter, near-white warm paper, blue-black ink, and three stamp inks.

### Primary
- **Café Accent / Default Cobalt** (`accent-default`, #2B39F0): the platform fallback. In a café's menu it is replaced at runtime by the café's brand colour (`--accent`), and `--on-accent` flips between white and ink (#14161B) to clear 4.5:1. Used for primary button fill, selected chips, the hero band, text selection, focus ring, caret.

### Secondary (state inks)
- **Stamp Red** (`stamp-red`, #C42F17): pending/new orders, refund and destructive actions, errors, favourite heart.
- **Stamp Amber** (`stamp-amber`, #8F5200): accepted/preparing, warning badges.
- **Stamp Green** (`stamp-green`, #0F6B37): ready/completed, OK badges, switch on.

### Neutral
- **Counter** (`counter`, #CDD3DC; night `counter-night` #0E1013): page ground behind dockets and bars.
- **Counter Text** (`counter-text`, #14161B; night #ECEDEF) and **Counter Sub** (`counter-sub`, #4A505C; night #A3A9B5): text set directly on the counter.
- **Docket Paper** (`paper`, #FBFBF8): all docket, sheet, and chip surfaces.
- **Ink** (`ink`, #14161B) and **Ink Sub** (`ink-sub`, #565C69): text on paper. Rules are ink at 40% alpha; fills are ink at 7%.

### Named Rules
**The Paper-Stays-Light Rule.** Paper and ink do not change in dark mode. Only the counter and its text flip.
**The State-Ink Rule.** Red, amber, green mean order state (and destructive/ok). Never use them as decoration or brand colour.
**The Café-Leads Rule.** Inside a café's menu, brand colour owns the accent slot; do not hard-code the default cobalt into components, always read `--accent` / `--on-accent`.

## Typography

**Display Font:** Doto 900 (with Chivo Mono, ui-monospace)
**Body Font:** Chivo Mono 400/500/700 (with ui-monospace, SF Mono, Menlo)

**Character:** A dot-matrix voice for things the printer "prints" (names, numbers, stamps) over a plain, sturdy monospace for reading. Both self-hosted woff2, `font-display: swap`.

### Hierarchy
- **Display** (Doto 900, 44px, 1): "Docket" wordmark and large screen titles on the counter.
- **Headline** (Doto 900, 30px/34px, 1.05): sheet titles, café name in hero band (34px), stamp text (26px).
- **Numeral** (Doto 900, 64px kitchen/receipt number; 40px on kitchen tickets): order numbers.
- **Title** (Chivo Mono 700, 16px; 20px/24px on kitchen tickets): row names, times, item lines.
- **Body** (Chivo Mono 400, 15px, 1.4): default; secondary text 13px in Ink Sub; form fields 16px.
- **Label** (Chivo Mono 700, 12px, 0.16em, uppercase): section headings flanked by dashed rules; tab labels 11px at 0.08em; nav title 13px at 0.12em.

### Named Rules
**The Dot-Matrix-For-Print Rule.** Doto is for display, numerals and stamps only. Never set running text or form values in it.
**The Leader Rule.** Item name and price are joined by a dotted leader, price in bold.

## Layout

Single column, centered, max 720px with 16px side padding (1120px `wide` variant for the kitchen). Fixed 46px top nav and 54px bottom tab bar, both respecting iOS safe areas, in translucent counter colour with dashed hairline borders. Dockets stack with 22px gaps; rows inside are 52px minimum, 12px/16px padding, 12px gap. The kitchen rail is an auto-fill grid of 280px minimum columns with 22px gutters. Bottom sheets slide up at max 720px, 92% height. The scale in use is 8 / 12 / 16 / 22px; there is no breakpoint-driven redesign, layout flexes via max-width and auto-fill.

## Elevation & Depth

Depth is paper-on-counter. Dockets and banners get a thin 1px contact line plus a soft 10px drop shadow applied as `filter: drop-shadow`, so the sawtooth torn edge casts correctly. Sheets rise over a 55% dark scrim. Everything inside a docket is flat, separated by dashed rules.

### Shadow Vocabulary
- **Docket** (`filter: drop-shadow(0 1px 0 rgba(20,22,27,.12)) drop-shadow(0 10px 12px rgba(20,22,27,.14))`): `.group`, `.ord`, `.banner`.
- **Floating bar** (`box-shadow: 0 10px 24px rgba(0,0,0,.3)`): the fixed basket bar above the tab bar.
- **Toast** (`box-shadow: 0 8px 24px rgba(0,0,0,.35)`): transient message.

### Named Rules
**The Torn-Edge Rule.** Every docket ends in a 14x7px sawtooth in paper colour; sheets and nested groups drop it.

## Shapes

Docket bodies are square-cornered (paper is cut, not rounded); the torn edge is the only decoration on their silhouette. Controls are softly rounded: buttons 12px, logos 10px/12px, chips and steppers 8px, badges 4px, stamps 6px with a 3px double border, sheets 16px on top corners only. Borders are 2px solid for secondary controls, 1.5px for badges, dashed 1px for dividers, 3px double for the total line.

## Components

### Buttons
- **Shape:** 12px radius, full width, 16px padding, 15px bold uppercase, 0.08em tracking.
- **Primary:** café accent fill, `--on-accent` text. Small variant is inline, 9px/16px, 13px.
- **Secondary:** transparent, 2px current-colour border. **Refund / destructive:** transparent, 2px Stamp Red border and text.
- **States:** pressed moves 2px down and scales .99 (120ms); disabled 40% opacity. Focus ring is 3px accent outline, 2px offset, on everything.

### Docket (card)
- Paper background, ink text, square corners, torn bottom edge, docket shadow, 22px bottom margin. Kitchen tickets add a 10px top border in state colour (red flashing in stepped blink for pending, amber accepted, green ready). On first render a docket "prints" in with a stepped clip reveal (0.7s, 14 steps).

### Rows
- Flex row, 52px min height, dashed top border between siblings, pressed state is a 7% ink fill. Chevron is a CSS border arrow. Name with dotted leader, description 13px in Ink Sub clamped to two lines.

### Stamp
- Doto 900 26px uppercase, 3px double border, 6px radius, rotated -5deg, multiply blend, state ink. A fresh state change "thunks" in from 2.2x scale and -14deg over 0.5s after 0.55s.

### Chips, badges
- Chip: paper fill, 8px radius, 14px; selected is accent fill, bold. Badge: 11px bold uppercase outline in current colour, neutral, green (ok) or amber (warn).

### Inputs
- Borderless transparent fields, 16px, 14px/16px padding, dashed rule between stacked fields; label rows right-align the value. Placeholder in Ink Sub. Switch is a 51x31 pill, green when on.

### Bottom Sheet
- Paper, 16px top radius, 40x5 grab handle, content slides up in 350ms with an exponential ease; nested groups lose their shadow and torn edge.

### Navigation
- Top bar: back chevron left, centred 13px uppercase title. Bottom tab bar: three icon + 11px uppercase label tabs, active tab is bold ink with a 28x3 bar on its top edge; inactive in Counter Sub.

### Barcode
- Decorative SVG whose bar widths derive from the order id, 44px tall, in current ink, at the foot of a receipt docket.

## Do's and Don'ts

### Do:
- **Do** build every new surface as paper (#FBFBF8) on the counter, separated by dashed rules.
- **Do** read `--accent`/`--on-accent` for any fill that should carry the café's brand.
- **Do** use Doto 900 only for display, numerals and stamps; Chivo Mono for everything else.
- **Do** keep motion stepped (printer feel) and honour `prefers-reduced-motion`, which disables all animation and transitions.
- **Do** keep touch targets at least 44px (nav buttons) and kitchen text at 24px+ for two-metre reading.
- **Do** use stamp red/amber/green for order state only.

### Don't:
- **Don't** use white rounded grouped-list cards with a blue accent or a system sans; that is the category default this system replaces.
- **Don't** darken the paper in dark mode.
- **Don't** introduce new brand colours; the café supplies the accent, state inks supply meaning.
- **Don't** round docket corners or add borders-plus-shadow boxes; use the torn edge and dashed rules.

### Defects and drift not canonized
The build carries these; they are not rules for future surfaces: an iOS-style pill switch with a white thumb shadow, text glyphs (`♥`, `+`, `−`) used as icons, heavy inline `style=` attributes in app.js and m.js rather than classes, the `.hero .logo` `!important` overrides, glass `backdrop-filter` blur on the nav and tab bars, and the leftover "Install Order Ahead" copy against the Docket name.
