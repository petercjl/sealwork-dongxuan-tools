import { registerPackageMaintenance, type MaintenanceTool } from "./maintenance.js";
import { guidance } from "./guidance.js";
import { patterns, continuations } from "./routing.js";

type Registration = { dispose(): Promise<void> };
type Event = { sessionID: string; system: Array<{ type: string; text?: string }>;
  messages: Array<{ id?: string; role: string; content: Array<{ type: string; text?: string }> }>;
  tools?: Record<string, unknown> };
type Context = {
  options: { ownDirectory: string };
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  skill?: { list(): Promise<unknown> };
  tool: { transform(edit: (editor: { get(id: string): MaintenanceTool | undefined;
    update(id: string, edit: (tool: MaintenanceTool) => void): void; add(tool: MaintenanceTool): void }) => void): Promise<Registration>;
    hook(name: "execute.before", cb: (event: { sessionID: string; tool: string }) => Promise<void>): Promise<Registration> };
  session: {
    hook(name: "context" | "compaction" | "generate", cb: (event: Event) => Promise<void>): Promise<Registration>;
    hook(name: "prompt", cb: (event: { sessionID: string; messageID: string; prompt: { text?: string } }) => Promise<void>): Promise<Registration>;
  };
};
type State = { messageID?: string; active: boolean; awaitingReply?: boolean };
const matches = (text: string, rules: string[]) => rules.some(rule => new RegExp(rule, "iu").test(text));
export default {
  id: "petercjl.package-maintenance",
  async setup(context: Context) {
    const states = new Map<string, State>();
    async function load(id: string): Promise<State> {
      const cached = states.get(id);
      if (cached) return cached;
      const raw = await context.storage.get(`routing/${id}`);
      const value: State = raw && typeof raw === "object" && "active" in raw
        ? { active: raw.active === true, ...("awaitingReply" in raw && raw.awaitingReply === true ? { awaitingReply: true } : {}),
          ...("messageID" in raw && typeof raw.messageID === "string" ? { messageID: raw.messageID } : {}) }
        : { active: false };
      states.set(id, value); return value;
    }
    async function advance(id: string, messageID: string | undefined, text: string) {
      const previous = await load(id);
      if (!messageID || previous.messageID === messageID) return previous;
      const cancelled = /^(?:取消|停止|结束|放弃)(?:当前|这个|本次|刚才的)?(?:任务|安装|操作|吧)?[\s，。,.!！]*$|^(?:换个任务|新任务|另外一个问题|cancel|stop|new task)(?:[：:，,\s]|$)/iu.test(text.trim());
      const value = { messageID, active: !cancelled && (matches(text, patterns) || previous.active &&
        (previous.awaitingReply === true || matches(text, continuations) || /^(?:继续|接着|好的|可以|好|没问题|continue|go ahead|yes|proceed)[\s，。,.!！]*$/iu.test(text.trim()))) };
      states.set(id, value); await context.storage.set(`routing/${id}`, value); return value;
    }
    const maintenance = await registerPackageMaintenance(context, async id => (await load(id)).active);
    async function assemble(event: Event) {
      const user = [...event.messages].reverse().find(message => message.role === "user" && message.id);
      const previous = await load(event.sessionID);
      const state = previous.messageID ? previous : await advance(event.sessionID, user?.id,
        user?.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n") ?? "");
      for (let i = event.system.length - 1; i >= 0; i--) {
        if (event.system[i]?.text?.startsWith("[sealwork.plugin.package-maintenance]")) event.system.splice(i, 1);
      }
      if (!state.active) return;
      const summary = maintenance.summary(event.sessionID);
      event.system.push({ type: "text", text: `[sealwork.plugin.package-maintenance]\n${guidance}`
        + (summary ? `\nHost-observed maintenance state: ${JSON.stringify(summary)}` : "") });
      if (summary && event.tools) {
        const onlyMaintenance = (!summary.fallback || summary.verificationPending) && !summary.released;
        if (onlyMaintenance || summary.failure) {
          const allowed = onlyMaintenance ? ["package_maintenance", "question"] : ["package_maintenance", "read", "question"];
          for (const name of Object.keys(event.tools)) if (!allowed.includes(name)) delete event.tools[name];
        }
      }
    }
    const registrations = [maintenance, ...await Promise.all([
      context.session.hook("prompt", async event => {
        maintenance.reset(event.sessionID);
        await advance(event.sessionID, event.messageID, event.prompt.text ?? "");
      }),
      context.session.hook("context", assemble), context.session.hook("compaction", assemble), context.session.hook("generate", assemble),
      context.tool.hook("execute.before", async event => {
        if (event.tool !== "question") return;
        const state = await load(event.sessionID);
        if (state.active) { state.awaitingReply = true; await context.storage.set(`routing/${event.sessionID}`, state); }
      }),
    ])];
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); states.clear(); };
  },
};
