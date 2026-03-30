import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'CoWork OS',
  description: 'CoWork OS is a local-first, security-hardened runtime for operating AI agents in production.',
  base: '/CoWork-OS/',

  ignoreDeadLinks: true,

  head: [
    ['meta', { name: 'theme-color', content: '#646cff' }],
    ['meta', { name: 'description', content: 'CoWork OS helps teams run local-first AI workflows with approvals, guardrails, and multi-channel operations.' }],
    ['meta', { name: 'keywords', content: 'local-first AI agent OS, approvals, guardrails, production AI workflows' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Platform Updates', link: '/integration-skill-bootstrap-lifecycle' },
      { text: 'Release Notes', link: '/release-notes-0.5.16' },
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
          { text: 'Platform Updates', link: '/integration-skill-bootstrap-lifecycle' },
          { text: 'Migration Guide', link: '/migration' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture' },
          { text: 'Reliability Flywheel', link: '/reliability-flywheel' },
          { text: 'Runtime Visibility', link: '/operator-runtime-visibility' },
          { text: 'Live Canvas', link: '/live-canvas' },
          { text: 'Agent Teams', link: '/agent-teams-contract' },
          { text: 'Enterprise Connectors', link: '/enterprise-connectors' },
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
          { text: 'Inbox Agent', link: '/inbox-agent' },
          { text: 'Skill Store & External Skills', link: '/skill-store-and-external-skills' },
          { text: 'Release Notes 0.5.16', link: '/release-notes-0.5.16' },
          { text: 'Release Notes 0.5.15', link: '/release-notes-0.5.15' },
          { text: 'Release Notes 0.5.14', link: '/release-notes-0.5.14' },
          { text: 'Release Notes 0.5.13', link: '/release-notes-0.5.13' },
          { text: 'Release Notes 0.5.12', link: '/release-notes-0.5.12' },
          { text: 'Release Notes 0.5.11', link: '/release-notes-0.5.11' },
          { text: 'aurl skill (OpenAPI/GraphQL)', link: '/skills/aurl' },
          { text: 'Use Cases', link: '/use-cases' },
          { text: 'Simplify & Batch', link: '/simplify-batch' },
          { text: 'GTM Strategy', link: '/gtm-strategy' },
          { text: 'Competitive Landscape', link: '/competitive-landscape-research' },
          { text: 'OpenClaw vs Hermes vs CoWork OS', link: '/openclaw-hermes-cowork-comparison' },
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
