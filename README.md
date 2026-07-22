# Flutter Widget Navigator

A VS Code extension that exposes **the widget tree of a Dart file** in a keyboard-navigable
list, designed to be read by a screen reader.

`Ctrl+Shift+O` and the breadcrumb bar only show *declarations* (classes, methods, fields).
Everything that happens inside a `build()` method is made of *expressions*, and is therefore
invisible. This extension fills that gap.

The interface is available in **English and French**; it follows VS Code's display language.

---

## Installation

Until the extension is on the Marketplace, install the packaged file:

```bash
code --install-extension flutter-widget-navigator-0.1.0.vsix
```

To build that file yourself:

```bash
npm install && npx @vscode/vsce package --no-dependencies
```

---

## Usage

| Key | Effect |
|---|---|
| `Ctrl+Alt+W` | Opens the widget list for the active Dart file, on the widget nearest the cursor |
| Up / Down Arrow | Move through the list; the editor scrolls to the line, the cursor does not move |
| Type text | Filters the list (widget name, or `line 42`) |
| `Alt+Right` | Expands the current item |
| `Alt+Left` | Collapses the current item; on a leaf, moves up to the parent widget |
| `Enter` | Closes the list, puts the cursor on the widget, gives the focus back to the editor |
| `Escape` | Closes without moving anything, gives the focus back to the editor |
| `Alt+F1` | Shows the help *inside the list*; `Alt+F1` or `Enter` to go back |

A line reads, for instance:

```
L2 · Column, 4 children, collapsed        line 55
L3 · Padding                              line 53
```

The level (`L2`), the number of children and the fold state are **spelled out** in the item
text, never implied by indentation or an icon: a screen reader announces the text, not the
layout. Nothing is said for an expanded widget: everything starts expanded, so the word
would be spoken on nearly every item without carrying any information. The fold state resets
on every open.

`Ctrl+Shift+O` and `Ctrl+Shift+.` are left untouched.

> `Ctrl+Shift+W` was **not** chosen as the shortcut: it is already
> `workbench.action.closeWindow` on Windows.

---

## The help (`Alt+F1`)

`Alt+F1` replaces the widget list with the help lines, inside the same widget. The focus
never moves, the list does not close, and each line is an ordinary item that a screen reader
reads as you arrow onto it. `Alt+F1` or `Enter` restores the list, the filter and the item
that were active.

**Why not use VS Code's real accessibility help view?** Because it is not open to
extensions:

- `vscode.d.ts` (the public API) contains **no** occurrence of `ariaLabel`, and for
  `accessib` only `AccessibilityInformation` (`label` + `role`), limited to `StatusBarItem`,
  `TreeItem` and tabs. There is no mechanism to register help text.
- In
  [`accessibilityConfiguration.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/accessibility/browser/accessibilityConfiguration.ts),
  the `AccessibilityVerbositySettingId` enum covers 26 features (terminal, editor, notebook,
  chat, hover, debug…). **None of them is a QuickPick.**

This is also why the placeholder and the title must stay very short —
[`quickInput.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/quickinput/browser/quickInput.ts#L1063):

```ts
let ariaLabel = this.ariaLabel;
if (!ariaLabel && visibilities.inputBox) {
    ariaLabel = this.placeholder;
    if (this.title) {
        ariaLabel = ariaLabel ? `${ariaLabel} - ${this.title}` : this.title;
    }
    ...
}
this.ui.list.ariaLabel = ariaLabel ?? null;
this.ui.inputBox.ariaLabel = ariaLabel ?? 'input';
```

The placeholder **and** the title are concatenated into the `aria-label` of both the input
box and the list: anything put there is read out on every open, before the first widget.
Hence `"Filter widgets."` and a title reduced to `counter.dart, 21 widgets`. **Any
documentation added there is paid for on every single call**; its place is in the help lines,
in `src/list.ts`.

---

## Why a hand-written parser, rather than the analysis server's data?

The Dart analysis server already computes this tree and sends it to the official Dart
extension through the `dart/textDocument/publishFlutterOutline` LSP notification. **That data
is not available to third-party extensions.** Verified against the sources of
`Dart-Code/Dart-Code` (branch `master`, July 2026):

- [`src/extension/api/interfaces.ts`](https://github.com/Dart-Code/Dart-Code/blob/master/src/extension/api/interfaces.ts) —
  the public API (`PublicDartExtensionApi`, version 3) only offers `workspace.getOutline()`,
  which returns the *Dart* outline, that is, declarations. No Flutter outline.
- [`src/extension/api/extension_api.ts`](https://github.com/Dart-Code/Dart-Code/blob/master/src/extension/api/extension_api.ts) —
  the implementation calls `fileTracker.waitForOutline()`, not `waitForFlutterOutline…`.
- [`src/extension/analysis/file_tracker.ts`](https://github.com/Dart-Code/Dart-Code/blob/master/src/extension/analysis/file_tracker.ts) —
  `onFlutterOutline`, `getFlutterOutlineFor()` and `waitForFlutterOutlineWithLength()` do
  exist, but they are internal.
- [`src/extension/extension.ts`](https://github.com/Dart-Code/Dart-Code/blob/master/src/extension/extension.ts) —
  the internal `_privateApi` object is only attached to the exports `if (isDartCodeTestRun)`,
  with the comment "*These are not for use by other extensions*". And
  `src/shared/constants.ts` defines `isDartCodeTestRun = !!process.env.DART_CODE_IS_TEST_RUN`.

The stream itself is not deprecated: only the Flutter Outline *view* is
([issue #6018](https://github.com/Dart-Code/Dart-Code/issues/6018)), and
`src/extension/analysis/analyzer.ts` still enables `flutterOutline` in its
`initializationOptions` (it feeds the UI guides). The notification is documented in the Dart
SDK's [`pkg/analysis_server/tool/lsp_spec/README.md`](https://github.com/dart-lang/sdk/blob/main/pkg/analysis_server/tool/lsp_spec/README.md).

The only two other ways in would be to run **our own** `dart language-server` (a second
analysis server: several hundred megabytes of RAM and tens of seconds of latency on first
use), or to ask Dart-Code to add `getFlutterOutline()` to its public API. Hence the choice of
a local parser: instant, dependency-free, and readable.

---

## How the tree is built (and its limits)

`src/widgetParser.ts` reads the text of the file and applies one simple rule:

> an identifier starting with a capital letter, immediately followed by an opening
> parenthesis, is a constructor call — therefore a widget.

The hierarchy comes from parenthesis nesting. Comments and string literals (including
`'''triple'''` and `r'raw'` ones) are ignored.

### Helper methods are followed

Splitting a `build()` into small methods is the good practice we teach, so the tree has to
keep mirroring the interface. The parser finds the members of the file that build widgets —
`Widget _buildButtons() {…}`, `Widget _card(…) => …`, `List<Widget> _cards() {…}`,
`Widget get header => …` — and **copies their contents under their call site**:

```
L4 · Column, 4 children
L5 · SizedBox
L5 · _buildButtons(), 1 child     ← the call, line 67
L6 · Row, 2 children              ← the method body, line 81
L7 · ElevatedButton.icon, 2 children
```

Enter on `_buildButtons()` goes to the call; Enter on `Row` goes into the method. A method
called twice is copied in both places; a method that is never called keeps its own tree; a
recursive method is expanded only once.

A name declared **more than once** in the file is deliberately ignored: that is the case of
`build`, present in every class. Nothing in the plain text tells which declaration a call
refers to, and a wrong tree would be worse than no tree.

### The safety nets

Four lists, all editable at the top of `widgetParser.ts`:

1. **`NON_WIDGET_CLASSES`** — the deny list (`TextStyle`, `EdgeInsets`, `Duration`…).
   Extendable without touching the code, through the `flutterWidgetNav.excludedClasses`
   setting.
2. **`NAMED_CONSTRUCTORS`** — the allow list of accepted named constructors (`Image.asset`,
   `ListView.builder`, `Text.rich`…). Without it, `Theme.of(context)` and
   `Navigator.push(...)` would show up as widgets.
3. **`TOKENS_BEFORE_DECLARATION`** — tells `const MyWidget({super.key});` (a constructor
   *declaration*, to be ignored) from `const MyWidget()` (a *call*, to be kept).
4. **`NON_WIDGET_SUFFIXES`** — discards `createState() => _MyPageState();`, which would
   otherwise show a spurious widget in every stateful class.

### Known limits

- A widget stored in a **local variable** (`final header = Text(…);` then `header` in the
  children) is not linked to where it is used: it shows up as a separate tree. Only class
  *members* are followed, not local variables.
- A helper method declared in **another class**, or in another file, is not followed: the
  analysis stops at the boundaries of the open file.
- A getter (`Widget get header => …`) is recognized everywhere its name appears, since it is
  used without parentheses. A local variable with the same name would be mistaken for it.
- Named constructors missing from `NAMED_CONSTRUCTORS` are ignored.
- A string whose interpolation itself contains a quote (`'${m['key']}'`) can throw the
  analysis of that file off.
- The **whole** file is analysed, not just `build()` methods.

Two fixtures guard all of this. `examples/counter.dart` is the `flutter create` skeleton,
`examples/traps.dart` collects the hostile cases (triple-quoted and raw strings, comments
containing widget calls, collection-`if`, `switch` expressions, `.map()`, nested lambdas).
Their parsed trees are recorded next to them as `.expected.txt`, and:

```bash
npm run compile && npm test
```

fails on any difference. Print the trees instead with `npm run verify`, and record a new
reference — after reading the diff — with `npm test -- --update`.

---

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to open an Extension Development Host with the extension loaded.

| File | Role |
|---|---|
| `src/widgetParser.ts` | Builds the tree from the text. No dependency on VS Code. |
| `src/list.ts` | Flattens the tree, **formats the text the screen reader reads** (`formatLabel`), holds the help lines. |
| `src/extension.ts` | Commands, QuickPick, folding, help, jump to code. |
| `l10n/bundle.l10n.fr.json` | French translations of the runtime strings. |
| `package.nls.json` / `package.nls.fr.json` | Translations of the manifest (command titles, settings). |
| `tools/verify.js` | Command-line test bench for the parser. |
| `examples/counter.dart` | Test fixture. |

Conventions for contributors are in [CLAUDE.md](CLAUDE.md) — in short: the repository is
English, and every user-facing string must exist in both English and French.
