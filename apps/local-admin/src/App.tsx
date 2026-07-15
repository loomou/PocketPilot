import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";

const CONFIGURATION_SECTIONS = [
  "Agent status",
  "Devices and pairing",
  "Workspace roots",
  "Listener and mobile URL",
] as const;

export function App() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950 sm:px-10">
      <section className="mx-auto max-w-4xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <Settings2 aria-hidden="true" className="size-4" />
              PocketPilot local administration
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight">
                Configuration page scaffold
              </h1>
              <p className="max-w-2xl text-slate-600">
                This local-only interface will configure the Agent after its
                secure runtime and local APIs are implemented.
              </p>
            </div>
          </div>
          <Button disabled type="button">
            Agent unavailable
          </Button>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {CONFIGURATION_SECTIONS.map((section) => (
            <article
              className="rounded-xl border border-dashed border-slate-300 p-5"
              key={section}
            >
              <h2 className="font-medium">{section}</h2>
              <p className="mt-2 text-sm text-slate-600">
                Not connected during the frontend scaffold phase.
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
