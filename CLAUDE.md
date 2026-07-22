# CLAUDE.md

Working notes for this repository. Read this before changing anything.

## What this is

A VS Code extension that exposes the **widget tree inside a Dart `build()` method**
in a keyboard-navigable QuickPick. `Ctrl+Shift+O` and the breadcrumb bar only show
declarations; everything inside a `build()` is an expression, so it is invisible.

The extension is written **for a blind student learning Flutter with NVDA on Windows**.
That is not background colour — it decides most of the design choices below.

## Language policy

Two separate rules. Do not mix them up.

1. **The repository is English.** Documentation, code, comments, identifiers, file
   names, commit messages, and the output of developer tools (`tools/verify.js`)
   are all in English. No French anywhere in the source.
2. **The extension is bilingual, English and French.** Every string a user can see
   or hear must exist in both languages.

### How to add a user-facing string

Runtime strings (anything in `src/`):

```ts
vscode.l10n.t("Filter widgets.")
vscode.l10n.t("line {0}", line + 1)
```

The English text in the source *is* the lookup key. In the same change, add the
French translation to [`l10n/bundle.l10n.fr.json`](l10n/bundle.l10n.fr.json), keyed
by that exact English string. If the English text changes, the key changes — update
the bundle too, or the French build silently falls back to English.

Manifest strings (`package.json`: command titles, setting descriptions, extension
description) use `%placeholders%`, resolved by
[`package.nls.json`](package.nls.json) (English, the default) and
[`package.nls.fr.json`](package.nls.fr.json).

**Never merge a user-facing string that exists in only one of the two.**

Note that `L{0}` (the level prefix) is itself translated: it reads `L3` in English
and `N3` in French, for *niveau*. It is a word a screen reader speaks, not a symbol.

## Accessibility rules — non-negotiable

- **Depth is spelled out in the item text** (`L3 · Padding`). Never encode depth
  with indentation, an icon, or a chevron: a screen reader announces the label
  text and nothing else. The same goes for the collapsed/expanded state and the
  child count.
- **Keep `placeholder` and `title` extremely short.** VS Code builds the
  `aria-label` of both the input box and the list by concatenating them
  (`quickInput.ts`, `update()`, around line 1063), so every word there is read out
  on *every* open. Documentation belongs in the Alt+F1 help (`buildHelpItems()` in
  `src/list.ts`), never in the placeholder.
- **Never show an empty, silent QuickPick.** Every failure path ends in an explicit
  `showWarningMessage`.
- **Do not override `Ctrl+Shift+O` or `Ctrl+Shift+.`.** They must keep working.
  `Ctrl+Shift+W` is also off limits: it is `workbench.action.closeWindow` on Windows.
- A missing node is bad; a **wrong** node is worse. When the parser cannot decide,
  it must omit rather than guess (see the `ambiguous` set in `findWidgetMembers`).

## Architecture

| File | Role |
|---|---|
| `src/widgetParser.ts` | Builds the tree from raw text. **No dependency on `vscode`**, which is what makes `tools/verify.js` possible. |
| `src/list.ts` | Flattens the tree, formats the text a screen reader reads (`formatLabel`), holds the help lines. |
| `src/extension.ts` | Commands, QuickPick, folding, help, jump to code. |
| `tools/verify.js` | Command-line test bench for the parser. |
| `examples/counter.dart` | Test fixture, deliberately full of traps. |

The parser runs in four steps, documented at the top of `widgetParser.ts`: mask
strings and comments → find widget-building members → scan → graft helper methods
under their call sites.

## Why a hand-written parser

The Dart analysis server already computes this tree and sends it over the
`dart/textDocument/publishFlutterOutline` LSP notification, but **Dart-Code does not
expose it to third-party extensions** — its public API only offers `getOutline()`
(declarations), and the internal `_privateApi` is only attached when Dart-Code runs
in test mode. Full evidence, with file references, is in the README. Do not "fix"
the parser by reaching for a Dart-Code API that does not exist.

## Verifying a change

```bash
npm run compile && npm run verify
```

`npm run verify` prints the parsed tree for `examples/counter.dart`. Any change to
the parser must be checked against that file *and* against a file of your own with
awkward cases (triple-quoted strings, raw strings, `switch` expressions,
collection-`if`, nested lambdas) before being called done.

Then `F5` opens an Extension Development Host to test the UI by hand. Two things
can only be verified there, never from the compiler:

- that `Alt+Left`, `Alt+Right` and `Alt+F1` actually reach our commands while the
  QuickPick has focus (all three share one mechanism: a command plus a keybinding
  gated on the `flutterWidgetNav.listOpen` context key);
- that NVDA re-reads an item after a fold toggle.

To test the French UI, set VS Code's display language to French
(`Configure Display Language`) and restart; the `fr` language pack must be installed.
