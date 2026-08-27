import { Router } from "express";
import { scanFaces, rateLimiter } from "../controllers/scanController.js";

const router = Router();

router.post("/scan-faces", rateLimiter, scanFaces);

export default router;
