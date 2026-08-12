import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomic } from "../extensions/teams/atomic-write.js";

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-atomic-write-"));
const file = path.join(dir, "config.json");
await fsp.writeFile(file, '{"before":true}\n', "utf8");

const fd = fs.openSync(file, "r");
const release = setTimeout(() => fs.closeSync(fd), 100);
try {
	await writeJsonAtomic(file, { after: true });
	const result = JSON.parse(await fsp.readFile(file, "utf8")) as { after?: boolean };
	if (result.after !== true) throw new Error("Atomic write produced the wrong content");
	console.log(`atomic rename retry check passed (${process.platform})`);
} finally {
	clearTimeout(release);
	try {
		fs.closeSync(fd);
	} catch {
		// The scheduled release may have closed it already.
	}
	await fsp.rm(dir, { recursive: true, force: true });
}
