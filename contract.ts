import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Shared between server.ts (pushes settings) and host.ts (bridge reads them). */
export const antigravityHostContract = defineRpcContract({
  setConfig: {
    input: z
      .object({
        agyBin: z.string().min(1),
        model: z.string(),
        effort: z.enum(["low", "medium", "high"]),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
