/**
 * list.ts
 * =======
 *
 * Turns the widget tree into a flat list of QuickPick items.
 *
 * THE CORE ACCESSIBILITY RULE OF THIS FILE:
 * every piece of information lives in the item TEXT. A screen reader announces
 * the label and the description; it announces neither indentation, nor icons,
 * nor chevrons. So: no leading spaces to convey depth. We spell out the level
 * ("L3"), the number of children and the state ("collapsed" / "expanded").
 *
 * All user-facing strings go through `vscode.l10n.t()`. The English text in the
 * source is the key; the French translation lives in `l10n/bundle.l10n.fr.json`.
 * If you change a string here, change the corresponding key over there too.
 *
 * To change what a screen reader reads for a widget, there is a single place to
 * edit: `formatLabel()` at the bottom of this file.
 */

import * as vscode from "vscode";
import { WidgetNode } from "./widgetParser";

/** A list entry, keeping a link back to the node it came from. */
export interface WidgetItem extends vscode.QuickPickItem {
	node: WidgetNode;
	/** Displayed depth, 1 for top-level widgets. */
	level: number;
	/** Line in the document, zero-based (as in the VS Code API). */
	line: number;
}

/** One line of help mode (Alt+F1). */
export interface HelpItem extends vscode.QuickPickItem {
	help: true;
}

/** The QuickPick shows either widgets, or the help lines. */
export type ListItem = WidgetItem | HelpItem;

/** Tells the two apart at runtime (TypeScript uses this to narrow the type). */
export function isWidgetItem(item: ListItem | undefined): item is WidgetItem {
	return item !== undefined && (item as WidgetItem).node !== undefined;
}

/**
 * Buttons shown on items that have children (mouse fallback for folding).
 * Built lazily: `vscode.l10n` is only populated once the extension is active.
 */
function foldButton(collapsed: boolean): vscode.QuickInputButton {
	return collapsed
		? { iconPath: new vscode.ThemeIcon("chevron-right"), tooltip: vscode.l10n.t("Expand (Alt+Right)") }
		: { iconPath: new vscode.ThemeIcon("chevron-down"), tooltip: vscode.l10n.t("Collapse (Alt+Left)") };
}

/**
 * Finds the item to select when the list opens: the widget whose name starts at
 * or before the cursor, as late in the file as possible.
 *
 * Opening on the first item of the file would force a screen-reader user to
 * arrow back down through everything to reach the code they were working on,
 * every single time. So we start where they already are.
 *
 * Note that we cannot simply take the last item of the list: grafted helper
 * methods put their body's offsets out of list order (see `graft()` in
 * widgetParser.ts). Hence the scan over every item.
 */
export function findItemAtOffset(items: readonly WidgetItem[], offset: number): WidgetItem | undefined {
	let best: WidgetItem | undefined;
	for (const item of items) {
		if (item.node.offset > offset) { continue; }
		// Later in the file wins; at equal position, the deeper (more precise) one wins.
		if (!best || item.node.offset > best.node.offset
			|| (item.node.offset === best.node.offset && item.level > best.level)) {
			best = item;
		}
	}
	// Cursor sits before every widget: fall back to the first item.
	return best ?? items[0];
}

/**
 * Flattens the tree in document order. Descendants of a collapsed node are
 * simply absent from the returned list.
 */
export function buildItems(
	roots: readonly WidgetNode[],
	document: vscode.TextDocument,
	collapsed: ReadonlySet<WidgetNode>,
	separator: string,
): WidgetItem[] {
	const items: WidgetItem[] = [];

	const walk = (nodes: readonly WidgetNode[], level: number): void => {
		for (const node of nodes) {
			const line = document.positionAt(node.offset).line;
			const isCollapsed = collapsed.has(node);

			items.push({
				node,
				level,
				line,
				label: formatLabel(node, level, isCollapsed, separator),
				description: vscode.l10n.t("line {0}", line + 1),
				buttons: node.children.length > 0 ? [foldButton(isCollapsed)] : undefined,
			});

			// Only descend when the node is expanded.
			if (!isCollapsed) {
				walk(node.children, level + 1);
			}
		}
	};

	walk(roots, 1);
	return items;
}

/**
 * The lines of help mode (Alt+F1).
 *
 * VS Code does not let an extension feed its accessibility help view (Alt+F1):
 * `vscode.d.ts` exposes neither `ariaLabel` nor any help provider, and the
 * `accessibility.verbosity.*` settings cover no QuickPick. So we rebuild the
 * equivalent inside the list itself: each line is an ordinary item, which a
 * screen reader reads as you arrow onto it.
 *
 * Every line must stand on its own: it is read alone, out of context. The first
 * one explains how to get out, so that it is heard immediately when help opens.
 */
export function buildHelpItems(): HelpItem[] {
	const lines = [
		vscode.l10n.t("Alt+F1 or Enter: go back to the widget list."),
		vscode.l10n.t("Down Arrow or Up Arrow: move from one widget to the next. The editor follows, the cursor does not move."),
		vscode.l10n.t("Type text: filter the list, by widget name or by line number."),
		vscode.l10n.t("Alt+Right: expand the current widget. Nothing happens on a widget without children, as in any tree."),
		vscode.l10n.t("Alt+Left: collapse the current widget, or move up to its parent."),
		vscode.l10n.t("Enter on a widget: put the cursor on it and return to the code."),
		vscode.l10n.t("Escape: close the list without moving anything."),
		vscode.l10n.t("In an item, L2 means depth: level 2 in the widget tree."),
		vscode.l10n.t("An item with children says how many. It says \"collapsed\" only when it is collapsed; an expanded widget says nothing, to keep the reading short."),
		vscode.l10n.t("An item such as _buildButtons() is a method call: its children are the widgets that method builds."),
	];
	return lines.map((line) => ({ help: true, label: line }));
}

/**
 * Builds a "child -> parent" table, used so that Alt+Left on a leaf moves up to
 * the parent widget (the usual behaviour in a tree).
 */
export function buildParentMap(roots: readonly WidgetNode[]): Map<WidgetNode, WidgetNode> {
	const parents = new Map<WidgetNode, WidgetNode>();
	const walk = (node: WidgetNode): void => {
		for (const child of node.children) {
			parents.set(child, node);
			walk(child);
		}
	};
	for (const root of roots) { walk(root); }
	return parents;
}

/**
 * THE text a screen reader reads. Examples produced:
 *
 *   L1 · MaterialApp, 1 child
 *   L2 · Scaffold, 2 children, collapsed
 *   L3 · Padding
 *
 * Note that nothing is said for an expanded widget. Everything starts expanded,
 * so the word would be spoken on almost every item, on every arrow key, while
 * carrying no information until something has actually been collapsed. The state
 * change stays perfectly audible: the word appears, and the children vanish.
 *
 * This, and nowhere else, is where the wording changes.
 */
function formatLabel(node: WidgetNode, level: number, isCollapsed: boolean, separator: string): string {
	// "L" for Level. Translated because a screen reader spells it out loud.
	let label = vscode.l10n.t("L{0}", level) + separator + node.name;

	const count = node.children.length;
	if (count > 0) {
		label += ", " + (count > 1 ? vscode.l10n.t("{0} children", count) : vscode.l10n.t("{0} child", count));
		if (isCollapsed) {
			label += ", " + vscode.l10n.t("collapsed");
		}
	}

	return label;
}
