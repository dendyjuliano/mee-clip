import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { processVideoJob } from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processVideoJob],
});
