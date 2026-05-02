# React Best Practices Skill

`react-best-practices` is a bundled CoWork OS skill for React and Next.js implementation work.

It is designed for:

- React component changes
- Next.js page and route work
- new React or Next.js features
- UI enhancements in an existing React workspace
- React and Next.js refactors
- code review for rendering, data fetching, bundle size, and performance risk
- targeted performance improvements

It is not the right tool for:

- React Native or Expo work; use `react-native-skills`
- purely visual design direction with no React implementation concern
- backend-only tasks
- high-level product planning with no code changes

## What The Skill Does

The bundled skill brings Vercel's React and Next.js performance guidance into CoWork's normal skill runtime.

It focuses on:

- eliminating async waterfalls
- reducing bundle size
- improving server-side performance
- improving client-side data fetching
- reducing avoidable re-renders
- improving rendering and JavaScript hot paths

For normal tasks, the runtime prompt stays concise and points to the detailed rule files only when needed. The full rule set remains available in the bundled skill folder for deeper reviews.

## How To Use It

`react-best-practices` is built in. There is nothing to install from the Skill Store.

The easiest way to use it is to ask naturally:

```text
Add a new settings panel to this React app and keep the component changes performant.
```

```text
Refactor this Next.js page to remove data-fetching waterfalls.
```

```text
Review these React component changes for re-render and bundle-size issues.
```

```text
Enhance the composer UI in this React workspace without disturbing unrelated edits.
```

Good requests usually include:

- the target component, route, or feature
- whether the app is React, Next.js, or mixed
- any known performance concern
- the validation command you expect, if the repo has a preferred one

## Invocation Model

`react-best-practices` follows CoWork's additive skill runtime.

- The original task stays canonical.
- The skill adds React and Next.js implementation guidance.
- The skill does not replace the user's request with a synthetic task.

For React work in a dirty workspace, the skill tells the agent to inspect the worktree first, announce that it is using the React best-practices guidance, keep edits narrow, and avoid reverting unrelated user changes.

See [Skills Runtime Model](../skills-runtime-model.md).

## Guidance Layout

Bundled skill files:

- `resources/skills/react-best-practices.json`
- `resources/skills/react-best-practices/SKILL.md`
- `resources/skills/react-best-practices/AGENTS.md`
- `resources/skills/react-best-practices/rules/*.md`

The concise runtime manifest points to:

- `SKILL.md` for the quick rule index
- `rules/*.md` for focused rule examples
- `AGENTS.md` for the full compiled guide

## Rule Categories

The skill prioritizes high-impact categories first:

1. Eliminating waterfalls
2. Bundle size optimization
3. Server-side performance
4. Client-side data fetching
5. Re-render optimization
6. Rendering performance
7. JavaScript performance
8. Advanced patterns

## Development Notes

When editing the bundled skill itself, run:

```bash
npm run skills:check:core
npm run skills:eval-routing
npm run skills:check
```

For React implementation changes that use this skill, run the narrowest relevant project validation, such as the target test, type-check, lint, or build command for the changed workspace.

## Related Features And Skills

- [Features](../features.md): product-wide runtime and skills overview
- [Skill Store & External Skills](../skill-store-and-external-skills.md): explains why this one is bundled and available immediately
- [Skills Runtime Model](../skills-runtime-model.md): explains additive skill application
- `react-native-skills`: for React Native and Expo work
- `taste-skill`: for more opinionated visual frontend design passes
- `frontend-design`: for production frontend design and build work
