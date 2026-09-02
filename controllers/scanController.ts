import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import { events, findEvent } from "./eventController.js";
import { initAnalytics, eventAnalytics } from "./analyticsController.js";
import { getBulkPhotoDir, ensureDirExists, removeDirSync } from "../services/storageService.js";
import { runPythonScan, runPythonSelfieVector } from "../services/faceScanService.js";
import { matchDescriptor } from "../services/faceEmbeddingService.js";
import { extractSFaceVector, matchSFaceAgainstSqlite } from "../services/sfaceMatcherService.js";

const scanRateLimit = new Map<string, { count: number; resetTime: number }>();

export const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const limit = 30;
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
    const { eventId, referenceImage, selfieDescriptor, croppedFaceImage } = req.body;

    if (!eventId || (!referenceImage && !selfieDescriptor)) {
      return res.status(400).json({ error: "Missing required parameters: eventId and referenceImage or selfieDescriptor" });
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

    // ─── PRIMARY PATH: Client-sent descriptor (works on Vercel) ──────────────
    // The browser extracts the 128-d face descriptor using face-api.js and sends it here.
    // We do pure-JS cosine similarity against pre-computed event photo embeddings.
    if (selfieDescriptor && Array.isArray(selfieDescriptor) && selfieDescriptor.length === 128) {
      const faceDescriptors = event.faceDescriptors || [];

      if (faceDescriptors.length > 0) {
        console.log(`[scanController] JS matching selfie descriptor against ${faceDescriptors.length} photos (Vercel-safe)`);
        const matches = matchDescriptor(selfieDescriptor as number[], faceDescriptors);

        return res.json({
          matches: matches.map(m => m.thumbUrl),
          count: matches.length,
          engine: "faceapi-js-cosine",
          details: matches.slice(0, 5),
        });
      }

      // No pre-computed descriptors yet — try to extract on-the-fly from referenceImage
      // and compare against all photos by downloading them (only works if Python path also fails)
      console.warn(`[scanController] No faceDescriptors for event ${resolvedEventId}. Falling back to photo list.`);
    }

    // ─── SECONDARY PATH: Server-side Python/OpenCV (local development) ───────
    // Works only when Python + OpenCV are available (local dev, Docker/Render).
    if (referenceImage) {
      const matches = referenceImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const base64Data = matches[2];
        const mimeType = matches[1];
        const ext = mimeType.split('/')[1] || 'jpg';

        const allCloudFiles = (event.driveFiles && event.driveFiles.length > 0)
          ? event.driveFiles
          : (event.photos || []).map((p, idx) => ({ id: `p_${idx}`, name: path.basename(p), thumbUrl: p }));

        let scanBulkDir = getBulkPhotoDir(eventId);
        let pythonMatched = false;
        let matchedUrls: string[] = [];

        // Try Python scan (local/Docker only)
        try {
          const uniqueId = crypto.randomBytes(8).toString("hex");
          scanTempDir = path.join(os.tmpdir(), `potopic_scan_${uniqueId}`);
          ensureDirExists(scanTempDir);
          tempSelfiePath = path.join(scanTempDir, `selfie.${ext}`);
          fs.writeFileSync(tempSelfiePath, Buffer.from(base64Data, 'base64'));

          ensureDirExists(scanBulkDir);

          const bulkFiles = fs.readdirSync(scanBulkDir);
          if (bulkFiles.length > 0) {
            console.log(`[scanController] Running OpenCV SFace scan (${bulkFiles.length} photos)...`);
            const result = await runPythonScan(tempSelfiePath, scanBulkDir);
            if (result && !result.error && Array.isArray(result.matches) && result.matches.length > 0) {
              matchedUrls = result.matches.map((m: any) => {
                const diskPath = path.join(scanBulkDir, m.name);
                if (fs.existsSync(diskPath)) {
                  return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
                }
                const matchFile = event!.driveFiles?.find(f => f.name === m.name);
                if (matchFile?.id) return `/api/drive-proxy/${matchFile.id}`;
                if (matchFile?.thumbUrl) return matchFile.thumbUrl.replace(/=s\d+$/, "=s1600");
                return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
              }).filter(Boolean) as string[];
              pythonMatched = true;
            }
          }
        } catch (err: any) {
          console.warn("[scanController] Python scan not available:", err?.message || err);
        }

        if (pythonMatched) {
          if (scanTempDir && fs.existsSync(scanTempDir)) {
            try { removeDirSync(scanTempDir); } catch (e) {}
          }
          return res.json({
            matches: matchedUrls,
            count: matchedUrls.length,
            engine: "opencv-sface-biometrics",
          });
        }

        // ─── SECONDARY PATH: SFace Biometrics (YuNet Aligned + Precision 0.44) ──
        try {
          let selfieVec: Float32Array | null = null;

          // 1. Try YuNet face detection & alignment first
          if (tempSelfiePath && fs.existsSync(tempSelfiePath)) {
            try {
              selfieVec = await runPythonSelfieVector(tempSelfiePath);
              if (selfieVec) {
                console.log("[scanController] Extracted YuNet-aligned SFace vector");
              }
            } catch (e) {}
          }

          // 2. Pure Node.js fallback if Python is unavailable (Vercel runtime)
          if (!selfieVec) {
            let faceBase64 = base64Data;
            let faceIsPng = mimeType.includes("png");

            if (croppedFaceImage && typeof croppedFaceImage === "string") {
              const cropMatch = croppedFaceImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (cropMatch && cropMatch.length === 3) {
                faceBase64 = cropMatch[2];
                faceIsPng = cropMatch[1].includes("png");
                console.log("[scanController] Using client-aligned face crop for Vercel SFace inference");
              }
            }

            const selfieBuffer = Buffer.from(faceBase64, "base64");
            selfieVec = await extractSFaceVector(selfieBuffer, faceIsPng);
          }

          const validFileNames = (event.driveFiles || []).map(f => f.name);
          // Set precision threshold to 0.44 to eliminate false positives
          const nodeMatches = matchSFaceAgainstSqlite(selfieVec, resolvedEventId, 0.44, validFileNames);

          if (nodeMatches.length > 0) {
            console.log(`[scanController] Precision SFace matched ${nodeMatches.length} photos!`);
            const matchedUrls = nodeMatches.map((m) => {
              const diskPath = path.join(scanBulkDir, m.name);
              if (fs.existsSync(diskPath)) {
                return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
              }
              const matchFile = event!.driveFiles?.find(f => f.name === m.name);
              if (matchFile?.id) return `/api/drive-proxy/${matchFile.id}`;
              if (matchFile?.thumbUrl) return matchFile.thumbUrl.replace(/=s\d+$/, "=s1600");
              return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
            }).filter(Boolean) as string[];

            return res.json({
              matches: matchedUrls,
              count: matchedUrls.length,
              engine: "sface-precision-biometrics",
            });
          }
        } catch (jsErr: any) {
          console.warn("[scanController] Precision SFace matching error:", jsErr?.message || jsErr);
        }

        // Return empty matches when no genuine biometric resemblance is found
        return res.json({
          matches: [],
          count: 0,
          engine: "sface-biometrics-zero-match",
          notice: "No matching photos found for this face in the event gallery.",
        });
      }
    }

    return res.status(400).json({ error: "Invalid or missing image data." });

  } catch (error: any) {
    console.error("Scan error:", error);
    if (scanTempDir && fs.existsSync(scanTempDir)) {
      try { removeDirSync(scanTempDir); } catch (e) {}
    }
    res.status(500).json({ error: error.message || "An error occurred during face scan." });
  }
};
