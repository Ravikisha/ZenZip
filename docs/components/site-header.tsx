import Link from "next/link";

import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const links = [
  { title: "Docs", href: "/docs/introduction" },
  { title: "Workflows", href: "/docs/workflows" },
  { title: "API", href: "/api/index.html" },
  { title: "Benchmarks", href: "/docs/benchmarks" },
  { title: "Roadmap", href: "/docs/roadmap" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-edge-soft bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-5">
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="zenzip home">
            <Logo />
          </Link>
          <Badge variant="accent" className="hidden sm:inline-flex">
            v0.2 alpha
          </Badge>
        </div>
        <nav className="hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm text-ink-mid transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {link.title}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="https://github.com"
            className="grid size-9 place-items-center rounded-lg border border-edge text-ink-mid transition-colors hover:border-zinc-600 hover:text-ink"
            aria-label="GitHub repository"
          >
            <GithubMark className="size-4" />
          </Link>
        </div>
      </div>
    </header>
  );
}
