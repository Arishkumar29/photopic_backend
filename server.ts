import express from "express";
import path from "path";
import fs from "fs";
import "dotenv/config";

import eventRoutes from "./routes/eventRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import scanRoutes from "./routes/scanRoutes.js";
import { getBulkPhotoDir, getProjectRootDir } from "./services/storageService.js";
import { connectDB } from "./services/dbService.js";
import { loadEventsFromDB } from "./controllers/eventController.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const projectRoot = getProjectRootDir();
const frontendRoot = path.join(projectRoot, "frontend");
const distRoot = fs.existsSync(path.join(frontendRoot, "dist"))
  ? path.join(frontendRoot, "dist")
  : path.join(projectRoot, "dist");

// ── CORS — allow any frontend origin to call the backend ────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With,Accept");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Ensure DB connection is active for each incoming request (handles serverless cold starts)
app.use(async (req, res, next) => {
  if (process.env.MONGODB_URI) {
    try {
      await connectDB();
    } catch (e) {}
  }
  next();
});

app.use(express.json({ limit: "50mb" }));

// ── Root Handler & Status Page ──────────────────────────────────────────
app.get("/", (req, res) => {
  const acceptsHtml = req.headers.accept?.includes("text/html");
  if (acceptsHtml) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GWC PhotoPic — Cloud Backend API</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 15% 15%, rgba(110, 43, 139, 0.25) 0%, transparent 45%),
                  radial-gradient(circle at 85% 85%, rgba(218, 119, 86, 0.2) 0%, transparent 45%),
                  #0a0714;
      color: #f1f5f9;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(20px);
      border-radius: 28px;
      padding: 44px 36px;
      max-width: 640px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
      text-align: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(34, 197, 94, 0.12);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #4ade80;
      font-size: 12px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 9999px;
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 10px #22c55e;
    }
    h1 {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 12px;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p.subtitle {
      color: #94a3b8;
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .btn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 32px;
    }
    @media (max-width: 580px) {
      .btn-grid { grid-template-columns: 1fr; }
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 16px 20px;
      border-radius: 18px;
      font-size: 14px;
      font-weight: 700;
      text-decoration: none;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .btn-primary {
      background: linear-gradient(135deg, #6e2b8b 0%, #da7756 100%);
      color: #ffffff;
      box-shadow: 0 10px 25px -5px rgba(110, 43, 139, 0.4);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 30px -5px rgba(110, 43, 139, 0.6);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e2e8f0;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(-2px);
    }
    .endpoints {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      padding: 16px;
      text-align: left;
    }
    .endpoints-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748b;
      margin-bottom: 10px;
    }
    .endpoints-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .ep-badge {
      background: rgba(110, 43, 139, 0.2);
      border: 1px solid rgba(110, 43, 139, 0.3);
      color: #c084fc;
      font-family: monospace;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 8px;
      text-decoration: none;
    }
    .ep-badge:hover {
      background: rgba(110, 43, 139, 0.4);
    }
    footer {
      margin-top: 24px;
      color: #64748b;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">
      <span class="badge-dot"></span> PhotoPic Cloud API Live
    </div>
    <h1>PhotoPic Backend Engine</h1>
    <p class="subtitle">
      The serverless API is online and powering real-time face matching, OneDrive/Google Drive sync, and biometric search.
    </p>

    <div class="btn-grid">
      <a href="https://photopic-admin.vercel.app" target="_blank" class="btn btn-primary">
        🚀 Launch Admin Portal
      </a>
      <a href="https://photopic-frontend.vercel.app" target="_blank" class="btn btn-secondary">
        📱 Launch Guest Experience
      </a>
    </div>

    <div class="endpoints">
      <div class="endpoints-title">Active API Endpoints</div>
      <div class="endpoints-list">
        <a href="/api/events" class="ep-badge">GET /api/events</a>
        <a href="/api/health" class="ep-badge">GET /api/health</a>
        <a href="/api/analytics" class="ep-badge">GET /api/analytics</a>
      </div>
    </div>
  </div>
  <footer>GWC PhotoPic Engine • OpenCV SFace 512-d Biometrics • Vercel Serverless</footer>
</body>
</html>`);
  }

  res.json({
    status: "ok",
    service: "GWC PhotoPic Backend API",
    message: "PhotoPic API is live and operational.",
    environment: process.env.VERCEL ? "vercel-serverless" : "standalone",
    endpoints: [
      "/api/events",
      "/api/create-event",
      "/api/scan-faces",
      "/api/analytics",
      "/api/health"
    ]
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// ── Static Bulk Photos Handler ────────────────────────────────────────
app.use("/bulk_photo", (req, res, next) => {
  const rawPath = req.path;
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch (e) {}

  const candidates = [
    getBulkPhotoDir(decodedPath),
    getBulkPhotoDir(rawPath),
    path.join(projectRoot, "bulk_photo", decodedPath),
    path.join(projectRoot, "bulk_photo", rawPath),
    path.join(process.cwd(), "bulk_photo", decodedPath),
    path.join(process.cwd(), "bulk_photo", rawPath)
  ];

  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return res.sendFile(path.resolve(p));
    }
  }
  next();
});

// ── Register API Routes (both with /api prefix and at root for flexibility) ──
app.use("/api", eventRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", scanRoutes);

app.use(eventRoutes);
app.use(analyticsRoutes);
app.use(scanRoutes);

// ── Standalone Server Starter ────────────────────────────────────────
async function startServer() {
  // Connect to MongoDB and load events (falls back to disk/memory if no MONGODB_URI)
  await connectDB();
  await loadEventsFromDB();

  const hasFrontendModules = fs.existsSync(path.join(frontendRoot, "node_modules", "vite"));
  
  if (process.env.NODE_ENV !== "production" && hasFrontendModules) {
    try {
      // @ts-ignore — vite is a frontend dev-only dep, dynamically imported only in dev mode
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        root: frontendRoot,
        configFile: path.join(frontendRoot, "vite.config.js"),
        server: { middlewareMode: true },
        appType: "custom",
      });
      app.use(vite.middlewares);

      app.get("*", async (req, res, next) => {
        if (req.path.startsWith("/api") || req.path.startsWith("/bulk_photo")) {
          return next();
        }
        if (req.path.startsWith("/@") || req.path.startsWith("/node_modules") || req.path.match(/\.(js|jsx|ts|tsx|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2|map)$/)) {
          return next();
        }

        const url = req.originalUrl;
        try {
          const indexPath = path.join(frontendRoot, "index.html");
          if (!fs.existsSync(indexPath)) {
            return res.status(404).send("index.html not found");
          }
          let template = fs.readFileSync(indexPath, "utf-8");
          template = await vite.transformIndexHtml(url, template);
          res.status(200).set({ "Content-Type": "text/html" }).end(template);
        } catch (e) {
          vite.ssrFixStacktrace(e as Error);
          next(e);
        }
      });
    } catch (err) {
      console.log("Vite dev server bypassed. Running in standalone API mode.");
    }
  } else {
    if (fs.existsSync(distRoot)) {
      app.use(express.static(distRoot));
    }
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      const fallbackPort = Number(PORT) + 1;
      console.warn(`Port ${PORT} is in use. Retrying on port ${fallbackPort}...`);
      app.listen(fallbackPort, "0.0.0.0", () => {
        console.log(`Server running on http://localhost:${fallbackPort}`);
      });
    } else {
      console.error("Server startup error:", err);
    }
  });
}

const isServerless = Boolean(
  process.env.VERCEL ||
  process.env.NOW_REGION ||
  process.env.AWS_LAMBDA_FUNCTION_NAME
);

if (!isServerless) {
  startServer();
} else {
  // Serverless (Vercel): connect DB once per cold start
  connectDB().then(() => loadEventsFromDB()).catch(console.error);
}

export default app;