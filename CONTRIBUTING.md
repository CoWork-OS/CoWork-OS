# Contributing to CoWork-OSS

Thank you for your interest in contributing to CoWork-OSS! This document provides guidelines and instructions for contributing.

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

- Node.js 18 or higher
- npm 9 or higher
- macOS (for Electron native features)
- Git

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/cowork-oss.git
cd cowork-oss

# Install dependencies
npm install

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

## How to Contribute

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
- Additional MCP server integrations and transport types (SSE, WebSocket)
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
- Open a [Discussion](https://github.com/mesutfelat/cowork-oss/discussions) for questions
- Reach out on X/Twitter: [@MesutGenAI](https://x.com/MesutGenAI)
- Tag maintainers in issues for guidance

Thank you for contributing to CoWork-OSS!
