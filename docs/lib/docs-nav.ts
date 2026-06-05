export interface NavItem {
  title: string;
  href: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const docsNav: NavGroup[] = [
  {
    title: "Getting Started",
    items: [
      { title: "Introduction", href: "/docs/introduction" },
      { title: "Quickstart", href: "/docs/quickstart" },
    ],
  },
  {
    title: "Core Concepts",
    items: [
      { title: "Architecture", href: "/docs/architecture" },
      { title: "Durability & Semantics", href: "/docs/durability" },
    ],
  },
  {
    title: "Guides",
    items: [
      { title: "Queues", href: "/docs/queues" },
      { title: "Schedules", href: "/docs/schedules" },
      { title: "Workflows", href: "/docs/workflows" },
      { title: "Agents", href: "/docs/agents" },
      { title: "Events", href: "/docs/events" },
      { title: "State Machines", href: "/docs/state-machines" },
      { title: "HTTP & Dashboard", href: "/docs/http-dashboard" },
      { title: "Configuration", href: "/docs/configuration" },
    ],
  },
  {
    title: "Project",
    items: [
      { title: "Benchmarks", href: "/docs/benchmarks" },
      { title: "Roadmap", href: "/docs/roadmap" },
    ],
  },
];

export const flatNav: NavItem[] = docsNav.flatMap((g) => g.items);
