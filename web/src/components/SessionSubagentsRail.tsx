import { SubagentsContent } from "@/components/SubagentsContent";

/**
 * Desktop right-rail Subagents panel for the Chat screen.
 *
 * Drops straight into the 3-column chat grid (mockup s-13 lines 2383-2484).
 * All the list logic, grouping, expand / collapse, and live-update plumbing
 * lives in SubagentsContent; this wrapper just paints the sidebar chrome
 * (the `<aside>` with border-l + bg-paper/40) so Chat.tsx stays thin.
 *
 * Hidden below md — Chat switches the mobile affordance to
 * <SubagentsDrawer /> triggered from the header Bot icon.
 */
export function SessionSubagentsRail({ sessionId }: { sessionId: string }) {
  return (
    <aside className="hidden md:flex border-l border-line bg-paper/40 flex-col min-h-0 w-[320px] shrink-0">
      <SubagentsContent sessionId={sessionId} />
    </aside>
  );
}
