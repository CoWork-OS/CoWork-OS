# Claude Code Instructions

## Release Policy

**DO NOT** create new releases, tags, or version bumps unless explicitly instructed by the user. This includes:
- Creating git tags
- Running `gh release create`
- Bumping version in `package.json`
- Pushing tags to origin
- Running `npm publish`

Wait for explicit user approval before releasing.

## npm Publishing Reminder

CoWork-OSS is published on npm (`npm install -g cowork-oss`). When the user creates a new release:

1. **Remind them** to also publish to npm after pushing to GitHub
2. **Release workflow**:
   ```bash
   npm version patch|minor|major  # Bump version
   npm publish                     # Publish to npm
   git push && git push --tags    # Push to GitHub
   ```
3. **Version must be valid semver** (3 parts only: MAJOR.MINOR.PATCH)

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
