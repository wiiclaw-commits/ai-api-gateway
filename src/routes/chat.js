import { Router } from 'express';
import { chatCompletion } from '../controllers/chatController.js';

export const router = Router();

// POST /api/v1/chat/completions
router.post('/completions', chatCompletion);
