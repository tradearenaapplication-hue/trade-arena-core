## 2026-09-21 - ARIA Expanded State on Dynamic Collapsible Panels
**Learning:** When dynamic components (like bot settings gear dropdowns or collapsible section headers) use CSS class toggles (`classList.toggle('open')`), screen readers do not automatically register state changes without matching `aria-expanded` updates on the triggering element.
**Action:** Always pair `classList.toggle('open')` with `setAttribute('aria-expanded', isOpen)` and ensure the initial trigger markup defines `aria-expanded="false"` and `aria-controls="[target-id]"`.
