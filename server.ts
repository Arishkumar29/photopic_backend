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

// ── Root Health Check ────────────────────────────────────────────────
app.get("/", (req, res) => {
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