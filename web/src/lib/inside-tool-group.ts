import { createContext } from "react";

// True when the subtree is rendered inside an expanded ToolGroup body.
// Nested collapsible cards (DiffView, ToolCallBlock) read this to suppress
// their own `sticky top-0` header — if both the outer ToolGroup header and
// the inner card headers were sticky at the same scroller anchor, inner
// bodies could scroll up past the outer pinned header (multiple sticky
// siblings can't mask each other). ToolGroup pins; inner cards scroll.
export const InsideToolGroupContext = createContext(false);
