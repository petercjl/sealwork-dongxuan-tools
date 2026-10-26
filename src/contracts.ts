import { z } from "zod";

export const commandSchema = z.object({ options: z.record(z.string(), z.object({ type: z.string(), required: z.boolean().optional() }).passthrough()).default({}) }).passthrough();
const fields = z.record(z.string(), z.object({ field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/), type: z.enum(["string", "boolean", "string[]", "object"]) }));
export const contractSchema = z.object({ schemaVersion: z.literal(1), source: fields, status: fields,
  targetOptions: z.record(z.string().regex(/^--[a-z][a-z-]*$/), z.object({ kind: z.enum(["skill-directory", "skill-parent", "host-root"]) })),
}).passthrough().superRefine((value, context) => {
  const required = { source: { name: "string", package: "string", version: "string", path: "string" },
    status: { name: "string", package: "string", version: "string", target: "string", installed: "boolean", managed: "boolean", current: "boolean", edited: "edits", verification: "object", recovery: "object" } };
  for (const operation of ["source", "status"] as const) for (const [name, type] of Object.entries(required[operation])) {
    const mapping = value[operation][name];
    if (!mapping || (type === "edits" ? !["boolean", "string[]"].includes(mapping.type) : mapping.type !== type)) context.addIssue({ code: "custom", message: `Invalid ${operation}.${name} typed mapping`, path: [operation, name] });
  }
});
export type MachineContract = z.infer<typeof contractSchema>;
export type Commands = Record<string, z.infer<typeof commandSchema>>;
export function discoverContract(value: unknown) {
  const envelope = z.object({ commands: z.record(z.string(), commandSchema).optional(),
    commandContracts: z.record(z.string(), commandSchema).optional(), maintenanceContract: z.unknown().optional(),
  }).passthrough().safeParse(value);
  if (!envelope.success) return undefined;
  const raw = envelope.data;
  const commands = raw.commandContracts ?? raw.commands;
  if (!commands || !Object.keys(commands).length) return undefined;
  const machine = raw.maintenanceContract === undefined ? undefined : contractSchema.parse(raw.maintenanceContract);
  if (!machine && !raw.commandContracts && raw.ok !== true) return undefined;
  return { commands, machine };
}
export function mappedReceipt(value: unknown, machine: MachineContract, kind: "source" | "status") {
  const raw = z.record(z.string(), z.unknown()).parse(value);
  if (raw.ok === false) throw new Error("CLI returned a failed maintenance receipt");
  const mapped: Record<string, unknown> = { ...raw, ok: true };
  for (const [key, mapping] of Object.entries(machine[kind])) {
    let item: unknown = raw;
    for (const part of mapping.field.split(".")) item = item && typeof item === "object" && !Array.isArray(item) ? Reflect.get(item, part) : undefined;
    const schema = mapping.type === "string[]" ? z.array(z.string()) : mapping.type === "string" ? z.string()
      : mapping.type === "boolean" ? z.boolean() : z.record(z.string(), z.unknown());
    if (item === undefined && kind === "status" && ["recovery", "verification"].includes(key)) throw new Error(`Missing declared ${kind}.${key} receipt`);
    // An absent target may omit installed-version facts, but identities are mandatory.
    if (item === undefined) { if (kind === "source" || ["name", "package", "target", "installed", "managed", "current", "edited"].includes(key)) throw new Error(`Missing declared ${kind}.${key} receipt`); continue; }
    mapped[key] = schema.parse(item);
  }
  if (kind === "source") mapped.source = mapped.path;
  else {
    const edited = Array.isArray(mapped.edited) ? mapped.edited.length > 0 : mapped.edited === true;
    const verification = z.object({ verified: z.boolean(), algorithm: z.string().optional() }).passthrough().parse(mapped.verification);
    const recovery = z.object({ required: z.boolean().optional() }).passthrough().parse(mapped.recovery);
    if (mapped.current === true && (recovery.required === true || mapped.installed !== true || mapped.managed !== true || edited || !verification.verified || verification.algorithm !== "sha256")) throw new Error("Conflicting current/integrity/ownership receipt");
    mapped.up_to_date = mapped.current;
    mapped.runtime_entry = raw.runtime_entry ?? raw.runtimeEntry;
    mapped.runtime_verified = mapped.current === true ? verification.verified : undefined;
  }
  return mapped;
}
export function targetBinding(commands: Commands, machine: MachineContract | undefined, operation: string) {
  const options = commands[operation]?.options ?? {};
  if (machine) {
    for (const kind of ["skill-directory", "skill-parent", "host-root"]) for (const [flag, binding] of Object.entries(machine.targetOptions)) {
      if (binding.kind === kind && options[flag]?.type === "string" && !options[flag]?.enum) return { flag, parent: kind === "skill-parent", hostRoot: kind === "host-root" };
    }
    return undefined;
  }
  return options["--target-directory"]?.type === "string" ? { flag: "--target-directory", parent: false } : undefined;
}
