// Single source of truth for branding and URLs. Plain .mjs so build scripts,
// the Astro config, and pages all read the same values.
//
// SITE_URL and BASE_PATH override siteUrl and basePath at build time. Use
// BASE_PATH=/ for a custom domain at the root.

export const site = {
  name: 'AI Collab',
  tagline: 'Phone chat and live activity for your coding agents.',
  description:
    'Phone chat, approvals, and live activity for Claude Code, Codex, Cursor, and OpenCode agents over a private, self-hosted ntfy server.',
  repoUrl: 'https://github.com/bcmyguest/ai-collab',
  /** Branch that source links in the docs point at. */
  branch: 'main',
  siteUrl: 'https://bcmyguest.github.io',
  basePath: '/ai-collab/',
};
