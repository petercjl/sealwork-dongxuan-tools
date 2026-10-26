import packageMaintenance from "./package-maintenance.js";

// Each module owns its tools, hooks and disposal; the package owns composition.
const modules = [packageMaintenance];
export default {
  id: "petercjl.dongxuan-tools",
  async setup(context: Parameters<typeof packageMaintenance.setup>[0]) {
    const cleanups: Array<() => Promise<void>> = [];
    try {
      for (const module of modules) cleanups.push(await module.setup(context));
    } catch (error) {
      for (const cleanup of cleanups.reverse()) await cleanup();
      throw error;
    }
    return async () => { for (const cleanup of cleanups.reverse()) await cleanup(); };
  },
};
