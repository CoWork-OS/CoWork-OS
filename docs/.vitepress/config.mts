import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'CoWork OS',
  description: 'CoWork OS is a local-first, security-hardened desktop and CLI runtime for operating AI agents in production.',
  base: '/CoWork-OS/',

  ignoreDeadLinks: true,

  head: [
    ['meta', { name: 'theme-color', content: '#646cff' }],
    ['meta', { name: 'description', content: 'CoWork OS helps teams run local-first AI workflows from desktop and CLI surfaces with approvals, guardrails, and multi-channel operations.' }],
    ['meta', { name: 'keywords', content: 'local-first AI agent OS, AI CLI, approvals, guardrails, production AI workflows' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'CLI', link: '/cli' },
      { text: 'Platform Updates', link: '/integration-skill-bootstrap-lifecycle' },
      { text: 'Release Notes', link: '/release-notes-0.5.49' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Security', link: '/security/' },
      { text: 'GitHub', link: 'https://github.com/CoWork-OS/CoWork-OS' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'CoWork CLI', link: '/cli' },
          { text: "Beginner's Guide", link: '/cowork-school' },
          { text: 'Platform Updates', link: '/integration-skill-bootstrap-lifecycle' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture' },
          { text: 'Reliability Flywheel', link: '/reliability-flywheel' },
          { text: 'Runtime Visibility', link: '/operator-runtime-visibility' },
          { text: 'CoWork CLI', link: '/cli' },
          { text: 'Terminal Tabs', link: '/terminal-tabs' },
          { text: 'Computer Use (macOS)', link: '/computer-use' },
          { text: 'Live Canvas', link: '/live-canvas' },
          { text: 'Agent Teams', link: '/agent-teams-contract' },
          { text: 'Enterprise Connectors', link: '/enterprise-connectors' },
          { text: 'Secure MCP Tunnels', link: '/secure-mcp-tunnels' },
          { text: 'Integration + Skill Lifecycle', link: '/integration-skill-bootstrap-lifecycle' },
          { text: 'Node Daemon', link: '/node-daemon' },
          { text: 'Placeholder Engine', link: '/placeholder-engine' },
          { text: 'Context Compaction', link: '/context-compaction' },
        ],
      },
      {
        text: 'Deployment',
        items: [
          { text: 'Self-Hosting', link: '/self-hosting' },
          { text: 'VPS / Linux', link: '/vps-linux' },
          { text: 'Remote Access', link: '/remote-access' },
          { text: 'Secure MCP Tunnels', link: '/secure-mcp-tunnels' },
          { text: 'Windows npm Smoke Test', link: '/windows-npm-smoke-test' },
        ],
      },
      {
        text: 'Security',
        items: [
          { text: 'Security Overview', link: '/security/' },
          { text: 'Security Model', link: '/security/security-model' },
          { text: 'Trust Boundaries', link: '/security/trust-boundaries' },
          { text: 'Best Practices', link: '/security/best-practices' },
          { text: 'Configuration Guide', link: '/security/configuration-guide' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Channel Integrations', link: '/channels' },
          { text: 'Channel Comparison', link: '/channel-comparison' },
          { text: 'Composer Mentions', link: '/composer-mentions' },
          { text: 'CoWork CLI', link: '/cli' },
          { text: 'Side Chat', link: '/side-chat' },
          { text: 'Terminal Tabs', link: '/terminal-tabs' },
          { text: 'Inbox Agent', link: '/inbox-agent' },
          { text: 'Skill Store & External Skills', link: '/skill-store-and-external-skills' },
          { text: 'manim-video skill', link: '/skills/manim-video' },
          { text: 'Architecture Design skill', link: '/skills/architecture-design' },
          { text: 'Release Notes 0.5.49', link: '/release-notes-0.5.49' },
          { text: 'Release Notes 0.5.48', link: '/release-notes-0.5.48' },
          { text: 'Release Notes 0.5.47', link: '/release-notes-0.5.47' },
          { text: 'Release Notes 0.5.45', link: '/release-notes-0.5.45' },
          { text: 'Release Notes 0.5.44', link: '/release-notes-0.5.44' },
          { text: 'Release Notes 0.5.43', link: '/release-notes-0.5.43' },
          { text: 'Release Notes 0.5.42', link: '/release-notes-0.5.42' },
          { text: 'Release Notes 0.5.41', link: '/release-notes-0.5.41' },
          { text: 'Release Notes 0.5.40', link: '/release-notes-0.5.40' },
          { text: 'Release Notes 0.5.35', link: '/release-notes-0.5.35' },
          { text: 'Release Notes 0.5.34', link: '/release-notes-0.5.34' },
          { text: 'Release Notes 0.5.23', link: '/release-notes-0.5.23' },
          { text: 'Release Notes 0.5.22', link: '/release-notes-0.5.22' },
          { text: 'Release Notes 0.5.21', link: '/release-notes-0.5.21' },
          { text: 'Release Notes 0.5.19', link: '/release-notes-0.5.19' },
          { text: 'Release Notes 0.5.17', link: '/release-notes-0.5.17' },
          { text: 'Release Notes 0.5.16', link: '/release-notes-0.5.16' },
          { text: 'Release Notes 0.5.15', link: '/release-notes-0.5.15' },
          { text: 'Release Notes 0.5.14', link: '/release-notes-0.5.14' },
          { text: 'Release Notes 0.5.13', link: '/release-notes-0.5.13' },
          { text: 'Release Notes 0.5.12', link: '/release-notes-0.5.12' },
          { text: 'Release Notes 0.5.11', link: '/release-notes-0.5.11' },
          { text: 'aurl skill (OpenAPI/GraphQL)', link: '/skills/aurl' },
          { text: 'Use Cases', link: '/use-cases' },
          { text: 'Simplify & Batch', link: '/simplify-batch' },
          { text: 'Contributing', link: '/contributing' },
          { text: 'Changelog', link: '/changelog' },
          { text: 'Project Status', link: '/project-status' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/CoWork-OS/CoWork-OS' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright CoWork OS Contributors',
    },
  },
});
