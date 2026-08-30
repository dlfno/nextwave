---
name: Aether AI
colors:
  surface: '#f9f9ff'
  surface-dim: '#d3daea'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f0f3ff'
  surface-container: '#e7eefe'
  surface-container-high: '#e2e8f8'
  surface-container-highest: '#dce2f3'
  on-surface: '#151c27'
  on-surface-variant: '#444748'
  inverse-surface: '#2a313d'
  inverse-on-surface: '#ebf1ff'
  outline: '#747878'
  outline-variant: '#c4c7c7'
  surface-tint: '#5f5e5e'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1c1b1b'
  on-primary-container: '#858383'
  inverse-primary: '#c9c6c5'
  secondary: '#4648d4'
  on-secondary: '#ffffff'
  secondary-container: '#6063ee'
  on-secondary-container: '#fffbff'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#191c1d'
  on-tertiary-container: '#828485'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e5e2e1'
  primary-fixed-dim: '#c9c6c5'
  on-primary-fixed: '#1c1b1b'
  on-primary-fixed-variant: '#474646'
  secondary-fixed: '#e1e0ff'
  secondary-fixed-dim: '#c0c1ff'
  on-secondary-fixed: '#07006c'
  on-secondary-fixed-variant: '#2f2ebe'
  tertiary-fixed: '#e1e3e4'
  tertiary-fixed-dim: '#c5c7c8'
  on-tertiary-fixed: '#191c1d'
  on-tertiary-fixed-variant: '#454748'
  background: '#f9f9ff'
  on-background: '#151c27'
  surface-variant: '#dce2f3'
typography:
  display-lg:
    fontFamily: Geist
    fontSize: 48px
    fontWeight: '600'
    lineHeight: '1.1'
    letterSpacing: -0.04em
  headline-lg:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '500'
    lineHeight: '1.2'
  body-md:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: -0.01em
  body-sm:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label-mono:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1'
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 64px
  max-width-content: 800px
---

## Brand & Style

The design system is rooted in the philosophy of "Intelligent Clarity." It aims to evoke a sense of calm authority and effortless precision, moving away from the chaotic density typical of many SaaS platforms. The target audience is the discerning professional who values speed, accuracy, and aesthetic purity.

The visual style is a fusion of **High-End Minimalism** and **Ethereal Modernism**. It leverages expansive white space (or "breathable space") to reduce cognitive load. Interaction patterns are inspired by the lightness of air; elements should feel like they are floating rather than anchored by heavy physical structures. The emotional response is one of focus—stripping away the noise to let the intelligence of the AI take center stage.

## Colors

The palette is strictly curated to maintain a high-end, gallery-like feel. 

- **Primary:** A deep, absolute black used for primary text and high-action components to ensure maximum legibility and "ink-on-paper" contrast.
- **Secondary (Accent):** A muted, sophisticated violet. This is used sparingly—only for active states, primary call-to-actions, or subtle AI-generation indicators.
- **Neutrals:** A spectrum of soft off-whites and very light grays. These are used for surfaces and structural lines.
- **Execution:** Avoid solid black borders. Use `#E5E7EB` for structural dividers at 0.5px or 1px thickness to keep the interface feeling light.

## Typography

This design system uses **Geist** as its primary typeface for its mathematical precision and neutral, developer-centric aesthetic. **JetBrains Mono** is introduced for labels and technical metadata to lean into the "AI/Tool" nature of the product.

- **Tracking:** Headlines should utilize tight tracking (`-0.02em` to `-0.04em`) to feel cohesive and modern.
- **Line Height:** Body text is set at a generous `1.6` ratio to ensure maximum readability during long AI-generated responses.
- **Scale:** Use dramatic scale shifts. Small, mono-spaced labels paired with large, bold display text create a structured hierarchy without needing boxes or dividers.

## Layout & Spacing

The layout follows a **Fluid Content Model** within a constrained central column. For reading-heavy AI interfaces, content is capped at `800px` to maintain optimal line lengths.

- **Rhythm:** An 8px linear scale is used, but for the "Aether" feel, double the expected padding in message bubbles and containers.
- **Safe Zones:** Sidebars are treated as floating panels with fixed widths (280px), using `24px` of internal padding.
- **Breakpoints:** 
  - **Desktop (1440px+):** Centered content, floating sidebar, `64px` outer margins.
  - **Tablet (768px - 1024px):** Sidebar collapses to an icon-only rail or drawer.
  - **Mobile:** Single column, `16px` margins, bottom-anchored input bar.

## Elevation & Depth

This system rejects heavy shadows in favor of **Tonal Layering** and **Micro-Shadows**.

1.  **Level 0 (Base):** Pure white background (`#FFFFFF`).
2.  **Level 1 (Panels):** Soft off-white (`#F7F7F8`) with a `1px` border in `#E5E7EB`. No shadow.
3.  **Level 2 (Popovers/Modals):** Pure white surface with an extremely diffused, low-opacity shadow: `0px 10px 40px rgba(0, 0, 0, 0.04)`.
4.  **AI Glass:** For AI-specific components (like a floating action bar), use a backdrop blur of `12px` and a semi-transparent white background (`rgba(255, 255, 255, 0.8)`).

## Shapes

The shape language is "Soft-Modern." We use a consistent `0.5rem` (8px) radius for standard containers to balance the sharpness of the Geist typeface.

- **Input Bars:** Use a higher roundedness (up to `12px` or `rounded-xl`) to distinguish the primary interaction point from content cards.
- **Buttons:** Small buttons use `6px`, while primary action buttons use `8px`.
- **Selection States:** Hover states on list items should use a `4px` radius to feel precise.

## Components

- **Input Bar:** The central "command" component. It should be a floating white pill with a 1px soft border. Text should be `body-md`. Icons should be thin-stroke (1.5px) and monochrome.
- **Message Bubbles:** Do not use high-contrast backgrounds for user vs. AI. Instead, use a subtle off-white for user messages and a pure white (no container, just typography) for the AI, separated by ample vertical whitespace.
- **Buttons:** 
  - *Primary:* Solid black background, white text, no border. 
  - *Secondary:* Ghost style, 1px border (`#E5E7EB`), black text.
- **Chips:** Small, uppercase `label-mono` text inside a light gray capsule. Use these for AI tags, model versions, or status indicators.
- **Sidebar:** Minimalist rail. Use `label-mono` for section headers and `body-sm` for navigation items. Active states are indicated by a subtle `2px` vertical line or a slight weight change in text, rather than a background fill.
- **Progress Indicators:** A thin, high-contrast bar (the accent violet) that crawls across the top of the content area during AI generation—avoid bulky "loading" spinners.