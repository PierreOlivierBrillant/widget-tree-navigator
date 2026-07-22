/**
 * extension.ts
 * ============
 *
 * Entry point of the extension. Four commands:
 *
 *   flutterWidgetNav.showOutline  (Ctrl+Alt+W)  opens the widget list
 *   flutterWidgetNav.expand       (Alt+Right)   expands the current item
 *   flutterWidgetNav.collapse     (Alt+Left)    collapses the current item
 *   flutterWidgetNav.help         (Alt+F1)      shows the help inside the list
 *
 * The last three are only active while our list is open: their `when` clause in
 * package.json is `flutterWidgetNav.listOpen`, a context key we set ourselves on
 * open and on close (see CONTEXT_KEY below). Alt+Left, Alt+Right and Alt+F1 keep
 * their usual behaviour everywhere else.
 *
 * Why the detour? A QuickPick cannot react to an arbitrary key: its API only
 * exposes the filter text, the active item, acceptance and item buttons. Going
 * through a command plus a conditional keybinding is the only way to get a real
 * folding key. (Clickable chevrons on the items remain as a fallback.)
 *
 * All user-facing strings go through `vscode.l10n.t()`; the French translations
 * live in `l10n/bundle.l10n.fr.json`.
 */

import * as vscode from "vscode";
import { countNodes, parseWidgets, WidgetNode } from "./widgetParser";
import {
	buildHelpItems, buildItems, buildParentMap, findItemAtOffset, isWidgetItem, ListItem,
} from "./list";

/** Context key that enables the folding and help keybindings. */
const CONTEXT_KEY = "flutterWidgetNav.listOpen";

/**
 * How many times the placeholder mentions Alt+F1 before going quiet.
 *
 * The placeholder is read out on every open, so it must stay short. But a user
 * who never hears about the help has no way to discover it. Compromise: say it
 * during the first few uses, then stop.
 */
const HELP_HINT_OPENINGS = 5;

/** Key used in globalState to count how many times the list has been opened. */
const OPEN_COUNT_KEY = "flutterWidgetNav.openCount";

/**
 * State of the list currently on screen. `undefined` when nothing is open.
 *
 * It lives at module level because the folding commands are triggered by a
 * global keybinding: they need a way to find the QuickPick in progress.
 */
interface Session {
	quickPick: vscode.QuickPick<ListItem>;
	editor: vscode.TextEditor;
	roots: WidgetNode[];
	parents: Map<WidgetNode, WidgetNode>;
	/** Currently collapsed nodes. Reset on every open (no persistence). */
	collapsed: Set<WidgetNode>;
	separator: string;
	/** true while the list shows the help instead of the widgets. */
	helpMode: boolean;
	/** Where we were before opening help, so we can come back exactly there. */
	beforeHelp?: { node?: WidgetNode; filter: string };
}
let session: Session | undefined;

/** Highlight of the line being hovered while moving through the list. */
let highlight: vscode.TextEditorDecorationType;

/** Kept so that `showOutline` can reach `globalState` for the help hint. */
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
	extensionContext = context;
	highlight = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
	});

	context.subscriptions.push(
		highlight,
		vscode.commands.registerCommand("flutterWidgetNav.showOutline", showOutline),
		vscode.commands.registerCommand("flutterWidgetNav.expand", () => fold(false)),
		vscode.commands.registerCommand("flutterWidgetNav.collapse", () => fold(true)),
		vscode.commands.registerCommand("flutterWidgetNav.help", toggleHelp),
	);
}

export function deactivate(): void {
	session?.quickPick.dispose();
}

// ---------------------------------------------------------------------------
// Opening the list
// ---------------------------------------------------------------------------

async function showOutline(): Promise<void> {
	// --- Checks, with an explicit message for every failure case --------------
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		void vscode.window.showWarningMessage(
			vscode.l10n.t("Widget Tree Navigator: no active editor. Open a Dart file and try again."),
		);
		return;
	}

	// We also accept a file whose extension is .dart but that VS Code does not
	// recognize as Dart, which happens when the official Dart extension is not
	// installed. Our analysis does not depend on it, so there is no reason to
	// refuse to work.
	const isDart = editor.document.languageId === "dart"
		|| editor.document.uri.path.toLowerCase().endsWith(".dart");
	if (!isDart) {
		void vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Widget Tree Navigator: the active file is not Dart (detected language: \"{0}\").",
				editor.document.languageId,
			),
		);
		return;
	}

	const settings = vscode.workspace.getConfiguration("flutterWidgetNav");
	const separator = settings.get<string>("separator", " · ");
	const excludedClasses = settings.get<string[]>("excludedClasses", []);

	// The analysis runs on the text as displayed right now: a file that has been
	// modified but not saved still yields an up-to-date tree.
	const roots = parseWidgets(editor.document.getText(), excludedClasses);
	const total = countNodes(roots);

	if (total === 0) {
		void vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Widget Tree Navigator: no widget found in this file. The extension looks for constructor calls starting with a capital letter, such as Scaffold(...) or Text(...).",
			),
		);
		return;
	}

	// --- Building the QuickPick ------------------------------------------------
	// IMPORTANT FOR SCREEN READERS: VS Code builds the aria-label of the input box
	// by concatenating the placeholder and the title (`quickInput.ts`, `update()`,
	// around line 1063). That label is read out on every open — and again on every
	// fold, because replacing `items` empties the tree, which makes VS Code drop
	// `aria-activedescendant` from the input box (`quickInputController.ts`, around
	// line 291); with no active item left to announce, the screen reader falls back
	// to the control itself.
	//
	// So we set NO title at all. It would be spoken again on every single fold, and
	// the filename is something the user already knows. The item count is not lost
	// either: the list announces the position and size of each row on its own.
	const quickPick = vscode.window.createQuickPick<ListItem>();
	quickPick.placeholder = shouldHintHelp()
		? vscode.l10n.t("Filter widgets. Alt+F1 for help.")
		: vscode.l10n.t("Filter widgets.");
	// Also allows filtering on "line 42".
	quickPick.matchOnDescription = true;

	session = {
		quickPick,
		editor,
		roots,
		parents: buildParentMap(roots),
		collapsed: new Set(),
		separator,
		helpMode: false,
	};

	const items = buildItems(roots, editor.document, session.collapsed, separator);
	quickPick.items = items;

	// Start on the widget the user is already working on, not at the top of the
	// file. Set before show() so the very first thing announced is the right item.
	const cursorOffset = editor.document.offsetAt(editor.selection.active);
	const startItem = findItemAtOffset(items, cursorOffset);
	if (startItem) { quickPick.activeItems = [startItem]; }

	// Original scroll position, restored if the user cancels.
	const initialView = editor.visibleRanges[0];
	let accepted = false;

	// --- Moving through the list: reveal the line, never touch the cursor ------
	quickPick.onDidChangeActive((active) => {
		const item = active[0];
		// In help mode there is no code line to reveal.
		if (!isWidgetItem(item)) { return; }
		const range = new vscode.Range(item.line, 0, item.line, 0);
		// revealRange moves neither the cursor nor the focus: the QuickPick stays active.
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		editor.setDecorations(highlight, [range]);
	});

	// --- Clicking an item chevron (mouse fallback for folding) -----------------
	quickPick.onDidTriggerItemButton((event) => {
		if (isWidgetItem(event.item)) { toggleNode(event.item.node); }
	});

	// --- Enter: close, place the cursor, give the focus back to the editor -----
	quickPick.onDidAccept(() => {
		const item = quickPick.selectedItems[0];
		// Enter on a help line simply goes back to the widget list.
		if (!isWidgetItem(item)) {
			if (session?.helpMode) { toggleHelp(); }
			return;
		}
		accepted = true;
		quickPick.hide();
		void goToWidget(editor, item.node);
	});

	// --- Closing (Enter or Escape) --------------------------------------------
	quickPick.onDidHide(() => {
		editor.setDecorations(highlight, []);
		if (!accepted && initialView) {
			// Escape: the cursor never moved; we only put the scroll position back
			// where it was. The focus returns to the editor on its own.
			editor.revealRange(initialView, vscode.TextEditorRevealType.AtTop);
		}
		// If another list has been opened meanwhile, do not break its session.
		if (session?.quickPick === quickPick) {
			void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
			session = undefined;
		}
		quickPick.dispose();
	});

	await vscode.commands.executeCommand("setContext", CONTEXT_KEY, true);
	quickPick.show();
}

/**
 * True while the placeholder should still mention Alt+F1. Counts the openings in
 * globalState, so the hint fades away once the shortcut has been learned.
 */
function shouldHintHelp(): boolean {
	const count = extensionContext.globalState.get<number>(OPEN_COUNT_KEY, 0);
	if (count < HELP_HINT_OPENINGS) {
		void extensionContext.globalState.update(OPEN_COUNT_KEY, count + 1);
		return true;
	}
	return false;
}

/** Puts the cursor on the widget and gives the focus back to the editor. */
async function goToWidget(editor: vscode.TextEditor, node: WidgetNode): Promise<void> {
	const position = editor.document.positionAt(node.offset);
	const activeEditor = await vscode.window.showTextDocument(editor.document, {
		viewColumn: editor.viewColumn,
		preserveFocus: false, // this is what brings the focus back to the code
	});
	activeEditor.selection = new vscode.Selection(position, position);
	activeEditor.revealRange(
		new vscode.Range(position, position),
		vscode.TextEditorRevealType.InCenterIfOutsideViewport,
	);
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * The Alt+Left / Alt+Right commands.
 *
 * @param collapse true to collapse (Alt+Left), false to expand (Alt+Right).
 */
function fold(collapse: boolean): void {
	if (!session || session.helpMode) { return; }
	const item = session.quickPick.activeItems[0];
	if (!isWidgetItem(item)) { return; }

	const node = item.node;
	const hasChildren = node.children.length > 0;
	const isCollapsed = session.collapsed.has(node);

	if (collapse) {
		if (hasChildren && !isCollapsed) {
			session.collapsed.add(node);
			rebuild(node);
		} else {
			// Leaf, or already collapsed node: move up to the parent, as in any
			// tree. That is the gesture screen-reader users expect.
			const parent = session.parents.get(node);
			if (parent) { setActive(parent); }
		}
	} else {
		if (hasChildren && isCollapsed) {
			session.collapsed.delete(node);
			rebuild(node);
		}
		// On a leaf or an already expanded node, Alt+Right does nothing: Down
		// Arrow already moves to the first child.
	}
}

/** Used by the chevron click: simply flips the state of the node. */
function toggleNode(node: WidgetNode): void {
	if (!session || node.children.length === 0) { return; }
	if (session.collapsed.has(node)) {
		session.collapsed.delete(node);
	} else {
		session.collapsed.add(node);
	}
	rebuild(node);
}

/**
 * Regenerates the list after a fold and keeps `activeNode` selected.
 *
 * The items are recreated from scratch on purpose: this forces VS Code to
 * re-render the active line, and therefore a screen reader to read the label
 * again, which now says "collapsed" or "expanded".
 */
function rebuild(activeNode: WidgetNode): void {
	if (!session || session.helpMode) { return; }
	session.quickPick.items = buildItems(
		session.roots,
		session.editor.document,
		session.collapsed,
		session.separator,
	);
	setActive(activeNode);
}

/** Moves the selection onto the item for this node, if it is visible. */
function setActive(node: WidgetNode): void {
	if (!session) { return; }
	const target = session.quickPick.items.find((item) => isWidgetItem(item) && item.node === node);
	if (target) {
		session.quickPick.activeItems = [target];
	}
}

// ---------------------------------------------------------------------------
// Help (Alt+F1)
// ---------------------------------------------------------------------------

/**
 * Swaps the widget list for the help lines, and back.
 *
 * Why reinvent help when VS Code already has some (Alt+F1)? Because it is not
 * open to extensions: the public API exposes neither `ariaLabel` nor any way to
 * register help text, and the `accessibility.verbosity.*` settings cover no
 * QuickPick. See README, "The help (Alt+F1)".
 *
 * The trick is to stay inside the same widget: the focus never moves, so the
 * list does not close, and each help line is an ordinary item that a screen
 * reader reads as you arrow onto it.
 */
function toggleHelp(): void {
	if (!session) { return; }
	const { quickPick } = session;

	if (!session.helpMode) {
		// Remember where we were so we can come back to the exact same place.
		const active = quickPick.activeItems[0];
		session.beforeHelp = {
			node: isWidgetItem(active) ? active.node : undefined,
			filter: quickPick.value,
		};
		session.helpMode = true;
		quickPick.title = vscode.l10n.t("Help");
		// An active filter would hide the help lines, so we clear it.
		quickPick.value = "";
		quickPick.items = buildHelpItems();
		return;
	}

	session.helpMode = false;
	// Back to no title at all: see the note where the QuickPick is created.
	quickPick.title = undefined;
	quickPick.items = buildItems(
		session.roots,
		session.editor.document,
		session.collapsed,
		session.separator,
	);
	quickPick.value = session.beforeHelp?.filter ?? "";
	if (session.beforeHelp?.node) { setActive(session.beforeHelp.node); }
	session.beforeHelp = undefined;
}
