import { Router } from "express";
import multer from "multer";
import {
  createEvent,
  getEvents,
  deleteEvent,
  updateEvent,
  uploadEventPhotos,
  clearEventPhotos,
  proxyDriveImage
} from "../controllers/eventController.js";
import { getBulkPhotoDir, ensureDirExists } from "../services/storageService.js";

const router = Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = getBulkPhotoDir();
    ensureDirExists(dest);
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "GWC PhotoPic Backend",
    engine: "OpenCV SFace 512-d Biometrics",
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

router.post("/create-event", createEvent);
router.get("/events", getEvents);
router.put("/events/:eventId", updateEvent);
router.delete("/events/:eventId", deleteEvent);
router.post("/events/:eventId/upload", upload.array("photos"), uploadEventPhotos);
router.post("/events/:eventId/clear", clearEventPhotos);
router.get("/drive-proxy/:fileId", proxyDriveImage);

export default router;
