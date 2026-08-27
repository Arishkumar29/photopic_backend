import { Router } from "express";
import {
  trackVisit,
  trackView,
  trackDownload,
  getAnalytics
} from "../controllers/analyticsController.js";

const router = Router();

router.post("/events/:eventId/track-visit", trackVisit);
router.post("/events/:eventId/track-view", trackView);
router.post("/events/:eventId/track-download", trackDownload);
router.get("/analytics", getAnalytics);

export default router;
