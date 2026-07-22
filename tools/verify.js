/**
 * tools/verify.js
 * ===============
 *
 * Command-line test bench for the parser, WITHOUT starting VS Code.
 *
 *   npm run verify                        prints the tree of every fixture
 *   npm run verify -- path/to/file.dart   prints the tree of one file
 *   npm run test                          compares the fixtures to their
 *                                         recorded output and fails on any diff
 *   npm run test -- --update              records the current output as the new
 *                                         reference (read the diff first!)
 *
 * The recorded outputs live next to the fixtures, as `<name>.expected.txt`.
 * Any change to the parser shows up there as a reviewable diff, which is the
 * point: a wrong node is worse than a missing one, so every change to the tree
 * has to be looked at on purpose rather than noticed by accident.
 *
 * Output is English only: this is a developer tool, not part of the UI.
 */

const fs = require("fs");
const path = require("path");
const { parseWidgets } = require("../out/widgetParser.js");

const EXAMPLES = path.join(__dirname, "..", "examples");
const FIXTURES = ["counter.dart", "traps.dart"];

/** Renders the tree of one file exactly as the recorded reference stores it. */
function render(file) {
	const text = fs.readFileSync(file, "utf8");
	const roots = parseWidgets(text);

	// Table of line starts, to turn an offset into a line number.
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") { lineStarts.push(i + 1); }
	}
	const lineOf = (offset) => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (lineStarts[mid] <= offset) { low = mid; } else { high = mid - 1; }
		}
		return low + 1;
	};

	const lines = [];
	let total = 0;
	const walk = (nodes, level) => {
		for (const node of nodes) {
			total++;
			const count = node.children.length;
			const suffix = count > 0 ? `, ${count} child${count > 1 ? "ren" : ""}` : "";
			lines.push(`L${level} · ${node.name}${suffix}   [line ${lineOf(node.offset)}]`);
			walk(node.children, level + 1);
		}
	};
	walk(roots, 1);
	lines.push("");
	lines.push(`${total} widget(s) in total.`);
	return lines.join("\n") + "\n";
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const update = args.includes("--update");
const explicitFile = args.find((a) => !a.startsWith("--"));

// --- Print mode -------------------------------------------------------------

if (!check && !update) {
	const files = explicitFile ? [explicitFile] : FIXTURES.map((f) => path.join(EXAMPLES, f));
	for (const file of files) {
		console.log(`File: ${file}\n`);
		console.log(render(file));
	}
	process.exit(0);
}

// --- Check / update mode ----------------------------------------------------

let failures = 0;

for (const fixture of FIXTURES) {
	const source = path.join(EXAMPLES, fixture);
	const reference = path.join(EXAMPLES, `${fixture.replace(/\.dart$/, "")}.expected.txt`);
	const actual = render(source);

	if (update) {
		fs.writeFileSync(reference, actual, "utf8");
		console.log(`recorded ${path.basename(reference)}`);
		continue;
	}

	if (!fs.existsSync(reference)) {
		console.error(`MISSING reference for ${fixture}. Run: npm run test -- --update`);
		failures++;
		continue;
	}

	const expected = fs.readFileSync(reference, "utf8");
	if (actual === expected) {
		console.log(`ok  ${fixture}`);
		continue;
	}

	failures++;
	console.error(`FAIL ${fixture}`);
	const actualLines = actual.split("\n");
	const expectedLines = expected.split("\n");
	for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
		if (actualLines[i] !== expectedLines[i]) {
			if (expectedLines[i] !== undefined) { console.error(`  - expected: ${expectedLines[i]}`); }
			if (actualLines[i] !== undefined) { console.error(`  + actual:   ${actualLines[i]}`); }
		}
	}
}

process.exit(failures > 0 ? 1 : 0);
