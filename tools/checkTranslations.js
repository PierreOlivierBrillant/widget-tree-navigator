/**
 * tools/checkTranslations.js
 * ==========================
 *
 * Makes the bilingual rule enforceable instead of merely aspirational.
 *
 * It checks that:
 *   - every `vscode.l10n.t("…")` string in `src/` has a French translation in
 *     `l10n/bundle.l10n.fr.json`, and that the bundle has no leftover keys;
 *   - every `%placeholder%` used in `package.json` exists in both
 *     `package.nls.json` and `package.nls.fr.json`.
 *
 *   npm run check-l10n
 *
 * Exits with code 1 on the first problem, so it can be wired into a hook or CI.
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const problems = [];

function readJson(relative) {
	return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

// --- 1. Runtime strings -----------------------------------------------------

// Matches vscode.l10n.t("…") and captures the string, honouring \" escapes.
const CALL_REGEX = /vscode\.l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g;

const usedStrings = new Set();
for (const file of fs.readdirSync(path.join(root, "src"))) {
	if (!file.endsWith(".ts")) { continue; }
	const source = fs.readFileSync(path.join(root, "src", file), "utf8");
	let m;
	while ((m = CALL_REGEX.exec(source)) !== null) {
		// Turn the TypeScript literal back into the actual string value.
		usedStrings.add(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
	}
}

const frBundle = readJson("l10n/bundle.l10n.fr.json");

for (const text of usedStrings) {
	if (!(text in frBundle)) {
		problems.push(`missing French translation for: ${JSON.stringify(text)}`);
	}
}
for (const key of Object.keys(frBundle)) {
	if (!usedStrings.has(key)) {
		problems.push(`unused key in bundle.l10n.fr.json: ${JSON.stringify(key)}`);
	}
}

// --- 2. Manifest strings ----------------------------------------------------

const manifest = fs.readFileSync(path.join(root, "package.json"), "utf8");
const placeholders = new Set(
	[...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]),
);

const nlsEn = readJson("package.nls.json");
const nlsFr = readJson("package.nls.fr.json");

for (const key of placeholders) {
	if (!(key in nlsEn)) { problems.push(`missing key in package.nls.json: ${key}`); }
	if (!(key in nlsFr)) { problems.push(`missing key in package.nls.fr.json: ${key}`); }
}
for (const key of Object.keys(nlsEn)) {
	if (!placeholders.has(key)) { problems.push(`unused key in package.nls.json: ${key}`); }
}
for (const key of Object.keys(nlsFr)) {
	if (!placeholders.has(key)) { problems.push(`unused key in package.nls.fr.json: ${key}`); }
}

// --- Report -----------------------------------------------------------------

if (problems.length > 0) {
	console.error(`${problems.length} translation problem(s):\n`);
	for (const problem of problems) { console.error(`  - ${problem}`); }
	process.exit(1);
}

console.log(`OK: ${usedStrings.size} runtime string(s) and ${placeholders.size} manifest key(s) translated.`);
