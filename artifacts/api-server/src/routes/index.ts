import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videoRouter from "./video";
import playlistRouter from "./playlist";

const router: IRouter = Router();

router.use(healthRouter);
router.use(videoRouter);
router.use(playlistRouter);

export default router;
