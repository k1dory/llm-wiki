import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const MODE = process.env.MCP_MODE ?? "http"; // http | stdio
const PORT = Number(process.env.PORT ?? 8090);

if (MODE === "stdio") {
  // Локальный режим: Claude Code запускает процесс сам и говорит по stdin/stdout.
  const server = createServer();
  await server.connect(new StdioServerTransport());
} else {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((_req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version");
    res.set("Access-Control-Expose-Headers", "mcp-session-id");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  app.get("/health", (_req, res) => res.json({ ok: true, mode: "http" }));

  // Streamable HTTP без сессий: на каждый запрос — свежий сервер и транспорт.
  app.post("/mcp", async (req, res) => {
    // Заголовок клиента пробрасывается в API как есть — своих доступов MCP не держит.
    const server = createServer(req.get("authorization"));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp]", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "внутренняя ошибка" },
          id: null,
        });
      }
    }
  });

  // Сессий нет — SSE-поток и завершение сессии не поддерживаются.
  const noSession = (_req: express.Request, res: express.Response) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "сервер без сессий: используйте POST /mcp" },
      id: null,
    });
  app.get("/mcp", noSession);
  app.delete("/mcp", noSession);

  app.listen(PORT, () => console.log(`[mcp] streamable http на :${PORT}/mcp`));
}
