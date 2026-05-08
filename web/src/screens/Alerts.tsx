import { Bell } from "lucide-react";
import { AppShell } from "@/components/AppShell";

// Placeholder for the Alerts tab. The mockup's tab bar includes Alerts with
// a badge (mockup 434); the backend has no alert surface yet, so this screen
// just shows an honest empty state rather than faking content.
export function AlertsScreen() {
  return (
    <AppShell tab="alerts">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">Alerts</div>
          <h1 className="display text-[1.25rem] leading-tight mt-0.5">
            What needs your eyes
          </h1>
        </div>
      </header>

      <section className="flex-1 min-h-0 flex items-center justify-center px-6 py-10">
        <div className="max-w-[40ch] text-center">
          <div className="inline-flex h-10 w-10 rounded-full bg-paper border border-line items-center justify-center mb-3">
            <Bell className="w-4 h-4 text-ink-muted" />
          </div>
          <div className="display text-[1.25rem] mb-1">No alerts yet.</div>
          <p className="text-[13px] text-ink-muted leading-relaxed">
            When a session needs your approval or a routine flags something,
            it'll show up here. Permission prompts currently live inline in
            each chat.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
