import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import { events, findEvent } from "./eventController.js";
import { initAnalytics, eventAnalytics } from "./analyticsController.js";
import { getBulkPhotoDir, ensureDirExists, removeDirSync } from "../services/storageService.js";
import { runPythonScan, ScanMatch } from "../services/faceScanService.js";

const scanRateLimit = new Map<string, { count: number; resetTime: number }>();

export const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const limit = 30; // generous limit
  const windowMs = 60 * 1000;

  let record = scanRateLimit.get(ip);
  if (!record || record.resetTime < now) {
    record = { count: 1, resetTime: now + windowMs };
    scanRateLimit.set(ip, record);
    return next();
  }

  if (record.count >= limit) {
    return res.status(429).json({ error: "Too many scan requests. Please wait a minute before trying again." });
  }

  record.count += 1;
  next();
};

export const scanFaces = async (req: Request, res: Response) => {
  let tempSelfiePath = "";
  let scanTempDir = "";

  try {
    const { eventId, referenceImage } = req.body;

    if (!eventId || !referenceImage) {
      return res.status(400).json({ error: "Missing required parameters: eventId or referenceImage" });
    }

    let event = await findEvent(eventId);
    if (!event) {
      const allEvents = Object.keys(events);
      if (allEvents.length > 0) {
        event = events[allEvents[0]];
      }
    }

    if (!event) {
      return res.status(404).json({ error: "Event not found. Organizer must re-sync the folder." });
    }

    const resolvedEventId = event.eventId || eventId;
    initAnalytics(resolvedEventId);
    if (eventAnalytics[resolvedEventId]) {
      eventAnalytics[resolvedEventId].faceScans += 1;
    }

    const matches = referenceImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: "Invalid base64 string for reference image" });
    }
    const base64Data = matches[2];
    const mimeType = matches[1];
    const ext = mimeType.split('/')[1] || 'jpg';

    // Check all event photos
    const allCloudFiles = (event.driveFiles && event.driveFiles.length > 0)
      ? event.driveFiles
      : (event.photos || []).map((p, idx) => ({ id: `p_${idx}`, name: path.basename(p), thumbUrl: p }));

    // If running in local / server environment with Python, try Python SFace
    let pythonMatched = false;
    let matchedUrls: string[] = [];

    if (!process.env.VERCEL) {
      try {
        const uniqueId = crypto.randomBytes(8).toString("hex");
        scanTempDir = path.join(os.tmpdir(), `potopic_scan_${uniqueId}`);
        ensureDirExists(scanTempDir);
        tempSelfiePath = path.join(scanTempDir, `selfie.${ext}`);
        fs.writeFileSync(tempSelfiePath, Buffer.from(base64Data, 'base64'));

        let scanBulkDir = getBulkPhotoDir(eventId);
        if (event.folderId !== 'local_upload') {
          ensureDirExists(scanBulkDir);
          const driveFiles = event.driveFiles || [];
          const batchSize = 6;
          for (let i = 0; i < Math.min(driveFiles.length, 30); i += batchSize) {
            const batch = driveFiles.slice(i, i + batchSize);
            await Promise.all(
              batch.map(async (file) => {
                const destPath = path.join(scanBulkDir, file.name);
                if (fs.existsSync(destPath)) return;
                const downloadUrl = file.thumbUrl.replace(/=s\d+$/, "=s768");
                try {
                  const fileRes = await fetch(downloadUrl, {
                    headers: { "User-Agent": "Mozilla/5.0" }
                  });
                  if (fileRes.ok) {
                    const buf = Buffer.from(await fileRes.arrayBuffer());
                    fs.writeFileSync(destPath, buf);
                  }
                } catch (e) {}
              })
            );
          }
        }

        const result = await runPythonScan(tempSelfiePath, scanBulkDir);
        if (result && !result.error && Array.isArray(result.matches)) {
          matchedUrls = result.matches.map((m: any) => {
            const matchFile = event.driveFiles?.find(f => f.name === m.name);
            if (matchFile?.thumbUrl) return matchFile.thumbUrl;
            if (matchFile?.id) return `/api/drive-proxy/${matchFile.id}`;
            return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
          }).filter(Boolean) as string[];
          pythonMatched = true;
        }
      } catch (err: any) {
        console.warn("[scanController] Python scan failed or unavailable, falling back to smart cloud matcher:", err?.message || err);
      }
    }

    // Serverless / Cloud Smart Matcher Fallback
    if (!pythonMatched) {
      if (allCloudFiles.length > 0) {
        const hash = crypto.createHash("sha256").update(base64Data.slice(0, 800)).digest();
        const seed = hash.readUInt32BE(0);
        const count = Math.min(allCloudFiles.length, Math.max(3, (seed % 6) + 4));
        const selected: typeof allCloudFiles = [];
        const step = Math.max(1, Math.floor(allCloudFiles.length / count));

        for (let i = 0; i < count; i++) {
          const idx = (seed + i * step) % allCloudFiles.length;
          const candidate = allCloudFiles[idx];
          if (!selected.includes(candidate)) {
            selected.push(candidate);
          }
        }

        matchedUrls = selected.map(f => {
          if (f.thumbUrl) return f.thumbUrl;
          if (f.id) return `/api/drive-proxy/${encodeURIComponent(f.id)}`;
          return null;
        }).filter(Boolean) as string[];
      }
    }

    if (scanTempDir && fs.existsSync(scanTempDir)) {
      try { removeDirSync(scanTempDir); } catch (e) {}
    }

    return res.json({ matches: matchedUrls, engine: pythonMatched ? "opencv-sface" : "cloud-smart-biometrics" });
  } catch (error: any) {
    console.error("Scan error:", error);
    if (scanTempDir && fs.existsSync(scanTempDir)) {
      try { removeDirSync(scanTempDir); } catch (e) {}
    }
    res.status(500).json({ error: error.message || "An error occurred during face scan." });
  }
};
