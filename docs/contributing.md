# Contributing to CoWork OS

Thank you for your interest in contributing to CoWork OS! This document provides guidelines and instructions for contributing.

> **Note:** This entire codebase was AI-generated using Claude Code and OpenAI Codex — no code was written manually. You may encounter AI-typical patterns, inconsistencies, or areas that could use refactoring. Fresh eyes and improvements are very welcome!

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) to keep our community approachable and respectable.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Set up the development environment (see below)
4. Create a new branch for your feature/fix
5. Make your changes
6. Submit a pull request

## Development Setup

### Prerequisites

- Node.js 24 or higher
- npm 9 or higher
- macOS or Windows (for Electron desktop features)
- Git

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/CoWork-OS.git
cd CoWork-OS

# Install dependencies and set up native modules
npm run setup

# Copy environment example
cp .env.example .env
# Edit .env and add your API keys

# Start development server
npm run dev
```

### Available Scripts

- `npm run dev` - Start development mode with hot reload
- `npm run build` - Build for production
- `npm run package` - Package the Electron app
- `npm run lint` - Run ESLint
- `npm run type-check` - Run TypeScript type checking
- `npm test` - Run tests

## Releasing (Maintainers Only)

CoWork OS is published to npm for easy global installation. To release a new version:

### Release Workflow

```bash
# 1. Ensure all changes are committed and tests pass
npm test
npm run type-check

# 2. Bump version (choose one)
npm version patch   # 0.3.10 → 0.3.11 (bug fixes)
npm version minor   # 0.3.10 → 0.4.0  (new features)
npm version major   # 0.3.10 → 1.0.0  (breaking changes)

# 3. Publish to npm
npm publish

# 4. Push version commit and tag to GitHub
git push && git push --tags
```

### Version Guidelines

- **Patch** (0.0.x): Bug fixes, minor improvements
- **Minor** (0.x.0): New features, non-breaking changes
- **Major** (x.0.0): Breaking changes, major rewrites

### Pre-release Checklist

- [ ] All tests passing
- [ ] Type checking passes
- [ ] CHANGELOG.md updated
- [ ] README.md reflects any new features
- [ ] No sensitive data in committed files

## How to Contribute

### AI-Assisted PRs Welcome!

Built with Claude Code, Codex, Cursor, or other AI tools? **Awesome — we embrace it!**

This entire codebase was AI-generated, so AI-assisted contributions are first-class citizens here. Just be transparent:

- [ ] Mark as AI-assisted in your PR title or description
- [ ] Note your testing level (untested / lightly tested / fully tested)
- [ ] Confirm you understand what the code does
- [ ] Include prompts or session logs if helpful for reviewers

We just want transparency so reviewers know what to look for. Don't be shy about using AI — it's how this project was built!

### Reporting Bugs

Before creating a bug report, please check existing issues to avoid duplicates.

When filing a bug report, include:
- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior vs actual behavior
- Your environment (OS version, Node version, etc.)
- Screenshots if applicable
- Any relevant logs or error messages

### Suggesting Features

Feature suggestions are welcome! Please:
- Check existing issues/discussions first
- Provide a clear use case
- Explain why this feature would be useful
- Consider the scope and implementation complexity

### Code Contributions

Areas where help is especially needed:
- VM sandbox implementation using macOS Virtualization.framework
- Additional MCP server integrations
- Enhanced document creation (proper Excel/Word/PowerPoint libraries)
- Network security controls
- Sub-agent coordination
- Test coverage
- Documentation improvements

## Pull Request Process

1. **Create a branch** from `main` with a descriptive name:
   - `feature/add-new-skill`
   - `fix/file-permission-issue`
   - `docs/update-readme`

2. **Make your changes** following our coding standards

3. **Test your changes** thoroughly

4. **Update documentation** if needed

5. **Submit a PR** with:
   - Clear title and description
   - Reference to related issues
   - Screenshots for UI changes
   - List of changes made

6. **Address review feedback** promptly

### PR Requirements

- [ ] Code follows the project's style guidelines
- [ ] All existing tests pass
- [ ] New code includes appropriate tests (when applicable)
- [ ] Documentation has been updated
- [ ] Commit messages follow conventions
- [ ] No sensitive data (API keys, credentials) included

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Prefer `const` over `let`
- Use meaningful variable and function names
- Add type annotations for function parameters and return types
- Avoid `any` type when possible

### React

- Use functional components with hooks
- Keep components small and focused
- Use descriptive prop names
- Handle loading and error states

### File Organization

```
src/
├── electron/          # Main process code
│   ├── agent/         # Agent orchestration
│   │   ├── llm/       # LLM provider abstraction
│   │   ├── search/    # Web search providers
│   │   ├── tools/     # Tool implementations
│   │   └── skills/    # Document creation skills
│   ├── database/      # SQLite operations
│   ├── mcp/           # Model Context Protocol
│   │   ├── client/    # MCP client (connect to servers)
│   │   ├── host/      # MCP host (expose tools)
│   │   └── registry/  # MCP server registry
│   └── ipc/           # IPC handlers
├── renderer/          # React UI
│   ├── components/    # React components
│   └── styles/        # CSS files
└── shared/            # Shared types and utilities
```

### CSS

- Use CSS custom properties (variables) for theming
- Follow BEM-like naming conventions
- Keep styles scoped to components

## Commit Messages

Follow conventional commits format:

```
type(scope): description

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(agent): add support for parallel tool execution

fix(ui): resolve task list scrolling issue on long lists

docs(readme): update installation instructions for M1 Macs
```

## Questions?

Feel free to:
- Open a [Discussion](https://github.com/CoWork-OS/CoWork-OS/discussions) for questions
- Tag maintainers in issues for guidance

Thank you for contributing to CoWork OS!
