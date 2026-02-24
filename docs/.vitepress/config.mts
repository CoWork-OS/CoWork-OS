import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'CoWork OS',
  description: 'The operating system for personal AI assistants',
  base: '/CoWork-OS/',

  ignoreDeadLinks: true,

  head: [
    ['meta', { name: 'theme-color', content: '#646cff' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
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
          { text: 'Migration Guide', link: '/migration' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture' },
          { text: 'Live Canvas', link: '/live-canvas' },
          { text: 'Agent Teams', link: '/agent-teams-contract' },
          { text: 'Enterprise Connectors', link: '/enterprise-connectors' },
          { text: 'Node Daemon', link: '/node-daemon' },
          { text: 'Placeholder Engine', link: '/placeholder-engine' },
        ],
      },
      {
        text: 'Deployment',
        items: [
          { text: 'Self-Hosting', link: '/self-hosting' },
          { text: 'VPS / Linux', link: '/vps-linux' },
          { text: 'Remote Access', link: '/remote-access' },
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
          { text: 'Use Cases', link: '/use-cases' },
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
