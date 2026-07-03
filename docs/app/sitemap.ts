import type { MetadataRoute } from "next";

import { flatNav } from "@/lib/docs-nav";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://zenzip.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ["/", "/docs", ...flatNav.map((n) => n.href)];
  const unique = Array.from(new Set(paths));
  return unique.map((path) => ({
    url: new URL(path, SITE_URL).toString(),
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
