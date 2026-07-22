# Widget Tree Navigator

Browse the **widget tree inside a Flutter/Dart `build()` method** in a keyboard-navigable
list, designed to be read by a screen reader.

`Ctrl+Shift+O` and the breadcrumb bar only show *declarations* — classes, methods, fields.
Everything inside a `build()` method is made of *expressions*, so the widget hierarchy is
invisible to them. This extension fills that gap.

The interface follows VS Code's display language, in **English and French**.

## Installation

Until the extension is on the Marketplace, install the packaged file:

```bash
code --install-extension widget-tree-navigator-0.1.0.vsix
```

## Usage

Put the cursor anywhere in a Dart file and press `Ctrl+Alt+W`. The list opens on the widget
nearest the cursor.

| Key | Effect |
|---|---|
| `Ctrl+Alt+W` | Open the widget list |
| Up / Down Arrow | Move through the list; the editor scrolls along, the cursor does not move |
| Type text | Filter, by widget name or by `line 42` |
| `Alt+Right` | Expand the current item |
| `Alt+Left` | Collapse it, or move up to the parent widget |
| `Enter` | Jump to the widget and return to the editor |
| `Escape` | Close, leaving the cursor and the scroll position untouched |
| `Alt+F1` | Show the key list inside the list itself |

A line reads:

```
L2 · Column, 4 children, collapsed        line 55
L3 · Padding                              line 53
```

Depth, child count and fold state are **spelled out in the text**, never implied by
indentation or an icon — a screen reader announces the label, not the layout. Nothing is said
for an expanded widget, since everything starts expanded and the word would carry no
information. Folding resets on every open.

`Ctrl+Shift+O` and `Ctrl+Shift+.` keep working as usual.

Helper methods are followed: the widgets built by `Widget _buildButtons() {…}` appear under
its call site rather than in a separate tree.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `flutterWidgetNav.separator` | `" · "` | Text between the level and the widget name. Change it to ` - ` or `, ` if your screen reader reads the middle dot in a distracting way. |
| `flutterWidgetNav.excludedClasses` | `[]` | Extra class names that must not be treated as widgets, on top of the built-in list. |

## Known limits

The tree is parsed from the file text, which is fast and needs nothing installed, but is not
a Dart compiler. In particular:

- A widget stored in a **local variable**, or built by a method in **another class or file**,
  is not linked to where it is used.
- A name declared twice in the file (typically `build`) is deliberately ignored: nothing tells
  which declaration a call refers to, and a wrong tree is worse than an incomplete one.
- Rarely used **named constructors** may be missing; add them to `NAMED_CONSTRUCTORS` in
  `src/widgetParser.ts`.
- The whole file is analysed, not only `build()` methods.

## Why not the Dart extension's Flutter Outline?

The Dart analysis server does compute this tree, but Dart-Code does not expose it to
third-party extensions — its public API only returns the Dart outline, that is, declarations.
The Flutter Outline view has itself been removed. Hence the local parser. The detailed
evidence, with file references, is in [CLAUDE.md](CLAUDE.md).

## Development

```bash
npm install
npm run compile
npm test
```

`npm test` parses the two fixtures in `examples/`, compares the result to the recorded
`.expected.txt` files, and checks that every user-facing string exists in both English and
French. Press `F5` to open an Extension Development Host and try the UI.

| File | Role |
|---|---|
| `src/widgetParser.ts` | Builds the tree from the text. No dependency on VS Code. |
| `src/list.ts` | Flattens the tree and formats the text the screen reader reads. |
| `src/extension.ts` | Commands, QuickPick, folding, help, jump to code. |
| `l10n/`, `package.nls*.json` | French translations. |
| `tools/` | Parser test bench and translation checker. |

Conventions are in [CLAUDE.md](CLAUDE.md): the repository is English, every user-facing
string must exist in both languages, and the accessibility rules are not negotiable.
