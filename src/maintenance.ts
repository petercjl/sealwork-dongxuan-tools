import { z } from "zod";
import { readFile, stat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, dirname } from "node:path";
import { createHash } from "node:crypto";

export type MaintenanceTool = { name?: string; description: string; input?: unknown; options?: { codemode: boolean }; execute(input: unknown, call: unknown): Promise<unknown> };
type Registration = { dispose(): Promise<void> };
type Editor = { get(id: string): MaintenanceTool | undefined; update(id: string, edit: (tool: MaintenanceTool) => void): void; add(tool: MaintenanceTool): void };
type Native = { shell: MaintenanceTool; read: MaintenanceTool; skill: MaintenanceTool; listSkills?: () => Promise<unknown> };
const inputSchema = z.object({
  action: z.enum(["inspect", "apply", "handoff", "verify"]),
  package: z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/),
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+~^*-]*$/).default("latest"),
  targetDirectory: z.string().refine(isAbsolute, "Use an absolute full Skill target directory").optional(),
  reason: z.string().min(1).max(400).optional(),
  verification: z.object({
    skillName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    targetOption: z.string().regex(/^--[a-z][a-z-]*$/),
    targetKind: z.enum(["exact", "parent"]),
  }).strict().optional(),
}).strict();
type Input = z.infer<typeof inputSchema>;
const commandSchema = z.object({ options: z.record(z.string(), z.object({ type: z.string(), required: z.boolean().optional() }).passthrough()).default({}) }).passthrough();
const helpSchema = z.object({ ok: z.literal(true), commands: z.record(z.string(), commandSchema) }).passthrough();
const sourceSchema = z.object({ ok: z.literal(true), name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), source: z.string(), version: z.string().optional() }).passthrough();
const statusSchema = z.object({ ok: z.literal(true), installed: z.boolean(), managed: z.boolean(), up_to_date: z.boolean().optional(),
  version: z.string().optional(), runtime_entry: z.string().optional(), runtime_verified: z.boolean().optional(), edited: z.array(z.string()).optional(),
}).passthrough();
function parseStatus(value: unknown) {
  const receipt = z.object({ current: z.boolean().optional(), up_to_date: z.boolean().optional(),
    edited: z.union([z.boolean(), z.array(z.string())]).optional(), editedFiles: z.array(z.string()).optional(), runtimeCurrent: z.boolean().optional() }).passthrough().parse(value);
  if (receipt.current !== undefined && receipt.up_to_date !== undefined && receipt.current !== receipt.up_to_date) throw new Error("Conflicting Skill synchronization receipts");
  if (receipt.edited === false && receipt.editedFiles?.length) throw new Error("Conflicting managed edit receipts");
  return statusSchema.parse({ ...receipt, up_to_date: receipt.up_to_date ?? receipt.current,
    edited: receipt.editedFiles ?? (receipt.edited === true ? ["Managed edits reported"] : receipt.edited === false ? [] : receipt.edited),
    ...(receipt.runtimeCurrent === false ? { runtime_verified: false } : {}) });
}
const manifestSchema = z.object({ name: z.string(), version: z.string(), bin: z.union([z.string(), z.record(z.string(), z.string())]).optional() }).passthrough();
type Snapshot = { input: Input; root: string; entry?: string; version: string; desired: string; target?: string; skillName?: string;
  commands?: z.infer<typeof helpSchema>["commands"]; skill?: z.infer<typeof statusSchema>; hostVerified?: boolean; complete: boolean;
  operations: string[][]; fallback?: string; backup?: string; fingerprint?: string; needsInspection?: boolean; released?: boolean;
  hostPending?: string; hostAttempts?: number; localFingerprint?: string; contractFingerprint?: string;
  verification?: Input["verification"]; bootstrapEntry?: string; bootstrapVersion?: string;
  failure?: { error: string; fingerprint: string; documents: string[]; observed: Set<string> };
  lastOperation?: Record<string, unknown>; recovery?: { operationId: string; stage: string }; recoveryAttempts?: number };

export function maintenanceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!object(value)) return "";
  if (typeof value.output === "string") return value.output;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return value.content.filter(object).filter(x => x.type === "text").map(x => String(x.text ?? "")).join("\n");
  return "";
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function json(text: string): unknown {
  // Native Shell can append execution metadata; never scrape arbitrary embedded JSON.
  return JSON.parse(text.replace(/\s*<shell_metadata>[\s\S]*?<\/shell_metadata>\s*$/, "").trim());
}
function structuredHelp(text: string) {
  try { return helpSchema.safeParse(json(text)); }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}
export function maintenanceCommand(args: string[], platform = process.platform): string {
  const quote = (s: string) => platform === "win32" ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`;
  return (platform === "win32" ? "& " : "") + args.map(quote).join(" ");
}
function under(root: string, file: string) {
  const r = relative(root, file); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\"));
}
async function sameTarget(left: string, right: string) {
  return (await realpath(left).catch(() => resolve(left))) === (await realpath(right).catch(() => resolve(right)));
}

/** Product orchestration, not a package updater: every command uses the native
 * permission-bearing Shell/Read/Skill tools. Only advertised lifecycle commands
 * are composed. Unsupported contracts return to the caller without mutation. */
export class PackageMaintenance {
  private snapshots = new Map<string, Snapshot>();
  constructor(private native: Native, private ownDirectory: string) {}
  reset(sessionID: string) { this.snapshots.delete(sessionID); }
  completed(sessionID: string) { return this.snapshots.get(sessionID)?.complete === true; }
  private verificationBindings(s: Snapshot) {
    const status = s.commands?.["skill status"];
    if (!s.fallback || !(s.fallback.startsWith("Unsupported automatic contract:") || s.fallback.startsWith("skill source does not provide"))
      || !["none", "read"].includes(String(status?.sideEffects)) || !status?.options["--json"] || !s.commands?.version?.options["--json"]) return [];
    return Object.entries(status.options).filter(([, option]) => option.type === "string" && !option.enum).map(([flag]) => flag);
  }
  summary(sessionID: string) {
    const s = this.snapshots.get(sessionID);
    if (!s) return undefined;
    const verificationBindings = this.verificationBindings(s);
    return { ...this.evidence(s), verificationPending: verificationBindings.length > 0, verificationBindings,
      ownSkillDirectory: this.ownDirectory, package: s.input.package, target: s.target, current: s.version, desired: s.desired, complete: s.complete,
      blocked: !!s.failure && !s.needsInspection && !s.recovery, failure: s.failure ? { error: s.failure.error, documents: s.failure.documents } : undefined,
      hostVerified: s.hostVerified ?? false, hostPending: s.hostPending, fallback: s.fallback, backup: s.backup, released: s.released ?? false,
      next: s.failure && !s.needsInspection && !s.recovery ? this.summaryFromFailure()
        : verificationBindings.length ? "Call action=verify now with verification {skillName, targetOption from verificationBindings, targetKind exact/parent from the supplied option description}. Host facts and help already contain the target binding. Ordinary discovery is unnecessary."
        : s.released ? s.complete ? "Maintenance is complete. Continue only the additional user-requested work using this receipt." : "Reuse this receipt, including registry version and help. Resolve only the reported stage; use action=verify with the documented read-only target binding to close maintenance."
        : s.complete ? "Report this result and finish. No additional Shell, Read, doctor or business Skill execution is needed."
        : s.hostPending && !s.fallback ? "Call package_maintenance action=inspect to retry only native host loading; package and Skill synchronization are verified."
        : s.needsInspection ? "Call package_maintenance action=inspect to refresh only uncertain local state before recovery."
        : s.hostVerified && s.version !== s.desired ? "Installed runtime, synchronized Skill and native host load are verified. Update only if authorized; for a read-only request report the available version difference and finish."
        : s.fallback ? "Reuse known facts; resolve only the reported stage. action=verify can validate an advertised read-only status binding and native host load." : "Call package_maintenance action=apply for the remaining authorized stages." };
  }
  async execute(raw: unknown, call: unknown) {
    let input = inputSchema.parse(raw);
    const { sessionID } = z.object({ sessionID: z.string() }).parse(call);
    let current = this.snapshots.get(sessionID);
    // Continuations often echo the resolved version/target from our receipt.
    // They identify the same admitted task; a new user prompt resets this state.
    if (current?.input.package === input.package) {
      if (object(raw) && raw.version === undefined) input = { ...input, version: current.input.version };
      if (current.input.version === "latest" && input.version === current.desired) input = { ...input, version: current.input.version };
      if (input.action === "verify" && input.verification) {
        const target = current.input.targetDirectory ?? current.target ?? join(this.ownDirectory, input.verification.skillName);
        if (input.targetDirectory && resolve(input.targetDirectory) !== resolve(target)
          && !(input.verification.targetKind === "parent" && resolve(input.targetDirectory) === dirname(resolve(target)))) {
          throw new Error(`Verification retains the inspected full target ${target}. Omit targetDirectory; targetKind controls how the CLI receives that target.`);
        }
        // A continuation may echo the CLI's parent argument. It cannot change
        // the admitted full target or invalidate existing registry evidence.
        input = { ...input, targetDirectory: current.input.targetDirectory };
      }
      if (!current.input.targetDirectory && input.targetDirectory === current.target) input = { ...input, targetDirectory: undefined };
    }
    if (current && (current.input.package !== input.package || current.input.version !== input.version
      || current.input.targetDirectory !== input.targetDirectory)) current = undefined;
    if (input.action === "handoff") {
      if (!current || !input.reason) throw new Error("Inspect first and state the additional user-requested work or unsupported contract requiring ordinary tools.");
      if (this.verificationBindings(current).length) {
        current.released = false;
        return { content: [{ type: "text", text: JSON.stringify({ ...this.summary(sessionID),
          notice: "A read-only completion path is advertised. Complete action=verify before handing off additional work; a failed verification releases diagnostics for its specific unresolved condition." }) }] };
      }
      current.released = !current.failure;
      this.snapshots.set(sessionID, current);
      return { content: [{ type: "text", text: JSON.stringify({ ...this.summary(sessionID), reason: input.reason }) }] };
    }
    if (current?.failure && !current.needsInspection && !current.recovery) {
      if (current.failure.fingerprint === await this.failureFingerprint(current)) return this.result(current, true);
      current.needsInspection = true;
    }
    if (current?.complete && current.fingerprint !== await this.fingerprint(current)) {
      current.complete = false; current.needsInspection = true;
    }
    if (current?.complete) return this.result(current, true);
    if (input.action === "verify" || current?.verification && (current.needsInspection || current.hostPending && current.localFingerprint !== await this.fingerprint(current))) {
      if (!current) throw new Error("Inspect this package first; verification reuses the admitted package and registry evidence.");
      try { await this.verifyFallback(current, input.verification ?? current.verification, call); }
      catch (error) { current.complete = false; current.hostVerified = false; current.fallback = `Read-only verification failed: ${error instanceof Error ? error.message : "Unknown error"}`; }
      this.snapshots.set(sessionID, current);
      return this.result(current, false);
    }
    if (current?.hostPending && !current.fallback && current.localFingerprint === await this.fingerprint(current)) {
      await this.verifyHost(current, call);
    } else if (current?.needsInspection || current?.hostPending && !current.fallback) {
      try { current = await this.refreshLocal(current, call); }
      catch (error) {
        current.fallback = `Local recovery verification failed; use native diagnostics for this stage: ${error instanceof Error ? error.message.slice(-1500) : "Unknown failure"}`;
        if (current.failure) { current.needsInspection = false; current.recovery = undefined; }
        this.snapshots.set(sessionID, current);
        return this.result(current, false);
      }
    }
    else if (!current) current = await this.inspect(input, call);
    this.snapshots.set(sessionID, current);
    if (input.action === "apply" && !current.complete && !current.fallback && !current.hostPending) {
      try { current = await this.apply(current, call); }
      catch (error) {
        // Do not repeat a potentially successful package replacement. The next
        // inspect uses actual version and target receipts to select recovery.
        current.needsInspection = true;
        current.failure = { error: error instanceof Error ? error.message.slice(-2500) : "Lifecycle operation failed",
          fingerprint: await this.failureFingerprint(current), documents: await this.diagnosticDocuments(current), observed: new Set() };
        this.snapshots.set(sessionID, current);
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, stage: "apply", error: error instanceof Error ? error.message : "Lifecycle operation failed",
          operations: current.operations, next: `Call package_maintenance(action=inspect, package=${input.package}, version=${input.version}) to inspect actual state and select only the remaining stage. Do not repeat npm installation blindly.` }) }] };
      }
      this.snapshots.set(sessionID, current);
    }
    return this.result(current, false);
  }
  private result(s: Snapshot, reused: boolean) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: !s.fallback || this.verificationBindings(s).length > 0, ...this.summaryFrom(s), reused,
      operations: s.operations, shellExecutions: s.operations.length,
      contract: s.fallback ? "Maintenance paused at the reported stage; retain verified package and Skill results." : "Advertised structured CLI lifecycle contract",
    }) }] };
  }
  private summaryFrom(s: Snapshot) {
    const verificationBindings = this.verificationBindings(s);
    return { ...this.evidence(s), verificationPending: verificationBindings.length > 0, verificationBindings, ownSkillDirectory: this.ownDirectory,
      package: s.input.package, current: s.version, desired: s.desired, target: s.target, entry: s.entry,
      blocked: !!s.failure && !s.needsInspection && !s.recovery, failure: s.failure ? { error: s.failure.error, documents: s.failure.documents } : undefined,
      complete: s.complete, skillVerified: s.skill?.up_to_date === true && s.skill.managed, hostVerified: s.hostVerified === true,
      hostPending: s.hostPending, fallback: s.fallback, backup: s.backup,
      next: s.failure && !s.needsInspection && !s.recovery ? this.summaryFromFailure()
        : verificationBindings.length ? "Call action=verify with verification {skillName, targetOption from verificationBindings, targetKind exact/parent from supplied help}; reuse ownSkillDirectory and known registry/help. No Shell discovery is needed."
        : s.complete ? "Report the verified result and finish. Do not run extra checks or business workflow."
        : s.hostVerified && s.version !== s.desired ? "Installed runtime, synchronized Skill and native host load are verified. Update only if authorized; for a read-only request report the available version difference and finish."
        : s.fallback ? "Reuse registry and help evidence. Resolve only the reported stage; use action=verify with the advertised read-only status target binding to validate completion."
        : s.hostPending ? "Use action=inspect to retry only native host loading; package and Skill synchronization are verified."
        : "Use action=apply to complete the remaining stages." };
  }
  private evidence(s: Snapshot) {
    const names = ["version", "skill source", "skill status", "skill install", "skill update", "update install", "update operation", "update resume"];
    return { entry: s.entry, bootstrapEntry: s.bootstrapEntry, bootstrapVersion: s.bootstrapVersion,
      lastOperation: s.lastOperation, recovery: s.recovery,
      registry: { selector: `${s.input.package}@${s.input.version}`, version: s.desired, verifiedBy: "npm view" },
      lifecycle: s.commands && !s.complete && (s.fallback || s.released) ? Object.fromEntries(names.filter(name => s.commands![name]).map(name => {
        const command = s.commands![name]!;
        return [name, { sideEffects: command.sideEffects, options: Object.fromEntries(Object.entries(command.options).slice(0, 12).map(([key, value]) =>
          [key, { type: value.type, required: value.required, enum: Array.isArray(value.enum) ? value.enum.slice(0, 16) : undefined,
            default: ["string", "boolean", "number"].includes(typeof value.default) ? value.default : undefined,
            description: typeof value.description === "string" ? value.description.slice(0, 240) : undefined }])) }];
      })) : undefined };
  }
  private operationReceipt(value: unknown) {
    if (!object(value)) return undefined;
    const error = object(value.error) ? value.error : undefined;
    const keys = ["ok", "code", "message", "stage", "id", "operationId", "operationDirectory", "package", "target", "version", "from", "entry", "changed", "backup", "packageComplete", "skillComplete", "hostDiscovery"];
    return { ...Object.fromEntries(keys.filter(key => ["string", "boolean", "number"].includes(typeof value[key])).map(key =>
      [key, typeof value[key] === "string" ? value[key].slice(0, 1500) : value[key]])),
      ...(error ? { error: Object.fromEntries(["code", "message"].filter(key => typeof error[key] === "string")
        .map(key => [key, String(error[key]).slice(0, 1500)])) } : {}) };
  }
  private async selectEntry(s: Snapshot, candidate: unknown, call: unknown) {
    if (candidate === undefined) return false;
    if (typeof candidate !== "string" || !s.target || !isAbsolute(candidate)
      || !under(await realpath(s.target), await realpath(candidate)) || !(await stat(candidate)).isFile()) {
      throw new Error("Returned runtime entry must be an existing file inside the selected Skill target");
    }
    if (candidate === s.entry) return false;
    // Verify package ownership without assuming a provider-specific .runtime layout.
    let at = dirname(await realpath(candidate)), owned = false;
    const target = await realpath(s.target);
    while (under(target, at)) {
      const file = join(at, "package.json");
      if (await stat(file).catch(() => undefined)) {
        const manifest = manifestSchema.parse(json(await this.read(file, call)));
        if (manifest.name !== s.input.package) throw new Error("Returned runtime belongs to a different npm package");
        owned = true; break;
      }
      if (at === target) break;
      at = dirname(at);
    }
    if (!owned) throw new Error("Returned runtime entry has no verifiable owning package manifest");
    s.entry = candidate; s.contractFingerprint = undefined;
    return true;
  }
  private async status(s: Snapshot, call: unknown) {
    if (!s.entry || !s.target) throw new Error("Selected runtime/target is unknown");
    const status = parseStatus(json(await this.run(["node", s.entry, "skill", "status", "--target-directory", s.target, "--json"], call, s.operations)));
    if (status.target !== undefined && (typeof status.target !== "string" || !await sameTarget(status.target, s.target))) throw new Error("Status target differs from the selected Skill");
    if (status.package !== undefined && status.package !== s.input.package) throw new Error("Status package identity differs from request");
    return status;
  }
  private async runtimeVersion(s: Snapshot, call: unknown) {
    const result = z.object({ ok: z.literal(true), version: z.string(), name: z.string().optional(), package: z.string().optional() }).passthrough().parse(
      json(await this.run(["node", s.entry!, "version", "--json"], call, s.operations)));
    if ((result.package ?? result.name) !== undefined && (result.package ?? result.name) !== s.input.package) throw new Error("Runtime package identity differs from request");
    return result.version;
  }
  /** A bootstrap may be older than a successfully updated independent target.
   * Ask the advertised read-only operation API for its returned entry; never
   * infer a private runtime directory or reinstall to discover it. */
  private async discoverEntry(s: Snapshot, call: unknown, recovering = false) {
    if (s.skill?.runtime_entry) return this.selectEntry(s, s.skill.runtime_entry, call);
    const contract = s.commands?.["update operation"];
    if (!s.skill?.managed || (!recovering && s.skill.up_to_date) || !contract?.options["--target-directory"]
      || !contract.options["--json"] || !["none", "read"].includes(String(contract.sideEffects))) return false;
    const value = json(await this.run(["node", s.entry!, "update", "operation", "--target-directory", s.target!, "--json"], call, s.operations));
    if (!object(value) || value.ok !== true) return false;
    if (value.package !== s.input.package || typeof value.target !== "string" || !await sameTarget(value.target, s.target!)) throw new Error("Operation receipt does not belong to the selected package/target");
    s.lastOperation = this.operationReceipt(value);
    if (value.stage === "complete") { s.recovery = undefined; return this.selectEntry(s, value.entry, call); }
    const id = value.operationId ?? value.id;
    if (value.packageComplete === true && typeof id === "string" && /^[a-f0-9-]{36}$/.test(id) && typeof value.stage === "string" && value.stage !== "rolled-back") {
      s.recovery = { operationId: id, stage: value.stage };
    }
    return false;
  }
  private summaryFromFailure() {
    return "Update blocked with no verified progress. Report current/desired and the retained failure; installation documents may resolve a documented recovery. Repeating Shell writes, source repair, and OS permission changes are outside this recovery. inspect admits only changed installation contents or advertised operation recovery.";
  }
  private async failureFingerprint(s: Snapshot) {
    const paths = [s.entry, join(s.root, "package.json"), s.target && join(s.target, "SKILL.md"), s.target && join(s.target, "package.json")];
    return JSON.stringify(await Promise.all(paths.map(async file => {
      if (!file) return null;
      const info = await stat(file).catch(() => undefined);
      return [file, info?.isFile() && info.size <= 1_000_000 ? createHash("sha256").update(await readFile(file)).digest("hex") : null];
    })));
  }
  private async diagnosticDocuments(s: Snapshot) {
    const result: string[] = [];
    for (const root of [s.root, s.target]) for (const name of ["UPDATE.md", "INSTALL.md", "README.md"]) {
      if (!root) continue;
      const file = join(root, name), info = await stat(file).catch(() => undefined);
      if (info?.isFile() && info.size <= 256_000 && under(await realpath(root), await realpath(file))) result.push(await realpath(file));
    }
    return [...new Set(result)];
  }
  /** A lifecycle failure is not permission to turn an update into source repair.
   * Native read-only status/resume contracts remain available through this tool. */
  async guardRecovery(sessionID: string, tool: string, input: unknown) {
    const s = this.snapshots.get(sessionID);
    if (!s?.failure) return;
    if (tool === "read" && object(input) && typeof input.path === "string") {
      const file = await realpath(input.path).catch(() => undefined);
      const roots = await Promise.all([s.root, s.target].filter((root): root is string => !!root).map(root => realpath(root)));
      if (file && file.toLowerCase().endsWith(".md") && roots.some(root => under(root, file))) {
        const info = await stat(file);
        if (info.size <= 256_000) {
          const key = `${file}:${info.size}:${info.mtimeMs}`;
          if (!s.failure.observed.has(key)) { s.failure.observed.add(key); return key; }
          throw new Error(`PACKAGE_RECOVERY_ALREADY_OBSERVED: Reuse the installation document already read. ${JSON.stringify(this.summary(sessionID))}`);
        }
      }
    }
    throw new Error(`PACKAGE_RECOVERY_BLOCKED: This ${tool} was not executed. ${JSON.stringify(this.summary(sessionID))}`);
  }
  releaseDiagnostic(sessionID: string, key: string) { this.snapshots.get(sessionID)?.failure?.observed.delete(key); }
  private async entryFingerprint(s: Snapshot) {
    return JSON.stringify(await Promise.all([s.entry, join(s.root, "package.json")].map(async path => {
      const info = path ? await stat(path).catch(() => undefined) : undefined;
      return [path, info?.size, info?.mtimeMs, info?.ino];
    })));
  }
  /** Complete a manual contract handoff using actual permission-bearing CLI and
   * host receipts. Caller supplies a documented binding, never a success flag or
   * arbitrary command. Parent roots are accepted only with an exact target echo. */
  private async verifyFallback(s: Snapshot, binding: Input["verification"], call: unknown) {
    if (!binding || !s.entry) throw new Error("Provide skillName, targetOption and targetKind from the CLI's documented status contract.");
    if (s.contractFingerprint !== await this.entryFingerprint(s)) {
      s.commands = helpSchema.parse(json(await this.run(["node", s.entry, "--help"], call, s.operations))).commands;
      s.contractFingerprint = await this.entryFingerprint(s);
    }
    const contract = s.commands?.["skill status"];
    if (!["none", "read"].includes(String(contract?.sideEffects)) || contract?.options[binding.targetOption]?.type !== "string"
      || contract.options[binding.targetOption]?.enum || !contract.options["--json"] || !s.commands?.version?.options["--json"]) {
      throw new Error("Verification requires an advertised read-only skill status string target option and JSON status/version commands.");
    }
    if (s.skillName && s.skillName !== binding.skillName) throw new Error("Skill identity conflicts with the discovered source");
    const target = s.input.targetDirectory ? resolve(s.input.targetDirectory) : join(this.ownDirectory, binding.skillName);
    const receipt = json(await this.run(["node", s.entry, "skill", "status", binding.targetOption,
      binding.targetKind === "parent" ? dirname(target) : target, "--json"], call, s.operations));
    if (!object(receipt) || typeof receipt.target !== "string" || !isAbsolute(receipt.target) || resolve(receipt.target) !== target) {
      throw new Error("Status must echo the exact selected Skill target; the proposed option binding did not verify it.");
    }
    if (receipt.package !== undefined && receipt.package !== s.input.package) throw new Error("Status package identity differs from request");
    let status = parseStatus(receipt);
    s.skill = status; s.target = target; s.skillName = binding.skillName;
    if (status.installed && status.managed && !status.edited?.length && await this.discoverEntry(s, call)) {
      s.commands = helpSchema.parse(json(await this.run(["node", s.entry, "--help"], call, s.operations))).commands;
      const refreshed = json(await this.run(["node", s.entry, "skill", "status", binding.targetOption,
        binding.targetKind === "parent" ? dirname(target) : target, "--json"], call, s.operations));
      if (!object(refreshed) || refreshed.target !== target || refreshed.package !== undefined && refreshed.package !== s.input.package) throw new Error("Selected runtime status identity differs from the admitted target");
      status = parseStatus(refreshed); s.skill = status;
    }
    if (!status.installed || !status.managed || status.up_to_date !== true || status.edited?.length || status.runtime_verified === false) {
      throw new Error("Selected Skill must be installed, package-managed, synchronized and free of managed edits; resolve only the failing stage.");
    }
    s.version = await this.runtimeVersion(s, call);
    s.verification = binding; s.needsInspection = false; s.fallback = undefined; s.hostAttempts = 0; s.released = false;
    s.contractFingerprint = await this.entryFingerprint(s);
    await this.verifyHost(s, call);
  }
  private async run(args: string[], call: unknown, operations: string[][]) {
    operations.push(args);
    const result = await this.native.shell.execute({ command: maintenanceCommand(args), timeout: 180000 }, call);
    if (object(result) && object(result.metadata) && typeof result.metadata.exit === "number" && result.metadata.exit !== 0) {
      throw new Error(`Command exited ${result.metadata.exit}: ${maintenanceText(result).slice(-2500)}`);
    }
    const text = maintenanceText(result);
    if (object(result) && object(result.metadata) && result.metadata.truncated === true) {
      // The native Shell returns a bounded tail, which is not a JSON document.
      // Its terminal receipt names the full output. Read it once through the
      // permission-bearing native Read; only bounded lifecycle facts escape.
      const receipt = /\n\n\[showing lines \d+-\d+ of \d+; full output saved to (.+)\]\s*$/.exec(text);
      if (!receipt?.[1] || !isAbsolute(receipt[1])) throw new Error("Native Shell output was truncated without an absolute full-output receipt");
      return this.read(receipt[1], call);
    }
    return text;
  }
  private async read(path: string, call: unknown) {
    await this.native.read.execute({ path }, call);
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_000_000) throw new Error("Package metadata is not a bounded file");
    return readFile(path, "utf8");
  }
  private async inspect(input: Input, call: unknown, operations: string[][] = []): Promise<Snapshot> {
    const [globalRoot, desiredValue] = await Promise.all([
      this.run(["npm", "root", "-g"], call, operations),
      this.run(["npm", "view", `${input.package}@${input.version}`, "version", "--json", "--fetch-retries=0", "--fetch-timeout=10000"], call, operations),
    ]);
    const desired = z.string().parse(json(desiredValue));
    const root = join(globalRoot.trim(), ...input.package.split("/"));
    const s: Snapshot = { input, root, version: "not-installed", desired, complete: false, operations };
    if (!await stat(join(root, "package.json")).catch(() => undefined)) {
      s.fallback = "Package is not globally installed. Read its published installation contract before installing; this tool currently maintains existing global CLI installations.";
      return s;
    }
    const manifest = manifestSchema.parse(json(await this.read(join(root, "package.json"), call)));
    if (manifest.name !== input.package) throw new Error("Installed package identity differs from request");
    s.version = manifest.version;
    s.bootstrapVersion = manifest.version;
    const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
    if (bins.length !== 1) { s.fallback = "Package has no unambiguous CLI entry. Read its installation guide to select the entry."; return s; }
    const entry = resolve(root, bins[0]!);
    if (!under(root, entry)) throw new Error("CLI entry escapes its package");
    s.entry = entry;
    s.bootstrapEntry = entry;
    const help = structuredHelp(await this.run(["node", entry, "--help"], call, operations));
    if (!help?.success) { s.fallback = `CLI has no supported structured help. Read ${join(root, "UPDATE.md")} or its documented lifecycle interface.`; return s; }
    s.commands = help.data.commands;
    s.contractFingerprint = await this.entryFingerprint(s);
    const missing = [!s.commands["version"] && "version", !s.commands["skill source"] && "skill source",
      !s.commands["skill status"] && "skill status", !s.commands["skill status"]?.options["--target-directory"] && "skill status option --target-directory"].filter(Boolean);
    if (missing.length) {
      s.fallback = `Unsupported automatic contract: missing ${missing.join(", ")}. Reuse the supplied entry, registry version and help. Resolve the documented target binding, then use action=verify for read-only completion.`; return s;
    }
    const sourceResult = sourceSchema.safeParse(json(await this.run(["node", entry, "skill", "source", "--json"], call, operations)));
    if (!sourceResult.success) { s.fallback = "skill source does not provide the required name/source identity. Reuse the known entry/help and resolve the Skill name, then use action=verify with the documented read-only status target binding."; return s; }
    const source = sourceResult.data;
    s.skillName = source.name;
    s.target = input.targetDirectory ? resolve(input.targetDirectory) : join(this.ownDirectory, source.name);
    s.skill = await this.status(s, call);
    if (s.skill.installed && !s.skill.managed) { s.fallback = "Selected target is not package-managed; preserve the unrelated installation."; return s; }
    if (s.skill.edited?.length) { s.fallback = "Managed local edits exist. Preserve them through the package's documented conflict/backup operation before applying updates."; return s; }
    await this.discoverEntry(s, call);
    s.version = await this.runtimeVersion(s, call);
    if (s.version !== manifest.version) return this.refreshLocal(s, call, s.version);
    if (s.version === desired && s.skill.installed && s.skill.managed && s.skill.up_to_date && s.skill.runtime_verified !== false) {
      await this.verifyHost(s, call);
    }
    return s;
  }
  private async refreshLocal(s: Snapshot, call: unknown, knownVersion?: string): Promise<Snapshot> {
    if (!s.entry || !s.target) throw new Error("Selected runtime/target is unknown");
    const previousVersion = s.version, previousSync = s.skill?.up_to_date, recovering = s.needsInspection;
    let version = knownVersion;
    // The new runtime may have a changed lifecycle contract after replacement.
    s.commands = helpSchema.parse(json(await this.run(["node", s.entry, "--help"], call, s.operations))).commands;
    s.skill = await this.status(s, call);
    if (await this.discoverEntry(s, call, recovering)) {
      s.commands = helpSchema.parse(json(await this.run(["node", s.entry, "--help"], call, s.operations))).commands;
      s.skill = await this.status(s, call); version = undefined;
    }
    s.version = version ?? await this.runtimeVersion(s, call); s.needsInspection = false; s.hostPending = undefined; s.hostAttempts = 0;
    s.contractFingerprint = await this.entryFingerprint(s);
    const changedFailure = s.failure && (s.failure.fingerprint !== await this.failureFingerprint(s)
      || s.version !== previousVersion || s.skill.up_to_date !== previousSync || s.recovery && !(s.recoveryAttempts ?? 0));
    if (s.failure && !changedFailure && (s.recoveryAttempts ?? 0) > 0) s.recovery = undefined;
    if (changedFailure || s.version === s.desired && s.skill.up_to_date) { s.failure = undefined; s.fallback = undefined; s.released = false; }
    if (s.skill.installed && !s.skill.managed) s.fallback = "Selected target is not package-managed; preserve it.";
    else if (s.skill.edited?.length) s.fallback = "Managed local edits must be preserved before recovery.";
    else if (s.version === s.desired && s.skill.up_to_date && s.skill.runtime_verified !== false) await this.verifyHost(s, call);
    else if (recovering && !changedFailure && !s.recovery && s.version === previousVersion && s.skill.up_to_date === previousSync) {
      s.fallback = "The failed operation made no observable version/synchronization progress. Preserve its failure receipt; use a documented read-only recovery contract or report the blocker.";
    }
    return s;
  }
  private async verifyHost(s: Snapshot, call: unknown) {
    if (!s.target || !s.skillName) return;
    s.hostAttempts = (s.hostAttempts ?? 0) + 1;
    s.hostVerified = false; s.complete = false;
    s.localFingerprint = await this.fingerprint(s);
    try {
      let id = s.skillName;
      if (this.native.listSkills) {
        const catalog = z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() }).passthrough()) }).passthrough().parse(await this.native.listSkills());
        const matches = catalog.data.filter(item => item.name === s.skillName && resolve(item.path) === resolve(s.target!, "SKILL.md"));
        // The source loader refreshes before execute. A newly installed target
        // may be absent from the old catalog, so let it resolve the exact name.
        if (matches.length === 1) id = matches[0]!.id;
      }
      const result = await this.native.skill.execute({ id }, call);
      const body = maintenanceText(result), marker = body.indexOf("[sealwork.skill-source]\n");
      const path = join(s.target, "SKILL.md");
      const text = await this.read(path, call);
      const facts = marker < 0 ? undefined : z.object({ canonicalPath: z.string(), sha256: z.string() }).passthrough().parse(
        json(body.slice(marker + "[sealwork.skill-source]\n".length).split("\n")[0]!));
      const verified = facts ? resolve(facts.canonicalPath) === await realpath(path) && facts.sha256 === createHash("sha256").update(text).digest("hex")
        : body.includes(`Base directory for this skill: ${s.target}\n`) && body.includes(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim());
      if (!verified) {
        throw new Error("Native host loaded a different Skill source or stale content.");
      }
      s.hostVerified = true; s.complete = s.version === s.desired; s.hostPending = undefined;
      s.fallback = s.complete ? undefined : `Installed runtime ${s.version} and its synchronized Skill load are verified. Requested version ${s.desired} remains available; update only if authorized, or report this version difference and finish a read-only request.`;
      s.fingerprint = await this.fingerprint(s);
      // Skill content was loaded for verification, not to start its business
      // workflow. Only identity/hash facts are returned to the installation model.
    } catch (error) {
      s.hostPending = error instanceof Error ? error.message.slice(-1000) : "Native host loading failed.";
      if (s.hostAttempts >= 2) s.fallback = `Host verification failed twice; diagnose only registration/source loading. ${s.hostPending}`;
    }
  }
  private async fingerprint(s: Snapshot) {
    const paths = [s.entry, join(s.root, "package.json"), s.target ? join(s.target, "SKILL.md") : undefined, s.target ? join(s.target, "package.json") : undefined].filter((p): p is string => !!p);
    return JSON.stringify(await Promise.all(paths.map(async path => { const info = await stat(path).catch(() => undefined); return [path, info?.size, info?.mtimeMs, info?.ino]; })));
  }
  private async apply(s: Snapshot, call: unknown): Promise<Snapshot> {
    if (!s.entry || !s.target || !s.commands) throw new Error("Lifecycle contract is incomplete");
    const operation = s.recovery ? "update resume" : s.version !== s.desired ? "update install" : s.skill?.installed ? "skill update" : "skill install";
    const contract = s.commands[operation];
    if (!contract?.options["--target-directory"] || !contract.options["--json"] || (operation.startsWith("update ") && !contract.options["--yes"])) {
      s.fallback = `The CLI does not advertise ${operation} with explicit target and structured output.`; return s;
    }
    // Combined updaters often own a default channel. Explicit non-latest input
    // cannot be silently replaced by that default.
    if (s.version !== s.desired && s.input.version !== "latest" && !(contract.options["--version"]?.type === "string" && /^\d+\.\d+\.\d+$/.test(s.desired))) { s.fallback = "An explicit version/channel requires a documented version-selection contract for the updater."; return s; }
    if (s.recovery && (!contract.options["--operation"] || (s.recoveryAttempts ?? 0) >= 1)) { s.fallback = "Recovery requires its advertised operation binding; repeated failed recovery needs native diagnostics."; return s; }
    const args = ["node", s.entry, ...operation.split(" "), "--target-directory", s.target, ...(operation.startsWith("update ") ? ["--yes"] : []),
      ...(s.recovery ? ["--operation", s.recovery.operationId] : operation === "update install" && contract.options["--version"]?.type === "string" ? ["--version", s.desired] : []), "--json"];
    if (s.recovery) s.recoveryAttempts = (s.recoveryAttempts ?? 0) + 1;
    const result = json(await this.run(args, call, s.operations));
    s.lastOperation = this.operationReceipt(result);
    if (!object(result) || result.ok !== true) throw new Error(JSON.stringify(this.operationReceipt(result) ?? { error: "Lifecycle operation failed; inspect its structured operation receipt" }));
    if (result.package !== undefined && result.package !== s.input.package || result.target !== undefined && (typeof result.target !== "string" || !await sameTarget(result.target, s.target))) throw new Error("Lifecycle receipt differs from selected package/target");
    if (typeof result.backup === "string") s.backup = result.backup;
    const changedEntry = await this.selectEntry(s, typeof result.entry === "string" ? result.entry : undefined, call);
    if (changedEntry) s.commands = helpSchema.parse(json(await this.run(["node", s.entry, "--help"], call, s.operations))).commands;
    // Reinspect only mutated local state; the requested registry version and
    // structured command contract remain the same evidence for this operation.
    const status = await this.status(s, call);
    s.skill = status;
    if (status.runtime_entry) await this.selectEntry(s, status.runtime_entry, call);
    s.version = await this.runtimeVersion(s, call);
    s.recovery = undefined; s.released = false;
    if (s.version === s.desired && status.installed && status.managed && !status.edited?.length && status.up_to_date && status.runtime_verified !== false) await this.verifyHost(s, call);
    else s.fallback = "The lifecycle operation returned but version or Skill verification is still incomplete. Inspect this phase before another mutation.";
    return s;
  }
}

export async function registerPackageMaintenance(context: {
  options: { ownDirectory: string };
  skill?: { list(): Promise<unknown> };
  tool: { transform(edit: (editor: Editor) => void): Promise<Registration> };
}, active: (sessionID: string) => Promise<boolean>) {
  let maintenance: PackageMaintenance | undefined;
  const registration = await context.tool.transform(editor => {
    const shell = editor.get("shell"), read = editor.get("read"), skill = editor.get("skill");
    if (!shell || !read || !skill) return;
    maintenance ??= new PackageMaintenance({ shell: { ...shell }, read: { ...read }, skill: { ...skill },
      ...(context.skill ? { listSkills: () => context.skill!.list() } : {}) }, context.options.ownDirectory);
    editor.add({ name: "package_maintenance", options: { codemode: false }, input: z.toJSONSchema(inputSchema),
      description: "Maintain an installed global npm CLI and its companion Skill through advertised structured lifecycle contracts. Start with inspect: discover the entry, requested registry version, selected target status and native host load. Already-current installs finish without writes. apply runs only a necessary documented update/synchronization. verify closes a manual handoff using an advertised read-only status binding (verification: skillName, targetOption, targetKind exact/parent), the retained registry version and a native host source/hash check. It accepts no caller success flag. complete is the completion receipt. Unsupported contracts return to ordinary tools. handoff with reason releases maintenance scope only for additional user-requested work or unresolved contracts, not equivalent rechecks. All operations retain native permissions; no service authentication or business execution.",
      async execute(input, call) {
        if (!maintenance) throw new Error("Package maintenance unavailable");
        return maintenance.execute(input, call);
      },
    });
    for (const name of ["shell", "read"]) {
      const execute = editor.get(name)?.execute;
      if (!execute) continue;
      editor.update(name, tool => {
        tool.execute = async (input, call) => {
          const identity = z.object({ sessionID: z.string() }).parse(call);
          const summary = maintenance?.summary(identity.sessionID);
          if (summary && (!summary.fallback || summary.verificationPending) && !summary.released && await active(identity.sessionID)) {
            throw new Error(`${summary.complete ? "INSTALLATION_COMPLETE" : "PACKAGE_MAINTENANCE_NEXT_STAGE"}: This Shell/Read was not executed. ${JSON.stringify(summary)}`);
          }
          const document = await active(identity.sessionID) ? await maintenance?.guardRecovery(identity.sessionID, name, input) : undefined;
          try { return await execute(input, call); }
          catch (error) { if (document) maintenance?.releaseDiagnostic(identity.sessionID, document); throw error; }
        };
      });
    }
  });
  return { reset: (id: string) => maintenance?.reset(id), summary: (id: string) => maintenance?.summary(id), dispose: () => registration.dispose() };
}
