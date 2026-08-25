// bb-plugin-antigravity-acp — registers the local Antigravity CLI (agy) as a
// BB agent provider by bridging to it as a subprocess per turn.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { antigravityHostContract } from "./contract.js";

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ agyBin: z.string(), model: z.string(), effort: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    agyBin: { type: "string", label: "agy binary path", default: "agy" },
    model: { type: "string", label: "Model override (blank = agy default)", default: "" },
    effort: {
      type: "select",
      label: "Default reasoning effort (only used when no specific model is picked)",
      options: ["low", "medium", "high"],
      default: "medium",
    },
  });

  const hostClient = bb.hosts.experimental_client({ contract: antigravityHostContract });

  async function primaryHostId(): Promise<string | undefined> {
    const hosts = await bb.sdk.hosts.list();
    return hosts[0]?.id;
  }

  async function pushConfigToHost(): Promise<void> {
    const { agyBin, model, effort } = await settings.get();
    const hostId = await primaryHostId();
    if (!hostId) {
      bb.log.warn("no enrolled host to push Antigravity config to");
      return;
    }
    try {
      await hostClient.call(
        "setConfig",
        { agyBin, model, effort: effort as "low" | "medium" | "high" },
        { hostId },
      );
    } catch (err) {
      bb.log.error(`failed to push config to host: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Host RPC calls are rejected during factory registration — defer to a
  // timer tick (verified necessary against a live server in omniroute-acp).
  setTimeout(() => void pushConfigToHost(), 0);
  settings.onChange(() => {
    void pushConfigToHost();
  });

  bb.agents.experimental_registerProvider({
    id: "antigravity",
    displayName: "Antigravity",
    icon: "./assets/icon.png",
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsWorkflows: false,
      permissionModes: ["full"],
      // The model list is collapsed to one entry per model, so bb renders a
      // separate reasoning-effort picker (low/medium/high); the bridge
      // re-encodes the selection into the full agy model id at turn time.
      reasoningLevels: ["low", "medium", "high"],
    },
    composerActions: [],
  });

  bb.rpc.register(rpcContract, {
    status: async () => {
      const { agyBin, model, effort } = await settings.get();
      return { agyBin, model, effort };
    },
  });

  bb.log.info("antigravity-acp loaded");

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
