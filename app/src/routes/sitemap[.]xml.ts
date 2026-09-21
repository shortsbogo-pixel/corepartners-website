import { createFileRoute } from '@tanstack/react-router'

// See robots.txt route: one canonical domain, independent of serving host.
const SITE = 'https://corepartners.kr'

const PAGES: Array<{ path: string; priority: string; changefreq: string; lastmod?: string }> = [
  { path: '/', priority: '1.0', changefreq: 'weekly', lastmod: '2026-09-21' },
  { path: '/coupang-plus', priority: '0.9', changefreq: 'weekly', lastmod: '2026-09-21' },
  { path: '/rent', priority: '0.85', changefreq: 'monthly', lastmod: '2026-09-21' },
  { path: '/docs', priority: '0.8', changefreq: 'monthly', lastmod: '2026-09-21' },
  { path: '/store', priority: '0.8', changefreq: 'monthly', lastmod: '2026-09-21' },
  { path: '/center', priority: '0.8', changefreq: 'monthly', lastmod: '2026-09-21' },
  { path: '/about', priority: '0.6', changefreq: 'monthly', lastmod: '2026-08-02' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly', lastmod: '2026-07-30' },
]

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () => {
        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          ...PAGES.flatMap(({ path, priority, changefreq, lastmod }) => [
            '  <url>',
            `    <loc>${SITE}${path}</loc>`,
            ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
            `    <changefreq>${changefreq}</changefreq>`,
            `    <priority>${priority}</priority>`,
            '  </url>',
          ]),
          '</urlset>',
        ].join('\n')
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      },
    },
  },
})
