# Changelog

All notable changes to CoWork-OSS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2025-01-25

### Added
- **Real Office Format Support** - Documents now create actual Office files instead of text placeholders
  - Excel (.xlsx) files with `exceljs` - multiple sheets, auto-fit columns, header formatting, filters, frozen rows
  - Word (.docx) files with `docx` - headings, paragraphs, lists, tables, code blocks with proper styling
  - PDF files with `pdfkit` - professional document generation with custom fonts and margins
  - PowerPoint (.pptx) files with `pptxgenjs` - multiple slide layouts (title, content, two-column, image), speaker notes, themes
- Spreadsheet read capability for existing Excel files
- Fallback to CSV/Markdown when those extensions are explicitly requested

### Changed
- SpreadsheetBuilder now creates real Excel workbooks with formatting
- DocumentBuilder supports Word, PDF, and Markdown output formats
- PresentationBuilder creates professional PowerPoint presentations with layouts

## [0.1.3] - 2025-01-25

### Added
- CLI/ASCII terminal-style UI throughout the application
- Model selection dropdown (Opus 4.5, Sonnet 4.5, Haiku 4.5)
- AWS Bedrock support as alternative to Anthropic API
- Telegram bot integration with full command support
- Web search integration (Tavily, Brave, SerpAPI, Google)
- Ollama support for local LLM inference

### Changed
- Updated branding to CoWork-OSS
- Improved workspace selector with terminal aesthetic

## [0.1.0] - 2025-01-24

### Added

#### Core Features
- Task-based workflow with multi-step execution
- Plan-execute-observe loop for agent orchestration
- Real-time task timeline with live activity feed
- Workspace management with folder selection

#### Agent Capabilities
- File operation tools (read, write, list, rename, delete)
- Built-in skills:
  - Spreadsheet creation (Excel format)
  - Document creation (Word/PDF)
  - Presentation creation (PowerPoint)
  - Folder organization

#### Security & Permissions
- Sandboxed file operations within selected workspace
- Permission system for destructive operations
- Approval dialogs for file deletion and bulk operations
- Path traversal protection

#### LLM Integration
- Anthropic Claude API support
- AWS Bedrock support
- Multiple model selection (Opus, Sonnet, Haiku)
- Settings UI for API configuration

#### User Interface
- Electron desktop application for macOS
- React-based UI with dark theme
- CLI/ASCII terminal aesthetic
- Task list with status indicators
- System monitor panel (progress, files, context)

#### Data Management
- SQLite local database
- Task and event persistence
- Workspace history
- Artifact tracking

### Technical
- Electron 40 with React 19
- TypeScript throughout
- Vite for fast development
- electron-builder for packaging

## [0.0.1] - 2025-01-20

### Added
- Initial project setup
- Basic Electron app shell
- Database schema design
- IPC communication layer

---

## Version History Summary

| Version | Date | Highlights |
|---------|------|------------|
| 0.1.4 | 2025-01-25 | Real Office format support (Excel, Word, PDF, PowerPoint) |
| 0.1.3 | 2025-01-25 | Telegram bot, web search, Ollama support |
| 0.1.0 | 2025-01-24 | First public release with core features |
| 0.0.1 | 2025-01-20 | Initial development setup |

[Unreleased]: https://github.com/mesutfelat/cowork-oss/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/mesutfelat/cowork-oss/releases/tag/v0.1.4
[0.1.3]: https://github.com/mesutfelat/cowork-oss/releases/tag/v0.1.3
[0.1.0]: https://github.com/mesutfelat/cowork-oss/releases/tag/v0.1.0
[0.0.1]: https://github.com/mesutfelat/cowork-oss/releases/tag/v0.0.1
