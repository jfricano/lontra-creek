/** The sitemap: the home page and every page whose real content exists. Placeholders stay out. */
import type { APIRoute } from "astro";
import { PAGES } from "../site.ts";

export const GET: APIRoute = ({ site }) => {
  if (site === undefined) throw new Error("astro.config.mjs must set site.");
  const paths = ["/", ...PAGES.filter(page => page.ready).map(page => page.href)];
  const urls = paths.map(path => `  <url><loc>${new URL(path, site).href}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
