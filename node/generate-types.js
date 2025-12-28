import {compileFromFile} from "json-schema-to-typescript";
import {readFile, writeFile, mkdir} from "fs/promises";
import {glob} from "glob";
import path from "path";
import {fileURLToPath} from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCHEMA_DIR = "schema/site";
const OUT_DIR = "types";

// Skip entry.json - has manual .d.ts due to recursive nature
const SKIP_FILES = new Set(["entry.json"]);

// Files that ref entry.json (directly or via util.json) - causes infinite recursion
// These need manual type definitions
const refCache = new Map();

async function refsEntryJsonTransitive (schemaPath, visited = new Set()) {
	if (refCache.has(schemaPath)) return refCache.get(schemaPath);
	if (visited.has(schemaPath)) return false;
	visited.add(schemaPath);

	let content;
	try {
		content = await readFile(schemaPath, "utf8");
	} catch {
		return false;
	}

	// Direct ref to entry.json
	if (content.includes('"entry.json#')) {
		refCache.set(schemaPath, true);
		return true;
	}

	// Check refs to other local files
	const refMatches = content.matchAll(/"(\$ref)":\s*"([^"#]+\.json)/g);
	for (const match of refMatches) {
		const refFile = match[2];
		if (refFile.startsWith("http")) continue;
		const refPath = path.resolve(path.dirname(schemaPath), refFile);
		if (await refsEntryJsonTransitive(refPath, visited)) {
			refCache.set(schemaPath, true);
			return true;
		}
	}

	refCache.set(schemaPath, false);
	return false;
}

async function compileSchema (schemaPath, outPath) {
	const ts = await compileFromFile(schemaPath, {
		cwd: path.dirname(schemaPath),
		declareExternallyReferenced: false,
		bannerComment: "",
		unreachableDefinitions: true,
		maxItems: 20,
	});
	await mkdir(path.dirname(outPath), {recursive: true});
	await writeFile(outPath, ts);
}

const schemas = await glob(`${SCHEMA_DIR}/**/*.json`, {cwd: ROOT});

await mkdir(path.join(ROOT, OUT_DIR), {recursive: true});

let success = 0;
let skipped = 0;
let failed = 0;
const failedSchemas = [];
const skippedSchemas = [];

for (const schemaRel of schemas) {
	const schemaPath = path.join(ROOT, schemaRel);
	const relativePath = path.relative(path.join(ROOT, SCHEMA_DIR), schemaPath);
	const outPath = path.join(ROOT, OUT_DIR, relativePath.replace(/\.json$/, ".d.ts"));
	const fileName = path.basename(schemaPath);

	if (SKIP_FILES.has(fileName)) {
		console.log(`⊘ ${relativePath} (manual)`);
		skipped++;
		continue;
	}

	// Skip schemas that ref entry.json (directly or transitively) - they cause infinite recursion
	if (await refsEntryJsonTransitive(schemaPath)) {
		console.log(`⊘ ${relativePath} (refs entry.json)`);
		skippedSchemas.push(relativePath);
		skipped++;
		continue;
	}

	try {
		await compileSchema(schemaPath, outPath);
		console.log(`✓ ${relativePath}`);
		success++;
	} catch (e) {
		console.error(`✗ ${relativePath}: ${e.message}`);
		failedSchemas.push(relativePath);
		failed++;
	}
}

console.log(`\n${success} succeeded, ${skipped} skipped, ${failed} failed. Types in ${OUT_DIR}/`);
if (skippedSchemas.length) {
	console.log(`\nSkipped ${skippedSchemas.length} schemas that reference entry.json`);
}
if (failedSchemas.length) {
	console.log("\nFailed:");
	failedSchemas.forEach(s => console.log(`  - ${s}`));
}
