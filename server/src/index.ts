import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { requireOwnerAuth } from "./auth.js";
import {
  handleDropboxTempLink,
  handleDropboxThumb,
  handleDropboxUpload,
  isDropboxConfigured,
} from "./dropbox.js";
import { env } from "./env.js";
import { handleOpenAIChat, handleOpenAITest } from "./openai.js";

const app = express();
app.disable("x-powered-by");

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    supabaseUrl: env.supabaseUrl,
    supabasePublishableKey: env.supabasePublishableKey,
    ownerDisplayName: env.ownerDisplayName,
    dropboxConfigured: isDropboxConfigured(),
  });
});

// Raw binary upload must run before JSON body parsing so octet-stream stays a Buffer.
app.post(
  "/api/dropbox/upload",
  requireOwnerAuth,
  express.raw({ type: "application/octet-stream", limit: "50mb" }),
  handleDropboxUpload,
);

const jsonParser = express.json({ limit: "2mb" });

app.post(
  "/api/dropbox/temp-link",
  requireOwnerAuth,
  jsonParser,
  handleDropboxTempLink,
);

app.post(
  "/api/dropbox/thumb",
  requireOwnerAuth,
  jsonParser,
  handleDropboxThumb,
);

app.post("/api/openai/test", requireOwnerAuth, jsonParser, handleOpenAITest);
app.post("/api/openai/chat", requireOwnerAuth, jsonParser, handleOpenAIChat);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not_found" });
});

const dashboardDistDir = path.resolve(
  import.meta.dirname,
  "../../dashboard/dist",
);
const indexHtmlPath = path.join(dashboardDistDir, "index.html");
const hasStaticDashboard = fs.existsSync(indexHtmlPath);

if (hasStaticDashboard) {
  app.use(express.static(dashboardDistDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(indexHtmlPath);
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const errObj = err as { type?: unknown; status?: unknown } | null;
  if (errObj?.type === "entity.too.large" || errObj?.status === 413) {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }
  if (err instanceof SyntaxError && errObj?.status === 400) {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  res.status(500).json({ error: "internal_error" });
});

app.listen(env.port, () => {
  console.log(
    `[muse-relay-server] listening on http://localhost:${env.port} ` +
      `(dropbox=${isDropboxConfigured()}, staticDashboard=${hasStaticDashboard})`,
  );
});
