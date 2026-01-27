# Claude Code Instructions

## Release Policy

**DO NOT** create new releases, tags, or version bumps unless explicitly instructed by the user. This includes:
- Creating git tags
- Running `gh release create`
- Bumping version in `package.json`
- Pushing tags to origin

Wait for explicit user approval before releasing.

## Project Overview

CoWork-OSS is an Electron-based agentic task automation app for macOS.

### Key Directories
- `src/electron/` - Main process (Node.js/Electron)
- `src/renderer/` - React UI components
- `src/shared/` - Shared types between main and renderer

### Commands
- `npm run dev` - Start development server
- `npm run build` - Production build
- `npm run type-check` - TypeScript validation

### Skills
Custom skills are stored in `~/Library/Application Support/cowork-oss/skills/` as JSON files.
