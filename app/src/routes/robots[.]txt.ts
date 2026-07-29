import { createFileRoute } from '@tanstack/react-router'

// Canonical public domain. Hardcoded on purpose: the site is also reachable at
// its origin host (corepartners-dj.higgsfield.app) behind the corepartners.kr
// reverse proxy, and search engines must be pointed at ONE address regardless
// of which host served the request.
const SITE = 'https://corepartners.kr'

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async () => {
        const body = [
          'User-agent: *',
          'Allow: /',
          'Disallow: /admin',
          '',
          `Sitemap: ${SITE}/sitemap.xml`,
        ].join('\n')
        return new Response(body, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        })
      },
    },
  },
})
