# Palette's Journal - UX & Accessibility Learnings

## 2026-09-15 - Crucible Regime Button Group Accessibility
**Learning:** Custom button groups acting as single-select toggle groups in index.html (like regime buttons) lacked default active classes, `aria-pressed` attributes, and click handlers.
**Action:** Always wrap custom button group selectors with `role="group"` and `aria-labelledby`, set default active button state with `aria-pressed="true"`, and bind event handlers that maintain synchronized visual state and `aria-pressed` values.
