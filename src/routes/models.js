import { Router } from 'express';
import { listModels, getModel } from '../controllers/modelsController.js';

export const router = Router();

// GET /api/v1/models
router.get('/', listModels);

// GET /api/v1/models/:modelId
router.get('/:modelId', getModel);
