import { AnalysisService } from "./agent/service.js";
import { createHttpApp } from "./api/http.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const service = await AnalysisService.create(config);
  const app = await createHttpApp(service);

  const server = app.listen(config.port, config.host, () => {
    const address = server.address();
    const where = typeof address === "object" && address ? `${address.address}:${address.port}` : String(config.port);
    console.log(`data-agent listening on http://${where}`);
    console.log(`  model:    ${config.model.provider}/${config.model.modelId}`);
    console.log(`  data dir: ${config.dataDir}`);
    console.log(`  auth:     ${config.apiToken ? "bearer token required" : "OPEN (no DATA_AGENT_API_TOKEN set)"}`);
    if (!service.modelReady) {
      console.warn(
        `  WARNING:  no API key resolved for "${config.model.provider}" — analysis tasks will fail with\n` +
          `            "No API key found". Set DATA_AGENT_MODEL_API_KEY (or DATA_AGENT_MODEL_AUTH_PATH) and restart.`,
      );
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, closing sessions…`);
    server.close();
    await service.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("data-agent failed to start:", error);
  process.exit(1);
});
