import express from "express";
import path from "path";
import fs from "fs";
import "dotenv/config";

import eventRoutes from "./routes/eventRoutes";
import analyticsRoutes from "./routes/analyticsRoutes";
import scanRoutes from "./routes/scanRoutes";
import { getBulkPhotoDir, getProjectRootDir } from "./services/storageService";

const app = express();
const PORT = process.env.PORT || 3000;
const projectRoot = getProjectRootDir();
const frontendRoot = path.join(projectRoot, "frontend");
const distRoot = fs.existsSync(path.join(frontendRoot, "dist"))
  ? path.join(frontendRoot, "dist")
  : path.join(projectRoot, "dist");

// ── CORS — allow Vercel frontend to call the Railway backend ──────────────────
app.use((req, res, next) => {
  const allowedOrigins = [
    process.env.FRONTEND_URL,   // set this on Railway to your Vercel URL
    'http://localhost:5173',
    'http://localhost:3000',
  ].filter(Boolean);
  const origin = req.headers.origin as string;
  if (!origin || allowedOrigins.includes(origin) || allowedOrigins.some(o => o && origin.endsWith('.vercel.app'))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "50mb" }));

// Serve static bulk photos from storage directory
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

// Register API routes
app.use("/api", eventRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", scanRoutes);

async function startServer() {
  const hasFrontendModules = fs.existsSync(path.join(frontendRoot, "node_modules", "vite"));
  
  if (process.env.NODE_ENV !== "production" && hasFrontendModules) {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        root: frontendRoot,
        configFile: path.join(frontendRoot, "vite.config.js"),
        server: { middlewareMode: true },
        appType: "custom",
      });
      app.use(vite.middlewares);

      app.get("*", async (req, res, next) => {
        // Never return index.html for static assets, JavaScript scripts, or Vite internal requests
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
    // Standalone API server mode (for Render/Railway production)
    if (fs.existsSync(distRoot)) {
      app.use(express.static(distRoot));
    }

    app.get("/", (req, res) => {
      res.json({
        status: "ok",
        service: "GWC PhotoPic Backend API",
        message: "API Server running. Frontend is hosted on Vercel.",
        endpoints: ["/api/events", "/api/create-event", "/api/scan-faces", "/api/analytics"]
      });
    });

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/bulk_photo")) {
        return next();
      }
      const indexPath = path.join(distRoot, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.json({
          status: "ok",
          service: "GWC PhotoPic Backend API",
          message: "API Server running. Frontend is hosted on Vercel."
        });
      }
    });
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

if (!process.env.VERCEL) {
  startServer();
}

export default app;
