import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "sealwork.plugin.json"), "utf8"));
assert.equal(pkg.name, "@petercjl/sealwork-dongxuan-tools");
assert.equal(pkg.type, "module");
assert.equal(manifest.apiVersion, 1);
assert.deepEqual(manifest.tools, ["package_maintenance"]);
for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) assert.equal(Object.keys(pkg[field] ?? {}).length, 0);
const entry = await realpath(resolve(root, manifest.entry));
assert.ok(!relative(root, entry).startsWith(".."));
const definition = (await import(pathToFileURL(entry).href)).default;
assert.equal(definition.id, manifest.id); assert.equal(typeof definition.setup, "function");
const source = await readFile(entry, "utf8");
assert.ok(!/\/Users\/|[A-Z]:\\Users\\/.test(source), "Public artifact contains a private machine path");
// Exercise the packed entry's registration, validation and cleanup without
// shell/network access. Host integration runs remain separate evidence.
const values = new Map(), registrations = new Set();
const registered = new Map(["shell", "read", "skill"].map(name => [name, { name, description: name,
  execute: async () => { throw new Error("Unexpected native execution during package check"); } }]));
const registration = () => { const item = { async dispose() { registrations.delete(item); } }; registrations.add(item); return item; };
const cleanup = await definition.setup({ options: { ownDirectory: resolve(root, "fixture-skills") },
  storage: { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } },
  session: { hook: async () => registration() },
  tool: { hook: async () => registration(), transform: async callback => {
    callback({ get: id => registered.get(id), add: tool => registered.set(tool.name, tool), update: (id, update) => update(registered.get(id)) });
    return registration();
  } },
});
assert.equal(typeof registered.get("package_maintenance")?.execute, "function");
await assert.rejects(() => registered.get("package_maintenance").execute({ action: "invalid" }, { sessionID: "package-check" }));
assert.equal(typeof cleanup, "function"); await cleanup(); assert.equal(registrations.size, 0);
console.log(JSON.stringify({ ok: true, package: pkg.name, version: pkg.version, apiVersion: manifest.apiVersion, bundled: true }));
