import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { DocsSidebar } from "@/components/docs/sidebar";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader />
      <div className="mx-auto flex w-full max-w-7xl flex-1 px-5">
        <aside className="hidden w-60 shrink-0 border-r border-edge-soft py-10 pr-6 lg:block">
          <div className="thin-scroll sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto">
            <DocsSidebar />
          </div>
        </aside>
        <main className="min-w-0 flex-1 py-10 lg:pl-10">{children}</main>
      </div>
      <SiteFooter />
    </>
  );
}
