import type { MetadataRoute } from "next";

const SITE_URL = "https://menorix.com";

/** Public entry points crawlers can reach without auth (middleware allows static assets). */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    {
      url: SITE_URL,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/login`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
