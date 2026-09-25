## 2026-06-18 - [Accessibility & Interaction Feedback]
**Learning:** Collapsible panels using non-semantic div headers require explicit role="button", tabindex="0", and aria-expanded attributes, along with a global keyboard listener for Enter/Space to meet accessibility standards. Async AI inputs benefit from immediate visual feedback (disabling inputs) to prevent duplicate actions.
**Action:** Always apply role="button" and tabindex="0" to clickable divs and use try...finally blocks for async UI state management.

## 2026-09-24 - [Escape Key Dismissal for Modals & Dropdowns]
**Learning:** WCAG 2.1 compliance requires that keyboard users can dismiss open modal dialogs, slide-out panels, and dropdown menus using the `Escape` key. Returning early after handling the topmost active modal prevents chained dismissals.
**Action:** Always register a global `Escape` key listener when building overlay or modal UI components in Vanilla JS/HTML.
