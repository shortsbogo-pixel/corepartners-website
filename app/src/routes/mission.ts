import { createFileRoute } from "@tanstack/react-router";

// Short link for printed materials (business card QR, flyers):
// 코아파트너스.com -> /mission -> weekly promotion & mission conditions
export const Route = createFileRoute("/mission")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        return Response.redirect(`${origin}/coupang-plus#promo`, 302);
      },
    },
  },
});
