import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const GA_ID = "G-PQ25GW61LR";

// Set NEXT_PUBLIC_SITE_URL to your deployed origin before publishing — it
// anchors canonical URLs, Open Graph image paths, sitemap, and robots.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://zenzip.vercel.app";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const TITLE = "ZenZip — Agent-native backend framework for Node.js";
const DESCRIPTION =
  "Durable workflows, queues, schedules, and AI agents on a single Rust-powered runtime. Zero infrastructure: no Redis, no Temporal cluster, no RabbitMQ — npm install is the entire setup.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · ZenZip",
  },
  description: DESCRIPTION,
  applicationName: "ZenZip",
  keywords: [
    "ZenZip",
    "durable workflows",
    "job queue",
    "Node.js framework",
    "background jobs",
    "task queue",
    "cron scheduler",
    "AI agents",
    "durable execution",
    "Inngest alternative",
    "Temporal alternative",
    "BullMQ alternative",
    "Rust",
    "SQLite",
    "Postgres",
  ],
  authors: [{ name: "ZenZip" }],
  creator: "ZenZip",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "ZenZip",
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "ZenZip" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ZenZip",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Node.js",
  description: DESCRIPTION,
  url: SITE_URL,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: "https://opensource.org/licenses/MIT",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {children}
        {/* Structured data for rich search results */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        {/* Google Analytics (gtag.js) */}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`}
        </Script>
      </body>
    </html>
  );
}
