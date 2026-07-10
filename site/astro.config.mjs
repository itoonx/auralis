import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

// Deploy target (docs: landing plan §6): GitHub Pages serves the site under
// /Auralis until a custom domain is decided — canonical/OG/sitemap URLs all
// derive from `site` + `base`. CI sets SITE_URL/SITE_BASE; local dev stays /.
// Custom-domain switch later = change those two env vars, nothing else.
const site = process.env.SITE_URL ?? 'https://auralis.example'
const base = process.env.SITE_BASE ?? '/'

export default defineConfig({
  site,
  base,
  output: 'static',
  integrations: [
    // /og is the OG-image source frame, not a page
    sitemap({ filter: (page) => !page.includes('/og') }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
})
