## 2026-06-18 - [Accessibility & Interaction Feedback]
**Learning:** Collapsible panels using non-semantic div headers require explicit role="button", tabindex="0", and aria-expanded attributes, along with a global keyboard listener for Enter/Space to meet accessibility standards. Async AI inputs benefit from immediate visual feedback (disabling inputs) to prevent duplicate actions.
**Action:** Always apply role="button" and tabindex="0" to clickable divs and use try...finally blocks for async UI state management.

## 2026-09-24 - [Escape Key Dismissal for Modals & Dropdowns]
**Learning:** WCAG 2.1 compliance requires that keyboard users can dismiss open modal dialogs, slide-out panels, and dropdown menus using the `Escape` key. Returning early after handling the topmost active modal prevents chained dismissals.
**Action:** Always register a global `Escape` key listener when building overlay or modal UI components in Vanilla JS/HTML.

## 2026-10-01 - [Bus Preset Toggle ARIA Accessibility]
**Learning:** Grouped preset toggle buttons that alter multi-item settings require updating `aria-pressed="true|false"` dynamically alongside visual `.active` CSS classes so screen reader users perceive state updates when selecting presets.
**Action:** Always pair visual active state updates with `aria-pressed` toggle logic in group selection helper functions (`_busHighlight`).

## 2026-10-13 - [Floating Banner Escape Key Accessibility]
**Learning:** Floating notification/warning banners (`role="alert"` / `aria-live`) positioned fixed on screen must be dismissible via the `Escape` key in addition to visible dismiss buttons to satisfy WCAG 2.1 keyboard interaction guidelines.
**Action:** Include floating banners in global `Escape` key dismissal stacks alongside modal dialogs and dropdown menus.

## 2026-10-18 - [Dynamically Generated Results Modal ARIA & Escape Key Handling]
**Learning:** Dynamically created DOM modal overlays (like backtest or audit summary results) require explicit `id`, `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and `aria-label` attributes set at creation time, as well as inclusion in the global `Escape` key dismissal stack.
**Action:** Always assign explicit ARIA dialog attributes and register the container ID in the global keydown listener when constructing dynamic modal dialog overlays via JS.
