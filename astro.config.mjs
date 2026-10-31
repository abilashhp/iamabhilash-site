// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // The apex domain 301s here, so this is the canonical origin.
  site: 'https://www.iamabhilash.in',
  integrations: [
    // The invite pages and MF alerts are private and carry noindex; keep them out of the sitemap too.
    sitemap({
      filter: (page) => !/\/(invite(-card(-kn)?)?|tools\/mf-alerts)\/?$/.test(new URL(page).pathname),
      // Static (non-Astro) pages under public/ that the integration can't discover.
      customPages: ['https://www.iamabhilash.in/tools/edge-log-analyzer/'],
    }),
  ],
});
