import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, lstatSync, renameSync, unlinkSync } from "node:fs";
const version = process.env.RELEASE_VERSION, tag = process.env.DIST_TAG;
assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
assert.match(tag ?? "", /^[a-z][a-z0-9-]*$/);
const name = "@petercjl/sealwork-dongxuan-tools";
function unused(path) {
  try { lstatSync(path); throw new Error(`Preserve existing verification file: ${path}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const base = `https://registry.npmjs.org/${name}/`;
let metadata, lastError;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const results = await Promise.all([version, tag].map(async selector => {
      const response = await fetch(base + selector, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
      assert.ok(response.ok, `Registry metadata is not visible (${response.status})`);
      return response.json();
    }));
    for (const result of results) { assert.equal(result.name, name); assert.equal(result.version, version); }
    assert.equal(results[0].dist.integrity, results[1].dist.integrity);
    assert.ok(results[0].dist.attestations, "Trusted Publishing provenance is not visible yet");
    metadata = results[0]; break;
  } catch (error) { lastError = error; if (attempt < 29) await new Promise(resolve => setTimeout(resolve, 5000)); }
}
if (!metadata) throw lastError;
const url = new URL(metadata.dist.tarball);
assert.equal(url.protocol, "https:"); assert.equal(url.hostname, "registry.npmjs.org");
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
assert.ok(response.ok);
const archive = Buffer.from(await response.arrayBuffer());
assert.ok(archive.length < 50_000_000);
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
assert.equal(integrity, metadata.dist.integrity);
unused("registry-candidate.tgz"); writeFileSync("registry-candidate.tgz", archive, { flag: "wx" });
const part = (file, path) => execFileSync("tar", ["-xOf", file, `package/${path}`], { maxBuffer: 2_000_000 });
const identity = JSON.parse(part("registry-candidate.tgz", "package.json"));
assert.equal(identity.name, name); assert.equal(identity.version, version);
assert.deepEqual(JSON.parse(part("registry-candidate.tgz", "sealwork.plugin.json")), JSON.parse(part("candidate.tgz", "sealwork.plugin.json")));
assert.equal(createHash("sha256").update(part("registry-candidate.tgz", "dist/index.js")).digest("hex"),
  createHash("sha256").update(part("candidate.tgz", "dist/index.js")).digest("hex"), "Public runtime differs from the validated build");
const sameArchive = createHash("sha512").update(readFileSync("candidate.tgz")).digest("base64") === integrity.slice(7);
if (sameArchive) unlinkSync("registry-candidate.tgz");
else { lstatSync("candidate.tgz"); unused("candidate.rebuilt.tgz"); renameSync("candidate.tgz", "candidate.rebuilt.tgz"); renameSync("registry-candidate.tgz", "candidate.tgz"); }
console.log(JSON.stringify({ ok: true, package: name, version, tag, integrity, provenance: true, reusedPublicArtifact: !sameArchive }));
