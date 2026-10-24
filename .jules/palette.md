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

## 2026-10-19 - [Dynamic Agent Row Action ARIA Disambiguation]
**Learning:** Dynamically rendered table action buttons (e.g. SUSPEND, REINSTATE, CLEAR) repeated per table row require explicit agent/entity name context in `aria-label` and `title` to prevent ambiguous announcements for screen reader users (WCAG 2.4.6 / 4.1.2).
**Action:** Always interpolate entity identifiers into `aria-label` and `title` attributes when mapping row actions in dynamic HTML templates.

## 2026-10-21 - [Modal Dialog Initial Focus & Toggle ARIA Attributes]
**Learning:** When launching or toggling fixed modal dialog overlays (such as the voice agent modal or holdings modal), explicitly setting focus to the primary interactive element (e.g. text input or close button) via setTimeout prevents focus loss behind the overlay, while pairing toggle controls with aria-label and aria-pressed attributes ensures WCAG 2.1 compliance.
**Action:** Always shift focus to an interior element upon opening modal dialogs and restore focus to trigger buttons upon close.

## 2026-10-24 - [Preset Button Icon & Symbol ARIA Context]
**Learning:** Compact preset toggle buttons containing leading emojis or concise symbol percentages (e.g. 🔥 Aggressive, −10%) require explicit `aria-label` and `title` attributes describing the exact action scope (e.g. 'Set Aggressive personality for all bots', 'Set stop loss to minus 10% for all bots') so screen readers announce human-understandable context rather than disjointed symbol names.
**Action:** Always pair compact icon/percentage preset buttons with explicit, descriptive `aria-label` and `title` attributes.
