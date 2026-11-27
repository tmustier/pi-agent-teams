import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomic } from "../extensions/teams/atomic-write.js";

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-atomic-write-"));
const file = path.join(dir, "config.json");
const platform = Object.getOwnPropertyDescriptor(process, "platform");
assert(platform);
const rename = fs.promises.rename;

try {
	await fsp.writeFile(file, '{"before":true}\n', "utf8");
	const fd = fs.openSync(file, "r");
	try {
		await writeJsonAtomic(file, { after: true });
		assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { after: true });
	} finally {
		fs.closeSync(fd);
	}
	console.log(`native atomic replacement passed (${process.platform})`);

	// Node normally opens files with delete sharing, so an open read descriptor
	// alone does not reliably cause a Windows sharing violation. Inject the OS
	// errors to exercise retries on every CI platform, while retaining real writes.
	Object.defineProperty(process, "platform", { value: "win32" });
	const transientCodes = ["EPERM", "EACCES", "EBUSY"];
	let attempts = 0;
	fs.promises.rename = async (source, destination) => {
		const code = transientCodes[attempts++];
		if (code) throw Object.assign(new Error(code), { code });
		await rename(source, destination);
	};
	await writeJsonAtomic(file, { retried: true });
	assert.equal(attempts, 4);
	assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { retried: true });
	assert.deepEqual(await fsp.readdir(dir), ["config.json"]);
	console.log("Windows sharing violations retry and preserve the atomic replacement");

	// An access error on POSIX, and a permanent error on Windows, must not retry.
	for (const [platformName, code] of [["linux", "EACCES"], ["win32", "ENOENT"]]) {
		Object.defineProperty(process, "platform", { value: platformName });
		const failure = Object.assign(new Error(code), { code });
		attempts = 0;
		fs.promises.rename = async () => {
			attempts++;
			throw failure;
		};
		await assert.rejects(writeJsonAtomic(file, { mustNotReplace: true }), (error) => error === failure);
		assert.equal(attempts, 1);
		assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { retried: true });
		assert.deepEqual(await fsp.readdir(dir), ["config.json"]);
	}
	console.log("non-retryable failures preserve the destination and remove temporary files");

	Object.defineProperty(process, "platform", { value: "win32" });
	const busy = Object.assign(new Error("destination still busy"), { code: "EBUSY" });
	attempts = 0;
	fs.promises.rename = async () => {
		attempts++;
		throw busy;
	};
	await assert.rejects(writeJsonAtomic(file, { mustNotReplace: true }), (error) => error === busy);
	assert(attempts > 1, "transient failures should retry before giving up");
	assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { retried: true });
	assert.deepEqual(await fsp.readdir(dir), ["config.json"]);
	console.log("exhausted Windows retries preserve the destination and remove temporary files");
} finally {
	fs.promises.rename = rename;
	Object.defineProperty(process, "platform", platform);
	await fsp.rm(dir, { recursive: true, force: true });
}
