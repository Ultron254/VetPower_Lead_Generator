/**
 * VetPower Lead Engine — REST API Server
 * 
 * This Express server provides a REST API for the main VetPower system
 * (app.vetpower.ai) to classify farmer conversations programmatically.
 * 
 * ENDPOINTS:
 *   POST /api/classify       — Classify a single session
 *   POST /api/classify-batch  — Classify multiple sessions (max 50 per request)
 *   GET  /api/health          — Health check
 * 
 * AUTHENTICATION:
 *   All /api/* endpoints require an API key via the x-api-key header.
 *   Set the API_SERVER_KEY environment variable to define the key.
 * 
 * SETUP:
 *   npm install express cors helmet
 *   VITE_ANTHROPIC_KEY=sk-... API_SERVER_KEY=your-secret node server/api.js
 * 
 * PRODUCTION:
 *   Use PM2 or systemd to keep the process alive.
 *   pm2 start server/api.js --name vetpower-api
 */

import express from 'express';
import cors from 'cors';

// ============================================
// CONFIG
// ============================================

const PORT = process.env.API_PORT || 3001;
const ANTHROPIC_KEY = process.env.VITE_ANTHROPIC_KEY || '';
const API_SERVER_KEY = process.env.API_SERVER_KEY || 'vetpower-api-key-change-me';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1024;

// ============================================
// SYSTEM PROMPT (same as frontend)
// ============================================

const SYS_PROMPT = `You are a veterinary commercial opportunity classifier for VetPower, an AI-powered livestock knowledge platform in Kenya. Your job is to read farmer-AI conversation sessions and identify lead generation opportunities.

CONTEXT: VetPower helps Kenyan farmers with animal health via WhatsApp. The company monetises by connecting farmers to products and services. You must classify each session into commercial opportunity categories.

CATEGORIES (a session can have MULTIPLE categories):
1. OTC Medication — Over-the-counter products from an agrovet: dewormers, acaricides, insecticides, oral multivitamins, mineral/salt licks, nutritional supplements, disinfectants, antiseptics, ORS, calcium supplements, teat dips, wound sprays, eye ointments.
2. Veterinary Prescription — Injectable medications requiring a registered vet: antibiotics (injectable), parasiticides (injectable), vaccines, injectable vitamins, anti-inflammatories, flukicides, calcium injections.
3. Veterinary Visit — Farmer needs a vet on-farm OR condition requires hands-on intervention (surgery, difficult calving, severe wounds, prolapse, bloat). Also flag when Veterinary Prescription requires vet administration.
4. Artificial Insemination — Breeding, heat detection, serving timing, semen selection, AI services.
5. Laboratory Work — AI identifies 2-4 differential diagnoses needing lab confirmation: faecal analysis, blood tests, cultures, post-mortem, skin scraping.
6. Feeds — Feed formulations, dairy meal, feed ingredients/ratios, silage, hay, nutrition-related purchases.
7. Hardware — Equipment: brooder lamps, silage bags, feeders, drinkers, weighing tapes, hygiene equipment, sprayers.
8. Agrovet Connection — Farmer needs to find/be connected to a local agrovet shop.

ADDITIONAL FLAGS:
- Off-Topic: Farmer asked about crops, bees, or non-livestock topics. Specify subject.
- No Opportunity: Session too short, abandoned, or no commercial lead. Provide reason.

RULES:
- Flag ALL applicable categories per session (multiple is normal).
- Be SPECIFIC about products. Use Kenyan brand names.
- Rate confidence: High (clear/explicit need), Medium (likely but not stated), Low (possible but speculative).
- If you spot revenue opportunities outside the 8 categories, note them in other_opportunities.

OUTPUT FORMAT — respond ONLY with this JSON, no other text:
{
  "categories": [
    {
      "category": "Category Name",
      "confidence": "High|Medium|Low",
      "products": "Specific products and brand names, or null",
      "reasoning": "Brief explanation (1-2 sentences)"
    }
  ],
  "off_topic": true|false,
  "off_topic_subject": "crops|bees|aquaculture|other|null",
  "no_opportunity": true|false,
  "no_opportunity_reason": "reason or null",
  "other_opportunities": "Description of other revenue ideas, or null",
  "lead_summary": "One-line plain English summary for the sales team"
}`;

// Rate limiting removed — Anthropic's own API rate limits are sufficient
// and the retry/backoff logic in the frontend handles 429 responses gracefully

// ============================================
// HELPERS
// ============================================

function sanitize(str, maxLen = 5000) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .slice(0, maxLen);
}

function buildMessage(session) {
  const s = session;
  return `SESSION ID: ${s.sessionId || 'unknown'}
Animal Type: ${sanitize(s.animalType) || 'Not specified'}
Issue Category: ${sanitize(s.issueCategory) || 'Not specified'}
Issue Description: ${sanitize(s.issueDescription) || 'Not specified'}
Farmer: ${sanitize(s.farmerName) || 'Unknown'}, County: ${sanitize(s.county) || 'Unknown'}, Ward: ${sanitize(s.ward) || 'Unknown'}, Phone: ${sanitize(s.phone) || 'Unknown'}

CONVERSATION:
${sanitize(s.conversation, 50000)}

Classify this session into commercial opportunity categories.`;
}

async function classifySession(session) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYS_PROMPT,
      messages: [{ role: 'user', content: buildMessage(session) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (body.includes('credit balance')) {
      throw new Error('CREDITS_DEPLETED: Anthropic API credit balance is too low.');
    }
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  let text = data.content?.[0]?.text || '';
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) text = match[1];
  
  return JSON.parse(text.trim());
}

// ============================================
// EXPRESS APP
// ============================================

const app = express();

// Security middleware
app.use(cors({
  origin: [
    'https://app.vetpower.ai',
    'https://leads.vetpower.ai',
    'https://vetpower.ai',
    'http://54.216.142.24',
    'http://localhost:5173',
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));
app.use(express.json({ limit: '50mb' }));

// SECURITY: API key authentication middleware
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_SERVER_KEY) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or missing API key. Include x-api-key header.',
    });
  }
  next();
}


// ============================================
// ROUTES
// ============================================

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'VetPower Lead Engine API',
    version: '1.0.0',
    model: ANTHROPIC_MODEL,
    hasApiKey: !!ANTHROPIC_KEY,
    timestamp: new Date().toISOString(),
  });
});

// Classify a single session
app.post('/api/classify', authenticate, async (req, res) => {
  try {
    const { session } = req.body;
    if (!session || typeof session !== 'object') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Request body must contain a "session" object with sessionId, conversation, etc.',
      });
    }
    if (!session.conversation) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Session must include a "conversation" field.',
      });
    }

    const classification = await classifySession(session);
    res.json({
      success: true,
      sessionId: session.sessionId || 'unknown',
      classification,
    });
  } catch (err) {
    const status = err.message.includes('CREDITS_DEPLETED') ? 402 : 500;
    res.status(status).json({
      error: status === 402 ? 'Payment Required' : 'Classification Failed',
      message: err.message,
    });
  }
});

// Classify multiple sessions (batch, max 50)
app.post('/api/classify-batch', authenticate, async (req, res) => {
  try {
    const { sessions } = req.body;
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Request body must contain a "sessions" array.',
      });
    }
    if (sessions.length > 200) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Maximum 200 sessions per batch request. Split into smaller batches.',
      });
    }

    // Process in parallel (10 at a time)
    const CONCURRENCY = 10;
    const results = [];
    for (let i = 0; i < sessions.length; i += CONCURRENCY) {
      const chunk = sessions.slice(i, Math.min(i + CONCURRENCY, sessions.length));
      const chunkResults = await Promise.all(
        chunk.map(async (session) => {
          try {
            const classification = await classifySession(session);
            return { sessionId: session.sessionId || 'unknown', classification, error: null };
          } catch (err) {
            return { sessionId: session.sessionId || 'unknown', classification: null, error: err.message };
          }
        })
      );
      results.push(...chunkResults);
    }

    const successful = results.filter(r => r.classification).length;
    const failed = results.filter(r => r.error).length;

    res.json({
      success: true,
      total: results.length,
      successful,
      failed,
      results,
    });
  } catch (err) {
    res.status(500).json({
      error: 'Batch Classification Failed',
      message: err.message,
    });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`\n🚀 VetPower Lead Engine API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   API Key configured: ${!!ANTHROPIC_KEY}`);
  console.log(`   Model: ${ANTHROPIC_MODEL}\n`);
});
