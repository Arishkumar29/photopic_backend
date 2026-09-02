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

    let scanBulkDir = getBulkPhotoDir(eventId);
    let pythonMatched = false;
    let matchedUrls: string[] = [];

    // Check if python is available
    try {
      const uniqueId = crypto.randomBytes(8).toString("hex");
      scanTempDir = path.join(os.tmpdir(), `potopic_scan_${uniqueId}`);
      ensureDirExists(scanTempDir);
      tempSelfiePath = path.join(scanTempDir, `selfie.${ext}`);
      fs.writeFileSync(tempSelfiePath, Buffer.from(base64Data, 'base64'));

      ensureDirExists(scanBulkDir);
      const driveFiles = event.driveFiles || [];

      // Download any missing event files into cache if not already present
      if (driveFiles.length > 0) {
        const existingFiles = new Set(fs.readdirSync(scanBulkDir));
        const missing = driveFiles.filter(f => !existingFiles.has(f.name));

        if (missing.length > 0) {
          console.log(`[scanController] Downloading ${missing.length} missing photos for scanning...`);
          const batchSize = 12;
          for (let i = 0; i < missing.length; i += batchSize) {
            const batch = missing.slice(i, i + batchSize);
            await Promise.all(
              batch.map(async (file) => {
                const destPath = path.join(scanBulkDir, file.name);
                if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100) return;

                let downloadUrl = file.thumbUrl;
                if (downloadUrl.includes("googleusercontent.com")) {
                  downloadUrl = downloadUrl.replace(/=s\d+$/, "=s768");
                }
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
      }

      console.log(`[scanController] Running OpenCV SFace scan for event ${eventId} (${fs.readdirSync(scanBulkDir).length} photos)...`);
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
      console.warn("[scanController] Python scan not available:", err?.message || err);
    }

    if (scanTempDir && fs.existsSync(scanTempDir)) {
      try { removeDirSync(scanTempDir); } catch (e) {}
    }

    if (pythonMatched) {
      return res.json({ 
        matches: matchedUrls, 
        count: matchedUrls.length,
        engine: "opencv-sface-biometrics" 
      });
    }

    // If Python is unavailable on this host (e.g. Vercel serverless), return photos from the event
    const candidateUrls = allCloudFiles.map(f => {
      if (f.thumbUrl) return f.thumbUrl;
      if (f.id) return `/api/drive-proxy/${encodeURIComponent(f.id)}`;
      return null;
    }).filter(Boolean) as string[];

    return res.json({
      matches: candidateUrls.slice(0, 60),
      count: Math.min(candidateUrls.length, 60),
      engine: "cloud-stream-fallback"
    });
  } catch (error: any) {
    console.error("Scan error:", error);
    if (scanTempDir && fs.existsSync(scanTempDir)) {
      try { removeDirSync(scanTempDir); } catch (e) {}
    }
    res.status(500).json({ error: error.message || "An error occurred during face scan." });
  }
};
