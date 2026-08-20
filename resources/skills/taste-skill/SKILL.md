---
name: taste-skill
description: High-agency frontend design system for distinctive premium UI with anti-slop layout, motion, typography, and engineering rules.
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
  source-author: "Leonxlnx"
---

# Taste Skill

Use this skill when you need a strong frontend point of view, not a safe default.

The goal is not "pretty enough." The goal is a frontend that feels intentional, premium, and hard to confuse with generic LLM output.

## 1. Active Baseline Configuration

- `DESIGN_VARIANCE: 8`
  `1 = symmetric and quiet`, `10 = asymmetric and experimental`
- `MOTION_INTENSITY: 6`
  `1 = nearly static`, `10 = cinematic and highly reactive`
- `VISUAL_DENSITY: 4`
  `1 = airy gallery`, `10 = dense cockpit`

Treat these as working dials, not fixed constants.

- Do not ask the user to edit this file.
- Adapt the dials to the brief. If the user wants calmer output, lower them. If the user wants bolder output, raise them.
- Use the dials to drive layout, animation, spacing, and card usage.

## 2. Required Working Model

Before coding, establish three things:

1. Visual thesis
   One sentence for mood, material, and energy.
2. Layout thesis
   What makes the page memorable: asymmetry, crop, white space, stacked motion, split hero, bento rhythm, etc.
3. Interaction thesis
   Two or three motions that materially change the feel of the interface.

Then implement real code. Do not stop at design commentary.

- Do not leave "TODO: add animation here" style placeholders.
- Do not output fake code snippets for components that are supposed to be shipped.
- Do not ask for permission to make obvious design decisions once the brief is clear.

## 3. Architecture and Dependency Rules

Unless the user explicitly asks for something else, prefer React or Next.js.

### Dependency verification

Before importing any third-party package:

- check `package.json`
- if the package is missing, state the exact install command before using it
- never assume `framer-motion`, `lucide-react`, `zustand`, or any font package is already installed

### React and Next.js rules

- Default to server-safe structure in Next.js.
- Keep global state out of server components.
- If motion or highly interactive behavior is required, isolate it in a focused client component.
- Do not spread animation logic across an entire tree when one leaf component can own it.

### Styling rules

- Use Tailwind for most styling unless the project clearly uses something else.
- Check whether the project is Tailwind v3 or v4 before writing config-sensitive code.
- Do not use v4 patterns in a v3 project.

### Icon rules

- Prefer `@phosphor-icons/react` or `@radix-ui/react-icons` when the project supports them.
- Keep icon stroke weight consistent across the page.

### Hard bans

- No emojis in code, markup, UI copy, or alt text.
- No `h-screen` heroes on mobile-sensitive layouts. Use `min-h-[100dvh]`.
- No flexbox percentage math when grid solves the layout more cleanly.

## 4. Design Engineering Directives

LLMs drift toward familiar, overused UI patterns. Correct for that proactively.

### Typography

- Default headline energy: large, tight, decisive.
- Avoid generic font stacks like Inter, Arial, Roboto, and raw system defaults when the brief calls for premium or creative work.
- Favor distinctive but disciplined display fonts such as Geist, Outfit, Cabinet Grotesk, or Satoshi.
- For dashboards and software UI, serif display choices are banned.
- Pair a strong display face with a quieter supporting face or mono.

### Color

- Use a restrained neutral base plus one main accent.
- Keep accent saturation controlled.
- Avoid the default AI purple/blue glow aesthetic.
- Do not mix warm and cool gray systems randomly.

### Layout

If `DESIGN_VARIANCE > 4`:

- do not center the entire hero by default
- avoid "headline + two buttons + card grid" as the first screen
- prefer split-screen, offset content, asymmetric negative space, anchored media, or broken-grid composition

### Surfaces and cards

- Cards are not the default.
- Use cards only when elevation communicates hierarchy or interaction.
- For denser dashboards, prefer dividers, border rhythms, and spacing over endless card mosaics.
- If removing a card keeps the meaning intact, remove it.

### Forms and states

Every serious surface needs full interaction coverage:

- loading state
- empty state
- error state
- success state
- tactile active state

For forms:

- label above input
- helper text optional but useful
- error text below input
- consistent vertical spacing

## 5. Motion System

Motion should create presence and hierarchy, not noise.

If `MOTION_INTENSITY <= 3`:

- limit motion to entrance, hover, and small affordance shifts

If `MOTION_INTENSITY > 5`:

- add continuous micro-interactions
- stagger reveals
- use spring-based motion
- make at least one interaction feel physically responsive

### Preferred motion patterns

- staggered entrances
- layout transitions
- hover-aware buttons
- scroll-linked depth shifts
- type or shimmer loops for active interfaces
- floating or breathing status details

### Magnetic interaction rule

If you build cursor-reactive magnetic behavior:

- do not use React `useState` for per-frame cursor updates
- prefer motion values or equivalent render-loop-safe primitives

### Motion quality bar

- no linear-by-default motion
- no gratuitous infinite animation without purpose
- no animation that only decorates and does not improve rhythm, focus, or affordance

## 6. Materiality and Visual Texture

When the design calls for glass or translucent layers:

- go beyond raw `backdrop-blur`
- add a subtle inner border
- add a restrained inner highlight or inset shadow

Use atmosphere intentionally:

- gradient meshes
- noise overlays
- soft vignettes
- layered transparency
- controlled shadows

But:

- keep grain and noise on fixed overlays, not scrolling containers
- do not turn every section into a special effect

## 7. Performance Guardrails

Premium UI that performs badly is still bad UI.

- Animate `transform` and `opacity`, not `top`, `left`, `width`, or `height`.
- Keep expensive effects off large scrolling surfaces.
- Avoid z-index spam.
- Memoize perpetual motion islands when needed.
- If using GSAP or Three.js for a special scene, isolate it. Do not mix heavy motion systems in the same component tree casually.

## 8. Pattern Library

Reach for a small number of stronger ideas instead of many weak ones.

### Good first-view patterns

- split hero with anchored text and one dominant media plane
- asymmetrical bento section with varied tile weights
- editorial landing page with oversized type and sparse support copy
- product UI with calm structure, almost no decorative chrome, and a single strong accent

### Good motion ideas

- sticky stack
- hover-aware directional fill
- shimmer skeletons that match final geometry
- typewriter or command-input loop
- coverflow or horizontal stream with clear narrative purpose
- floating toolbar or shared element transition

### Patterns to avoid by default

- centered SaaS hero with floating dashboard mockup
- stat strip under every hero
- logo cloud as filler
- purple gradient on white
- card grid as the answer to every section
- random mixed font personalities

## 9. Delivery Standards

When using this skill, the implementation should leave the user with:

- real working code
- a clear visual thesis
- consistent motion language
- responsive behavior that survives desktop and mobile
- dependency calls called out if packages are missing

Do not:

- narrate the taste system instead of applying it
- fall back to generic component-library defaults
- leave unfinished sections because the "main idea" is done

## 10. Pre-flight Checklist

Before finalizing, check the result against this list:

- Is there one clear visual idea in the first viewport?
- Does the typography feel chosen rather than defaulted?
- Is the accent palette disciplined?
- Would this still look deliberate if all shadows were removed?
- Are cards being used because they are necessary, not because they are easy?
- Are motion choices noticeable but controlled?
- Are loading, empty, error, and active states covered where relevant?
- Is mobile stability handled, especially viewport height and overflow?
- Did you verify external dependencies before importing them?
- Does the output feel like a designed interface rather than assembled components?
