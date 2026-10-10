# CRM Commercial — page-specific design

This internal workspace overrides the generated landing-page pattern in `MASTER.md`.
Preserve Transmex's existing light/dark theme and shared Angular primitives; do not
import a second font or introduce a separate palette.

## Visual direction

- Dense, calm operations dashboard; flat surfaces and restrained 150–200 ms state
  transitions. No marketing hero, video, gradients, decorative shadows, or emoji icons.
- Use existing tokens: `--app-bg`, `--app-surface`, `--app-surface-muted`,
  `--app-surface-hover`, `--app-border`, `--app-text`, `--app-text-muted`,
  `--brand-accent`, `--brand-action`, and `--brand-focus`.
- Keep status meaning available in text and accessible labels, not color alone.
- SVG icons only; follow the existing module-icon and Material icon conventions.

## Workspace layout

- Use the full available width, with a compact page heading and a persistent
  `ModuleControlPanel` for search, filters, view actions, and primary creation.
- Pipeline: horizontally scrollable stage columns; cards show company, service
  mode/direction, route, value, owner, next activity, and linked quote/dossier.
- Clients, activities, and campaigns are focused data views within the same CRM
  navigation, not separate modules or independent customer records.
- Dialogs use the existing app surface and focus conventions, with clear saving,
  error, empty, and success states.

## Interaction and accessibility

- Make stage changes available through keyboard-operable controls; do not require
  drag-and-drop.
- Keep focus visible, labels explicit, controls comfortably targetable, and respect
  reduced-motion preferences.
- Make "Créer un dossier" an explicit action after the commercial verifies a won
  opportunity. Campaign preparation only selects and previews recipients; it never
  sends email or SMS automatically.
