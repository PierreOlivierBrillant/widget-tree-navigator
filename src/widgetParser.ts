/**
 * widgetParser.ts
 * ===============
 *
 * Builds the widget tree of a Dart file from its raw text.
 *
 * WHY A HAND-WRITTEN PARSER?
 * The Dart analysis server already computes this tree and sends it to the
 * official Dart extension through the `dart/textDocument/publishFlutterOutline`
 * LSP notification. BUT that data is not exposed to third-party extensions: the
 * public Dart-Code API (`PublicDartExtensionApi`, version 3) only offers
 * `getOutline()`, which returns the *Dart* outline (declarations only). The
 * internal path (`exports._privateApi.fileTracker.onFlutterOutline`) is only
 * wired up when Dart-Code runs in test mode. See README.md, "Why a hand-written
 * parser".
 *
 * SO: we read the text ourselves. This file does not understand Dart, it does
 * pattern recognition:
 *
 *     an identifier starting with a capital letter, immediately followed by an
 *     opening parenthesis  =  a constructor call
 *
 * and it derives the hierarchy from parenthesis nesting.
 *
 * The work happens in four steps, in this order:
 *
 *   1. maskStringsAndComments() — replace the contents of strings and comments
 *      with spaces, without changing the length of the text. Everything else
 *      then works on that masked text, free of traps, and offsets stay valid.
 *   2. findWidgetMembers() — locate the members of the file that build widgets
 *      (`Widget _buildButtons() { … }`).
 *   3. the scanner — builds the tree, and creates a node whenever it meets a
 *      call to one of those members.
 *   4. graft() — the body of `_buildButtons()` is copied UNDER its call site, so
 *      that the displayed tree matches the real user interface.
 */

/** A node of the widget tree. */
export interface WidgetNode {
	/** The name as written in the code: "Padding", "Image.asset", "_buildButtons()". */
	name: string;
	/** Offset (in characters from the start of the file) of the first character of the name. */
	offset: number;
	/** Widgets nested directly inside this one, in document order. */
	children: WidgetNode[];
	/**
	 * If this node is a call to a helper member of the file, its name (without
	 * parentheses). Only used by the graft step; irrelevant afterwards.
	 */
	member?: string;
}

// ---------------------------------------------------------------------------
// THE LISTS TO MAINTAIN
// ---------------------------------------------------------------------------

/**
 * Classes that start with a capital letter and are called like a constructor,
 * but are NOT widgets. Without this list, `Padding(padding: EdgeInsets.all(8),
 * ...)` would show a spurious widget.
 *
 * TO ADD ONE: just write its name in the list, alphabetically if possible. You
 * can also add names without touching the code, through the
 * `flutterWidgetNav.excludedClasses` setting.
 *
 * Note: calls such as `EdgeInsets.all(...)` or `Theme.of(...)` are already
 * filtered by the named-constructor rule (see NAMED_CONSTRUCTORS). This list is
 * for direct calls: `TextStyle(...)`, `Duration(...)`.
 */
const NON_WIDGET_CLASSES = new Set<string>([
	// Layout and geometry
	"Alignment", "AlignmentDirectional", "BorderRadius", "Border", "BorderSide",
	"BoxConstraints", "BoxDecoration", "BoxShadow", "Color", "ColorFilter",
	"EdgeInsets", "EdgeInsetsDirectional", "Gradient", "LinearGradient",
	"Matrix4", "Offset", "Radius", "Rect", "RoundedRectangleBorder", "Shadow",
	"Size", "StadiumBorder", "TextStyle", "UnderlineInputBorder",
	// Themes and styles
	"AppBarTheme", "ButtonStyle", "ColorScheme", "IconThemeData",
	"InputDecoration", "MaterialStateProperty", "TextTheme", "ThemeData",
	"WidgetStateProperty", "WidgetStatePropertyAll",
	// Controllers, keys, animations
	"AlwaysStoppedAnimation", "AnimationController", "CurvedAnimation",
	"GlobalKey", "Key", "ObjectKey", "PageController", "ScrollController",
	"TextEditingController", "Tween", "UniqueKey", "ValueKey", "ValueNotifier",
	// Common standard-library types
	"DateTime", "Duration", "Exception", "Future", "List", "Map",
	"MaterialPageRoute", "Random", "RegExp", "Set", "StateError", "Stream",
	"String", "Timer", "Uri",
]);

/**
 * Name endings that give away a class which is not a widget.
 *
 * This mainly covers one very frequent case: `createState() => _MyPageState();`
 * would otherwise show `_MyPageState` as a top-level widget in every stateful
 * widget. No common Flutter widget ends in "State".
 *
 * If this ever hides something you wanted to see, just empty the list:
 * `const NON_WIDGET_SUFFIXES: string[] = [];`
 */
const NON_WIDGET_SUFFIXES: string[] = ["State"];

/**
 * Named constructors (`Class.member(...)`) accepted as widgets.
 *
 * This is an ALLOW list rather than a deny list, because the `Class.member(...)`
 * shape is overwhelmingly used for things other than building a widget:
 * `Theme.of(context)`, `Navigator.push(...)`, `EdgeInsets.all(8)`,
 * `BorderRadius.circular(4)`... Accepting everything would add a lot of noise to
 * the list, and noise costs a screen-reader user far more than it costs an eye
 * skimming the page.
 *
 * TO ADD ONE: add the part AFTER the dot. For instance, to accept
 * `MyWidget.compact(...)`, add "compact".
 */
const NAMED_CONSTRUCTORS = new Set<string>([
	"adaptive",   // CircularProgressIndicator.adaptive
	"asset",      // Image.asset
	"builder",    // ListView.builder, GridView.builder, PageView.builder
	"count",      // GridView.count
	"custom",     // ListView.custom
	"expand",     // SizedBox.expand
	"extent",     // GridView.extent
	"file",       // Image.file
	"filled",     // IconButton.filled
	"fromSize",   // SizedBox.fromSize
	"icon",       // ElevatedButton.icon, TextButton.icon
	"memory",     // Image.memory
	"network",    // Image.network
	"outlined",   // IconButton.outlined
	"rich",       // Text.rich
	"separated",  // ListView.separated
	"shrink",     // SizedBox.shrink
	"square",     // SizedBox.square
	"tonal",      // FilledButton.tonal
]);

/**
 * Characters that, right before a class name, mark a constructor DECLARATION
 * rather than a call.
 *
 * `const MyApp({super.key});` has exactly the same shape as a constructor call.
 * What tells them apart is what comes before:
 *   - a declaration follows the end of the previous member: `;`, `}`, or the
 *     opening `{` of the class body;
 *   - a call always follows something else: `(`, `[`, `,`, `:`, `=`, `=>`,
 *     `return`, `const`…
 *
 * Without this rule, every widget of the app would appear once too many in the
 * list, on the line of its constructor.
 */
const TOKENS_BEFORE_DECLARATION = new Set<string>([";", "}", "{"]);

/** Keywords that may precede a call without changing its nature. */
const TRANSPARENT_KEYWORDS = new Set<string>(["const", "new"]);

/**
 * Safety net: maximum number of nodes copied by the graft step. A file where ten
 * methods call each other in a chain could otherwise produce a huge list. 5000
 * is far beyond any reasonable file.
 */
const GRAFT_BUDGET = 5000;

// ---------------------------------------------------------------------------
// STEP 1 — masking strings and comments
// ---------------------------------------------------------------------------

/**
 * Returns a copy of the text, of the SAME LENGTH, in which the contents of
 * strings and comments are replaced by spaces.
 *
 * Keeping the length identical is essential: every offset computed afterwards
 * still points at the right place in the real file. Newlines are preserved,
 * which makes the result readable if you ever need to debug it.
 */
export function maskStringsAndComments(text: string): string {
	const output = text.split("");
	const n = text.length;

	const blank = (start: number, end: number): void => {
		for (let k = start; k < end && k < n; k++) {
			if (output[k] !== "\n") { output[k] = " "; }
		}
	};

	let i = 0;
	while (i < n) {
		const c = text[i];

		// Line comment.
		if (c === "/" && text[i + 1] === "/") {
			let j = i;
			while (j < n && text[j] !== "\n") { j++; }
			blank(i, j);
			i = j;
			continue;
		}

		// Block comment (Dart allows nesting: /* /* */ */).
		if (c === "/" && text[i + 1] === "*") {
			let level = 1;
			let j = i + 2;
			while (j < n && level > 0) {
				if (text[j] === "/" && text[j + 1] === "*") { level++; j += 2; }
				else if (text[j] === "*" && text[j + 1] === "/") { level--; j += 2; }
				else { j++; }
			}
			blank(i, j);
			i = j;
			continue;
		}

		// String literal: single, double, triple, or raw (r'...').
		// The quotes themselves are blanked too: nothing downstream needs them.
		if (c === '"' || c === "'") {
			const end = skipString(text, i);
			blank(i, end);
			i = end;
			continue;
		}

		i++;
	}

	return output.join("");
}

// ---------------------------------------------------------------------------
// STEP 2 — finding the members that build widgets
// ---------------------------------------------------------------------------

/** A method or getter of the file whose return type is a widget. */
interface WidgetMember {
	name: string;
	/** Offset of the name in the DECLARATION, so we never mistake it for a call. */
	nameOffset: number;
	/** Start and end of the body, to know which widgets belong to it. */
	bodyStart: number;
	bodyEnd: number;
	/** true for `Widget get header => …` (referenced without parentheses). */
	isGetter: boolean;
}

/**
 * Recognizes:
 *   Widget _buildButtons() { … }
 *   Widget _card(String title) => …
 *   List<Widget> _cards() { … }
 *   PreferredSizeWidget _bar() { … }
 *   Widget get header => …
 *
 * The trailing `(?=…)` is a lookahead: it matches without consuming, so the end
 * of the captured text is exactly the end of the member name.
 */
const WIDGET_MEMBER_REGEX =
	/(?:List\s*<\s*Widget\s*>|PreferredSizeWidget|Widget)\??\s+(get\s+)?([A-Za-z_$][\w$]*)(?=\s*(?:\(|=>|\{))/g;

function findWidgetMembers(masked: string): Map<string, WidgetMember> {
	const members = new Map<string, WidgetMember>();
	/**
	 * Names declared more than once in the file — typically `build`, present in
	 * every class. We drop them: nothing in the plain text tells which
	 * declaration a given call refers to, and a wrong graft would produce a wrong
	 * tree, which is worse than no tree at all.
	 */
	const ambiguous = new Set<string>();

	WIDGET_MEMBER_REGEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = WIDGET_MEMBER_REGEX.exec(masked)) !== null) {
		const isGetter = m[1] !== undefined;
		const name = m[2];
		const nameOffset = m.index + m[0].length - name.length;

		// `Widget Function(BuildContext) builder` is not a member.
		if (name === "Function" || ambiguous.has(name)) { continue; }

		if (members.has(name)) {
			members.delete(name);
			ambiguous.add(name);
			continue;
		}

		// Skip the parameter list, if any, to find the body.
		let after = skipWhitespace(masked, m.index + m[0].length);
		if (masked[after] === "(") {
			after = skipWhitespace(masked, findEndOfParentheses(masked, after));
		}

		// The body starts at `{` or at `=>`. Anything else (`;`) means no body.
		if (masked[after] !== "{" && !(masked[after] === "=" && masked[after + 1] === ">")) {
			continue;
		}

		members.set(name, {
			name,
			nameOffset,
			bodyStart: after,
			bodyEnd: findEndOfBody(masked, after),
			isGetter,
		});
	}

	return members;
}

// ---------------------------------------------------------------------------
// STEP 3 — the scanner
// ---------------------------------------------------------------------------

/**
 * Reads `text` and returns the top-level widgets, each carrying its children.
 * The WHOLE file is scanned, not just `build()` methods.
 *
 * @param extraExcludedClasses class names added by the user through settings.
 */
export function parseWidgets(text: string, extraExcludedClasses: readonly string[] = []): WidgetNode[] {
	const excluded = new Set([...NON_WIDGET_CLASSES, ...extraExcludedClasses]);
	const masked = maskStringsAndComments(text);
	const members = findWidgetMembers(masked);

	/** Members actually called somewhere: only those get grafted. */
	const calledMembers = new Set<string>();

	const roots: WidgetNode[] = [];

	/**
	 * Widgets currently "open": those whose opening parenthesis we have seen but
	 * not the closing one. The last one on the stack is the parent of any new
	 * widget. `depth` records the nesting level right after the node opened, so
	 * we know when to close it.
	 */
	const stack: Array<{ node: WidgetNode; depth: number }> = [];

	/** Attaches a node to the nearest open widget, or to the root. */
	const attach = (node: WidgetNode): void => {
		const parent = stack[stack.length - 1];
		if (parent) { parent.node.children.push(node); } else { roots.push(node); }
	};

	/** Current nesting level, counting parentheses, brackets and braces alike. */
	let depth = 0;

	/**
	 * A name we spotted that is waiting for its opening parenthesis. Filled in
	 * when we recognize `Padding` in `Padding(`, consumed on the next character.
	 */
	let pending: { name: string; offset: number; member?: string } | undefined;

	/**
	 * Last significant item seen (a character, or an identifier), ignoring
	 * whitespace. Used to tell a declaration from a call.
	 */
	let lastToken = "";

	let i = 0;
	const n = masked.length;

	while (i < n) {
		const c = masked[i];

		// --- Opening a block ----------------------------------------------------
		if (c === "(" || c === "[" || c === "{") {
			depth++;
			// If a widget name was waiting for its parenthesis, this is it.
			if (pending && c === "(") {
				const node: WidgetNode = {
					name: pending.name,
					offset: pending.offset,
					children: [],
					member: pending.member,
				};
				attach(node);
				stack.push({ node, depth });
			}
			pending = undefined;
			lastToken = c;
			i++;
			continue;
		}

		// --- Closing a block ----------------------------------------------------
		if (c === ")" || c === "]" || c === "}") {
			depth--;
			// Close every widget whose block just ended.
			while (stack.length > 0 && stack[stack.length - 1].depth > depth) {
				stack.pop();
			}
			pending = undefined;
			lastToken = c;
			i++;
			continue;
		}

		// --- Identifier ---------------------------------------------------------
		if (isIdentifierStart(c)) {
			const start = i;
			while (i < n && isIdentifierPart(masked[i])) { i++; }
			const name = masked.slice(start, i);
			const j = skipWhitespace(masked, i);

			// (a) Call to a helper member of the file: `_buildButtons()`.
			const member = members.get(name);
			const isOwnDeclaration = member !== undefined && member.nameOffset === start;
			if (member && !isOwnDeclaration) {
				if (masked[j] === "(") {
					// The node is created when we reach the parenthesis.
					pending = { name: `${name}()`, offset: start, member: name };
					calledMembers.add(name);
					i = j;
				} else if (member.isGetter) {
					// `Widget get header` is used without parentheses, so the node is
					// created right away: it has no arguments that could contain
					// other widgets.
					attach({ name, offset: start, children: [], member: name });
					calledMembers.add(name);
					pending = undefined;
				} else {
					pending = undefined;
				}
				lastToken = name;
				continue;
			}

			// (b) Constructor call: `Padding(`, `Image.asset(`.
			let lookahead = j;
			let fullName = name;
			let accepted = startsWithCapital(name)
				&& !excluded.has(name)
				&& !hasExcludedSuffix(name)
				&& !TOKENS_BEFORE_DECLARATION.has(lastToken);

			if (masked[lookahead] === ".") {
				const afterDot = skipWhitespace(masked, lookahead + 1);
				let k = afterDot;
				while (k < n && isIdentifierPart(masked[k])) { k++; }
				const calledMember = masked.slice(afterDot, k);
				const next = skipWhitespace(masked, k);
				if (calledMember.length > 0 && masked[next] === "(") {
					// `Class.member(` shape: only accepted when `member` is a known
					// named constructor (otherwise it is Theme.of, EdgeInsets.all…).
					accepted = accepted && NAMED_CONSTRUCTORS.has(calledMember);
					fullName = `${name}.${calledMember}`;
					lookahead = next;
				} else {
					// `Class.field` without a call, or an unrecognized `Class.method`:
					// not a widget.
					accepted = false;
				}
			}

			// `const` and `new` are transparent: in `child: const Text(...)`, what
			// matters for the declaration/call rule is the `:`, not the `const`.
			if (!TRANSPARENT_KEYWORDS.has(name)) {
				lastToken = name;
			}

			if (accepted && masked[lookahead] === "(") {
				pending = { name: fullName, offset: start };
				i = lookahead; // move onto the parenthesis, handled on the next pass
			} else {
				pending = undefined;
			}
			continue;
		}

		// --- Everything else: commas, operators, whitespace… ---------------------
		// Whitespace does not break the pending name (`Padding (` is still valid),
		// anything else does.
		if (!isWhitespace(c)) {
			pending = undefined;
			lastToken = c;
		}
		i++;
	}

	return graft(roots, members, calledMembers);
}

// ---------------------------------------------------------------------------
// STEP 4 — grafting helper members
// ---------------------------------------------------------------------------

/**
 * Copies the tree produced by each helper member UNDER its call site.
 *
 * Without this step, `child: _buildButtons()` would be a leaf, and the `Row(...)`
 * that the method returns would show up on its own at the end of the list,
 * disconnected from where it actually appears on screen. Splitting a `build()`
 * into small methods is the good practice we teach, so the tree has to keep
 * mirroring the user interface.
 *
 * A method called twice has its subtree copied at both places (offsets then
 * point twice at the same code, which is correct). A method that is never called
 * keeps its tree at the root, as before. A method that would call itself is
 * expanded only once.
 */
function graft(
	roots: WidgetNode[],
	members: Map<string, WidgetMember>,
	calledMembers: ReadonlySet<string>,
): WidgetNode[] {
	// Which root trees live inside the body of which member?
	const treesByMember = new Map<string, WidgetNode[]>();
	const moved = new Set<WidgetNode>();

	for (const name of calledMembers) {
		const member = members.get(name);
		if (!member) { continue; }
		const inside = roots.filter((r) => r.offset >= member.bodyStart && r.offset < member.bodyEnd);
		if (inside.length > 0) {
			treesByMember.set(name, inside);
			for (const tree of inside) { moved.add(tree); }
		}
	}

	const budget = { left: GRAFT_BUDGET };
	const inProgress = new Set<string>();

	const expand = (node: WidgetNode): void => {
		for (const child of node.children) { expand(child); }

		const name = node.member;
		if (!name || inProgress.has(name)) { return; }
		const trees = treesByMember.get(name);
		if (!trees) { return; }

		inProgress.add(name);
		for (const tree of trees) {
			const copy = clone(tree, budget);
			if (!copy) { break; } // budget exhausted
			node.children.push(copy);
			expand(copy);
		}
		inProgress.delete(name);
	};

	// Moved trees leave the root level; the others stay in place.
	const remaining = roots.filter((r) => !moved.has(r));
	for (const root of remaining) { expand(root); }
	return remaining;
}

/** Deep copy of a subtree, within the budget. */
function clone(node: WidgetNode, budget: { left: number }): WidgetNode | undefined {
	if (budget.left <= 0) { return undefined; }
	budget.left--;

	const copy: WidgetNode = { name: node.name, offset: node.offset, children: [], member: node.member };
	for (const child of node.children) {
		const childCopy = clone(child, budget);
		if (!childCopy) { break; }
		copy.children.push(childCopy);
	}
	return copy;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Skips a Dart string literal starting at `start` and returns the position right
 * after it. Handles single and double quotes, triple-quoted strings ('''…'''),
 * and escapes (\' \\ …).
 *
 * Known limitation: a string whose interpolation contains a quote of its own,
 * such as `'${map['key']}'`, will be cut in the wrong place. This is rare, and
 * the only consequence is that one or two widgets may be missing in that file.
 */
function skipString(text: string, start: number): number {
	const quote = text[start];
	const n = text.length;
	const triple = text[start + 1] === quote && text[start + 2] === quote;
	const closing = triple ? quote.repeat(3) : quote;
	let i = start + closing.length;

	while (i < n) {
		if (text[i] === "\\") { i += 2; continue; }          // escape
		if (text.startsWith(closing, i)) { return i + closing.length; }
		// A single-quoted string cannot contain a newline: if we find one, we got
		// lost somewhere, so we stop here rather than swallow the rest of the file.
		if (!triple && text[i] === "\n") { return i; }
		i++;
	}
	return n;
}

/** From an opening parenthesis, returns the position right after its match. */
function findEndOfParentheses(masked: string, start: number): number {
	let depth = 0;
	for (let i = start; i < masked.length; i++) {
		const c = masked[i];
		if (c === "(") { depth++; }
		else if (c === ")") { depth--; if (depth === 0) { return i + 1; } }
	}
	return masked.length;
}

/**
 * From the start of a member body (`{` or `=>`), returns its end position: the
 * matching closing brace, or the semicolon that ends the expression for an
 * arrow body.
 */
function findEndOfBody(masked: string, start: number): number {
	const n = masked.length;

	if (masked[start] === "{") {
		let depth = 0;
		for (let i = start; i < n; i++) {
			const c = masked[i];
			if (c === "{") { depth++; }
			else if (c === "}") { depth--; if (depth === 0) { return i + 1; } }
		}
		return n;
	}

	let depth = 0;
	for (let i = start; i < n; i++) {
		const c = masked[i];
		if (c === "(" || c === "[" || c === "{") { depth++; }
		else if (c === ")" || c === "]" || c === "}") { depth--; }
		else if (c === ";" && depth === 0) { return i + 1; }
	}
	return n;
}

function skipWhitespace(text: string, i: number): number {
	while (i < text.length && isWhitespace(text[i])) { i++; }
	return i;
}

function isWhitespace(c: string): boolean {
	return c === " " || c === "\t" || c === "\r" || c === "\n";
}

function isIdentifierStart(c: string): boolean {
	return /[A-Za-z_$]/.test(c);
}

function isIdentifierPart(c: string): boolean {
	return /[A-Za-z0-9_$]/.test(c);
}

/**
 * True for `Padding` and for `_MyWidget` (private Dart classes start with an
 * underscore). False for `padding` or `child`.
 */
function startsWithCapital(name: string): boolean {
	const withoutUnderscore = name.replace(/^_+/, "");
	return withoutUnderscore.length > 0 && withoutUnderscore[0] === withoutUnderscore[0].toUpperCase()
		&& /[A-Za-z]/.test(withoutUnderscore[0]);
}

function hasExcludedSuffix(name: string): boolean {
	return NON_WIDGET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Counts every node in the tree (used for informational messages). */
export function countNodes(nodes: readonly WidgetNode[]): number {
	let total = 0;
	for (const node of nodes) {
		total += 1 + countNodes(node.children);
	}
	return total;
}
