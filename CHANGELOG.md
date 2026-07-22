# Changelog

## 0.1.0

First release.

- `Ctrl+Alt+W` opens the widget tree of the active Dart file in a keyboard-navigable
  list. The list opens on the widget nearest the cursor.
- Depth, child count and fold state are spelled out in the item text, so a screen
  reader announces them: `L3 · Padding`, `L2 · Column, 4 children, collapsed`.
- `Alt+Right` / `Alt+Left` expand and collapse; on a leaf, `Alt+Left` moves up to
  the parent widget.
- `Alt+F1` shows the key list inside the QuickPick itself.
- Moving through the list scrolls the editor without touching the cursor. `Enter`
  jumps to the widget, `Escape` leaves everything where it was.
- Helper methods are followed: the contents of `Widget _buildButtons() {…}` appear
  under its call site.
- English and French user interface.
