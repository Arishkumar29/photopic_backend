import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { getBulkPhotoDir, ensureDirExists, removeDirSync } from "../services/storageService";
import { scrapeDriveFolderEntries, proxyDriveFileContent } from "../services/driveService";

export interface EventData {
  eventId: string;
  folderId: string;
  accessToken: string;
  orgName: string;
  eventName: string;
  photos: string[];
  driveFiles?: { id: string; thumbUrl: string; name: string }[];
  coverImage?: string;
}

export const events: Record<string, EventData> = {};

const getDbFilePath = () => path.join(getBulkPhotoDir(), "events_db.json");

function saveEventsToDisk() {
  try {
    const dbPath = getDbFilePath();
    const dir = path.dirname(dbPath);
    ensureDirExists(dir);
    fs.writeFileSync(dbPath, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error("Failed to save events to disk:", err);
  }
}

function loadEventsFromDisk() {
  try {
    const dbPath = getDbFilePath();
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath, "utf-8");
      const loaded = JSON.parse(data);
      Object.assign(events, loaded);
    }
  } catch (err) {
    console.error("Failed to load events from disk:", err);
  }

  if (Object.keys(events).length === 0) {
    const sampleEventId = "evt_sample";
    const eventDir = getBulkPhotoDir(sampleEventId);
    ensureDirExists(eventDir);

    const photos: string[] = [];
    const samplesDir = path.join(process.cwd(), "bulk_photo_samples");
    if (fs.existsSync(samplesDir)) {
      const sampleFiles = fs.readdirSync(samplesDir);
      for (const file of sampleFiles) {
        const srcPath = path.join(samplesDir, file);
        const destPath = path.join(eventDir, file);
        fs.copyFileSync(srcPath, destPath);
        photos.push(`/bulk_photo/${sampleEventId}/${file}`);
      }
    }

    events[sampleEventId] = {
      eventId: sampleEventId,
      folderId: "local_upload",
      accessToken: "sample_token",
      orgName: "Photopic Studio",
      eventName: "Summer Celebration & Gala 2026",
      photos,
      coverImage: "https://images.unsplash.com/photo-1519741497674-611481863552?w=800&auto=format&fit=crop&q=80"
    };

    saveEventsToDisk();
  }
}

loadEventsFromDisk();

export const createEvent = async (req: Request, res: Response) => {
  const { eventId, folderId, accessToken = "default_token", orgName, eventName, coverImage } = req.body;
  if (!eventId || !folderId) {
    return res.status(400).json({ error: "Missing required parameters: eventId and folderId are required" });
  }

  try {
    const eventDir = getBulkPhotoDir(eventId);
    ensureDirExists(eventDir);

    const photos: string[] = [];

    if (folderId === 'local_upload') {
      const rootDir = getBulkPhotoDir();
      if (fs.existsSync(rootDir)) {
        const rootFiles = fs.readdirSync(rootDir);
        for (const file of rootFiles) {
          const srcPath = path.join(rootDir, file);
          const stats = fs.statSync(srcPath);
          if (stats.isFile() && file !== "README.md" && !file.startsWith("temp_selfie_")) {
            const destPath = path.join(eventDir, file);
            fs.copyFileSync(srcPath, destPath);
            try {
              fs.unlinkSync(srcPath);
            } catch (e) {
              console.warn(`Could not delete original file ${srcPath} after copy:`, e);
            }
            photos.push(`/bulk_photo/${eventId}/${file}`);
          }
        }
      }

      if (photos.length === 0) {
        console.log("No photos uploaded. Falling back to local sample photos.");
        const samplesDir = path.join(process.cwd(), "bulk_photo_samples");
        if (fs.existsSync(samplesDir)) {
          const sampleFiles = fs.readdirSync(samplesDir);
          for (const file of sampleFiles) {
            const srcPath = path.join(samplesDir, file);
            const destPath = path.join(eventDir, file);
            fs.copyFileSync(srcPath, destPath);
            photos.push(`/bulk_photo/${eventId}/${file}`);
          }
        }
      }

      events[eventId] = {
        eventId,
        folderId,
        accessToken,
        orgName: orgName || "Photographer",
        eventName: eventName || "New Event",
        photos,
        coverImage
      };
    } else {
      const driveFiles = await scrapeDriveFolderEntries(folderId);
      events[eventId] = {
        eventId,
        folderId,
        accessToken,
        orgName: orgName || "Photographer",
        eventName: eventName || "New Event",
        photos: [],
        driveFiles,
        coverImage
      };
      saveEventsToDisk();
    }

    saveEventsToDisk();
    res.json({ success: true });
  } catch (error: any) {
    console.error("Failed to create event:", error);
    res.status(500).json({ error: "Failed to create event" });
  }
};

export const getEvents = (req: Request, res: Response) => {
  res.json({ events: Object.values(events) });
};

export const deleteEvent = (req: Request, res: Response) => {
  const { eventId } = req.params;
  if (events[eventId]) {
    const eventDir = getBulkPhotoDir(eventId);
    removeDirSync(eventDir);
    delete events[eventId];
    saveEventsToDisk();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Event not found" });
  }
};

export const updateEvent = async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const { eventName, orgName, coverImage, description, eventLocation, eventType, folderId } = req.body;
  const event = events[eventId];
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  if (eventName !== undefined) event.eventName = eventName;
  if (orgName !== undefined) event.orgName = orgName;
  if (coverImage !== undefined) event.coverImage = coverImage;
  if (description !== undefined) (event as any).description = description;
  if (eventLocation !== undefined) (event as any).eventLocation = eventLocation;
  if (eventType !== undefined) (event as any).eventType = eventType;

  if (folderId !== undefined && folderId !== event.folderId) {
    event.folderId = folderId;
    if (folderId !== 'local_upload' && folderId.trim()) {
      try {
        const driveFiles = await scrapeDriveFolderEntries(folderId);
        event.driveFiles = driveFiles;
      } catch (e) {
        console.warn("Could not scrape updated Drive folder:", e);
      }
    }
  }

  saveEventsToDisk();
  res.json({ success: true, event });
};

export const uploadEventPhotos = (req: Request, res: Response) => {
  const { eventId } = req.params;
  const event = events[eventId];
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  try {
    const eventDir = getBulkPhotoDir(eventId);
    ensureDirExists(eventDir);

    const rootDir = getBulkPhotoDir();
    const files = fs.readdirSync(rootDir);
    const addedPhotos: string[] = [];

    for (const file of files) {
      const srcPath = path.join(rootDir, file);
      const stats = fs.statSync(srcPath);
      if (stats.isFile() && file !== "README.md" && !file.startsWith("temp_selfie_")) {
        const destPath = path.join(eventDir, file);
        fs.copyFileSync(srcPath, destPath);
        try {
          fs.unlinkSync(srcPath);
        } catch (e) {
          console.warn(`Could not delete original file ${srcPath} after copy:`, e);
        }
        const photoUrl = `/bulk_photo/${eventId}/${file}`;
        if (!event.photos.includes(photoUrl)) {
          event.photos.push(photoUrl);
        }
        addedPhotos.push(photoUrl);
      }
    }

    saveEventsToDisk();
    res.json({ success: true, photos: event.photos });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to upload photos to event" });
  }
};

export const clearEventPhotos = (req: Request, res: Response) => {
  const { eventId } = req.params;
  const event = events[eventId];
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  try {
    const eventDir = getBulkPhotoDir(eventId);
    if (fs.existsSync(eventDir)) {
      const files = fs.readdirSync(eventDir);
      for (const file of files) {
        fs.unlinkSync(path.join(eventDir, file));
      }
    }
    event.photos = [];
    saveEventsToDisk();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to clear event photos" });
  }
};

export const proxyDriveImage = async (req: Request, res: Response) => {
  const { fileId } = req.params;
  try {
    const { buffer, contentType } = await proxyDriveFileContent(fileId);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch (err: any) {
    console.warn(`Drive proxy stream failed for ${fileId}, redirecting directly to Google CDN:`, err?.message || err);
    return res.redirect(`https://lh3.googleusercontent.com/d/${fileId}=w1600`);
  }
};
