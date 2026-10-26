import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: source, encoding: "utf8" }).trim();
const prefix = relative(root, source).replaceAll("\\", "/");
if (!prefix) throw new Error("This is a generated release mirror; edit and export the canonical source package instead");
const index = process.argv.indexOf("--destination");
if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node scripts/export-release.mjs --destination CHECKOUT [--replace-generated]");
const target = resolve(process.argv[index + 1]);
if (!lstatSync(resolve(target, ".git")).isDirectory()) throw new Error("Destination must be a dedicated release Git checkout");
const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: target, encoding: "utf8" }).trim();
if (!/^(?:git@github\.com:|https:\/\/github\.com\/)petercjl\/sealwork-dongxuan-tools(?:\.git)?$/.test(origin)) throw new Error("Unexpected release repository");
if (execFileSync("git", ["status", "--porcelain", "--", prefix], { cwd: root, encoding: "utf8" }).trim()) throw new Error("Commit canonical package changes before exporting");
const names = readdirSync(target).filter(name => name !== ".git");
if (names.length) {
  if (!process.argv.includes("--replace-generated")) throw new Error("Destination contains files; preserve them or explicitly replace a verified generated checkout");
  const marker = JSON.parse(readFileSync(resolve(target, ".canonical-source.json"), "utf8"));
  if (marker.generated !== true || marker.package !== "@petercjl/sealwork-dongxuan-tools") throw new Error("Destination is not a generated release mirror");
  if (execFileSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }).trim()) throw new Error("Preserve release checkout changes before replacing them");
  const ignored = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard"], { cwd: target, encoding: "utf8" }).split("\n").filter(Boolean);
  if (ignored.some(path => !path.startsWith("node_modules/"))) throw new Error("Preserve user-owned ignored files before replacing this checkout");
  for (const name of names.filter(name => name !== "node_modules")) { const path = resolve(target, name); lstatSync(path); rmSync(path, { recursive: true }); }
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const tree = execFileSync("git", ["rev-parse", `HEAD:${prefix}`], { cwd: root, encoding: "utf8" }).trim();
const archive = execFileSync("git", ["archive", `HEAD:${prefix}`], { cwd: root });
execFileSync("tar", ["-x", "-C", target], { input: archive });
writeFileSync(resolve(target, ".canonical-source.json"), JSON.stringify({ generated: true,
  package: "@petercjl/sealwork-dongxuan-tools", repository: "https://gitee.com/xc-sealseek-ai/sealcraft",
  sourceDirectory: prefix, commit, tree }, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ok: true, commit, tree, destination: target }));
