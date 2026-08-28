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

  async function pushConfigToHost(hostId: string, signal: AbortSignal): Promise<void> {
    const { agyBin, model, effort } = await settings.get();
    try {
      await hostClient.call(
        "setConfig",
        { agyBin, model, effort: effort as "low" | "medium" | "high" },
        { hostId, signal },
      );
    } catch {
      // A disconnect can race the connected-host snapshot. The reconnect
      // subscription below makes this retry without treating it as a load error.
    }
  }

  let requestConfigReconcile = () => {};
  settings.onChange(() => {
    requestConfigReconcile();
  });

  bb.background.service("host-config-reconciler", {
    async start(signal) {
      let reconcileRequested = true;
      let wake: (() => void) | null = null;
      requestConfigReconcile = () => {
        reconcileRequested = true;
        wake?.();
      };
      const unsubscribeHost = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected")) requestConfigReconcile();
        },
      });
      try {
        while (!signal.aborted) {
          if (reconcileRequested) {
            reconcileRequested = false;
            const hosts = await bb.sdk.hosts.list({ signal });
            await Promise.all(
              hosts
                .filter((host) => host.status === "connected")
                .map((host) => pushConfigToHost(host.id, signal)),
            );
          }
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
        }
      } finally {
        requestConfigReconcile = () => {};
        unsubscribeHost();
      }
    },
  });

  bb.providers.register({
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
