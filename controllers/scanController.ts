import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import { events } from "./eventController";
import { initAnalytics, eventAnalytics } from "./analyticsController";
import { getBulkPhotoDir, ensureDirExists, removeDirSync } from "../services/storageService";
import { runPythonScan, ScanMatch } from "../services/faceScanService";

const scanRateLimit = new Map<string, { count: number; resetTime: number }>();

export const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const limit = 5;
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

    let event = events[eventId];
    if (!event) {
      const allEvents = Object.keys(events);
      if (allEvents.length > 0) {
        event = events[allEvents[0]];
      }
    }

    if (!event) {
      return res.status(404).json({ error: "Event not found or expired. Organizer must re-sync the folder." });
    }

    const resolvedEventId = event.eventId || eventId;
    initAnalytics(resolvedEventId);
    eventAnalytics[resolvedEventId].faceScans += 1;

    const matches = referenceImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: "Invalid base64 string for reference image" });
    }
    const base64Data = matches[2];
    const mimeType = matches[1];
    const ext = mimeType.split('/')[1] || 'jpg';

    const uniqueId = crypto.randomBytes(8).toString("hex");
    scanTempDir = path.join(os.tmpdir(), `potopic_scan_${uniqueId}`);
    ensureDirExists(scanTempDir);

    tempSelfiePath = path.join(scanTempDir, `selfie.${ext}`);
    fs.writeFileSync(tempSelfiePath, Buffer.from(base64Data, 'base64'));

    let scanBulkDir = getBulkPhotoDir(eventId);

    if (event.folderId !== 'local_upload') {
      ensureDirExists(scanBulkDir);
      const driveFiles = event.driveFiles || [];
      console.log(`Checking and downloading transient files from Drive into event cache...`);

      const batchSize = 8;
      for (let i = 0; i < driveFiles.length; i += batchSize) {
        const batch = driveFiles.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (file) => {
            const destPath = path.join(scanBulkDir, file.name);
            if (fs.existsSync(destPath)) {
              return;
            }

            const downloadUrl = file.thumbUrl.replace(/=s\d+$/, "=s768");
            const maxRetries = 3;
            let success = false;
            let attempt = 0;

            while (attempt < maxRetries && !success) {
              attempt++;
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 12000);

              try {
                const fileRes = await fetch(downloadUrl, {
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": "https://drive.google.com/",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
                  },
                  signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!fileRes.ok) {
                  throw new Error(`Download status: ${fileRes.status}`);
                }

                const buffer = Buffer.from(await fileRes.arrayBuffer());
                fs.writeFileSync(destPath, buffer);
                success = true;
              } catch (err: any) {
                clearTimeout(timeoutId);
                const isAbort = err.name === 'AbortError';
                const errMsg = isAbort ? 'Request timed out (12s)' : err.message || err;
                console.warn(`[Transient Attempt ${attempt}/${maxRetries}] Failed to download ${file.name}: ${errMsg}`);
                if (attempt < maxRetries) {
                  await new Promise(resolve => setTimeout(resolve, attempt * 500));
                }
              }
            }
          })
        );
      }
    }

    let resultMatches: ScanMatch[] = [];

    // Always use Python SFace + OpenCV engine (accurate, free, no API key needed)
    console.log(`Running SFace + OpenCV face scan for event ${eventId} (${fs.existsSync(scanBulkDir) ? fs.readdirSync(scanBulkDir).length : 0} files)...`);
    const result = await runPythonScan(tempSelfiePath, scanBulkDir);
    if (result.error) {
      throw new Error(result.error);
    }
    resultMatches = (result.matches || []).map((m: any) => ({
      name: m.name,
      confidence: m.confidence
    }));

    let matchedUrls: string[] = [];
    matchedUrls = resultMatches.map((m: any) => {
      // 1. If file exists in local event cache directory, serve directly (fast & reliable)
      const localFilePath = path.join(scanBulkDir, m.name);
      if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 100) {
        return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
      }

      // 2. Otherwise route via Drive proxy
      const matchFile = event.driveFiles?.find(f => f.name === m.name);
      if (!matchFile) return null;
      return `/api/drive-proxy/${matchFile.id}`;
    }).filter(Boolean) as string[];

    if (scanTempDir && fs.existsSync(scanTempDir)) {
      removeDirSync(scanTempDir);
    }

    res.json({ matches: matchedUrls });
  } catch (error: any) {
    console.error("Scan error:", error);
    if (scanTempDir && fs.existsSync(scanTempDir)) {
      removeDirSync(scanTempDir);
    }
    res.status(500).json({ error: error.message || "An error occurred during face scan." });
  }
};
