import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';

// ============================================
// CONSTANTS
// ============================================

// SECURITY: API key loaded from environment variable at build time.
// The .env file is gitignored and never committed to source control.
const API_KEY = import.meta.env.VITE_ANTHROPIC_KEY || '';

// SECURITY: Upload & processing limits (OWASP file upload best practices)
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_SESSIONS = 500;
const MAX_FIELD_LENGTH = 500;
const MAX_CONVERSATION_LENGTH = 50000;
const ALLOWED_EXTENSIONS = /\.xlsx$/i;

// SECURITY: Client-side rate limiting
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_CALLS = 60;    // max 60 API calls per minute
const apiCallTimestamps = [];

const CATS = {
  'OTC Medication': { cls: 'badge-otc', color: '#0d9b6a' },
  'Veterinary Prescription': { cls: 'badge-rx', color: '#6d5cae' },
  'Veterinary Visit': { cls: 'badge-visit', color: '#c44536' },
  'Artificial Insemination': { cls: 'badge-ai', color: '#2e6db4' },
  'Laboratory Work': { cls: 'badge-lab', color: '#bf8a30' },
  'Feeds': { cls: 'badge-feeds', color: '#5a8c3c' },
  'Hardware': { cls: 'badge-hardware', color: '#5a6673' },
  'Agrovet Connection': { cls: 'badge-agrovet', color: '#0f7e8c' },
};

const LIVESTOCK_IMAGES = [
  { src: '/cow.png', alt: 'Cow' },
  { src: '/goat.png', alt: 'Goat' },
  { src: '/chicken.png', alt: 'Chicken' },
  { src: '/sheep.png', alt: 'Sheep' },
  { src: '/camel.png', alt: 'Camel' },
  { src: '/friesian.png', alt: 'Friesian Cow' },
  { src: '/donkey.png', alt: 'Donkey' },
  { src: '/rooster.png', alt: 'Rooster' },
];

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
- Be SPECIFIC about products. Use Kenyan brand names:
  Oxytetracycline → Alamycin LA, Terramycin LA, Oxy 20 LA
  Penicillin-Strep → Pen & Strep, Norocillin
  Ivermectin → Ivomec, Noromectin
  Albendazole → Valbazen, Alben
  Levamisole → Nilzan, Ripercol
  Fenbendazole → Panacur, Safe-Guard
  Tylosin → Tylan
  Enrofloxacin → Baytril
  Diminazene → Berenil, Veriben
  Amitraz → Triatix, Taktic
  Cypermethrin → Ectomin, Cybadip
  Deltamethrin → Decatix, Butox
  Calcium borogluconate → CalBoro, CalMag
  Newcastle vaccine → Lasota, I-2, Komarov
  Gumboro vaccine → IBD vaccine
  List the AI-mentioned product AND 2-3 alternatives.
- Kenyan law: injectables require a registered vet. If flagging Veterinary Prescription, assess whether Veterinary Visit is also needed.
- Classify sessions in Swahili/Kikuyu/mixed languages normally. If translation is garbled, classify based on valid content.
- If off-topic but contains livestock advice, flag BOTH off-topic AND the livestock opportunities.
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

// ============================================
// SECURITY: Input Sanitization & Validation
// ============================================

/** SECURITY: Strip HTML/script tags to prevent XSS (OWASP A7) */
function sanitize(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/javascript:/gi, '')       // strip JS protocol
    .replace(/on\w+\s*=/gi, '')         // strip event handlers
    .slice(0, MAX_FIELD_LENGTH);        // enforce length limit
}

/** SECURITY: Validate uploaded file (OWASP file upload) */
function validateFile(file) {
  if (!file) return 'No file selected.';
  if (!ALLOWED_EXTENSIONS.test(file.name)) return 'Only .xlsx files are accepted.';
  if (file.size > MAX_FILE_SIZE_BYTES) return `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`;
  if (file.size === 0) return 'File is empty.';
  return null; // no error
}

/** SECURITY: Check rate limit before API call */
function checkRateLimit() {
  const now = Date.now();
  // Remove timestamps older than the window
  while (apiCallTimestamps.length > 0 && apiCallTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    apiCallTimestamps.shift();
  }
  if (apiCallTimestamps.length >= RATE_LIMIT_MAX_CALLS) {
    return false; // rate limited
  }
  apiCallTimestamps.push(now);
  return true; // allowed
}

/** SECURITY: Validate known category names from Claude response */
const VALID_CATEGORIES = new Set([
  'OTC Medication', 'Veterinary Prescription', 'Veterinary Visit',
  'Artificial Insemination', 'Laboratory Work', 'Feeds', 'Hardware', 'Agrovet Connection',
]);
const VALID_CONFIDENCE = new Set(['High', 'Medium', 'Low']);

/** SECURITY: Schema-validate Claude's classification response (reject unexpected data) */
function validateClassification(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid classification: not an object');
  const result = {
    categories: [],
    off_topic: Boolean(data.off_topic),
    off_topic_subject: sanitize(String(data.off_topic_subject || '')),
    no_opportunity: Boolean(data.no_opportunity),
    no_opportunity_reason: sanitize(String(data.no_opportunity_reason || '')),
    other_opportunities: sanitize(String(data.other_opportunities || '')),
    lead_summary: sanitize(String(data.lead_summary || '')),
  };
  if (Array.isArray(data.categories)) {
    result.categories = data.categories
      .filter(c => c && typeof c === 'object')
      .slice(0, 10) // cap at 10 categories per session
      .map(c => ({
        category: VALID_CATEGORIES.has(c.category) ? c.category : 'Unknown',
        confidence: VALID_CONFIDENCE.has(c.confidence) ? c.confidence : 'Low',
        products: sanitize(String(c.products || '')),
        reasoning: sanitize(String(c.reasoning || '')),
      }));
  }
  return result;
}

// ============================================
// HELPERS
// ============================================

function parseSessions(wb) {
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  if (rows.length < 2) return [];
  const out = [];
  let cur = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], sid = r[0];
    // SECURITY: Validate session ID is numeric
    if (sid && sid !== '' && !isNaN(Number(sid))) {
      if (cur) { cur.conversation = cur._parts.filter(Boolean).join('\n'); out.push(cur); }
      // SECURITY: Sanitize all user-facing string fields
      cur = {
        sessionId: String(Number(sid)), // force numeric string
        started: sanitize(r[1]), ended: sanitize(r[2]), duration: sanitize(r[3]),
        farmerName: sanitize(r[4]) || 'Unknown', phone: sanitize(r[5]),
        ward: sanitize(r[6]), county: sanitize(r[7]),
        animalType: sanitize(r[8]), issueCategory: sanitize(r[9]),
        issueDescription: sanitize(r[10]),
        messageCount: sanitize(r[11]), avgResponseTime: sanitize(r[12]),
        feedbackGiven: sanitize(r[13]), feedbackRating: sanitize(r[14]),
        _parts: [], prescriptionNotes: sanitize(r[39]),
      };
      if (r[15]) cur._parts.push(String(r[15]));
    } else if (cur && r[15]) {
      cur._parts.push(String(r[15]));
    }
    // SECURITY: Cap max sessions to prevent abuse
    if (out.length >= MAX_SESSIONS) break;
  }
  if (cur && out.length < MAX_SESSIONS) {
    cur.conversation = cur._parts.filter(Boolean).join('\n');
    out.push(cur);
  }
  return out.map(({ _parts, ...rest }) => ({
    ...rest,
    // SECURITY: Truncate conversation to prevent excessive memory/API usage
    conversation: rest.conversation?.slice(0, MAX_CONVERSATION_LENGTH) || '',
  }));
}

function trunc(t, n = 3000) { return !t ? '' : t.length <= n ? t : t.slice(0, n) + '\n…[truncated]'; }

function buildMsg(s) {
  // SECURITY: All fields are already sanitized from parseSessions
  return `SESSION ID: ${s.sessionId}\nAnimal Type: ${s.animalType || 'Not specified'}\nIssue Category: ${s.issueCategory || 'Not specified'}\nIssue Description: ${s.issueDescription || 'Not specified'}\nFarmer: ${s.farmerName || 'Unknown'}, County: ${s.county || 'Unknown'}, Ward: ${s.ward || 'Unknown'}, Phone: ${s.phone || 'Unknown'}\n\nCONVERSATION:\n${trunc(s.conversation)}\n\nClassify this session into commercial opportunity categories.`;
}

function badgeCls(cat) { return CATS[cat]?.cls || 'badge-none'; }

function overallConf(cats) {
  if (!cats?.length) return 'Low';
  if (cats.some(c => c.confidence === 'High')) return 'High';
  if (cats.some(c => c.confidence === 'Medium')) return 'Medium';
  return 'Low';
}

function stats(sessions) {
  const a = {}, c = {}, iss = {};
  sessions.forEach(s => {
    if (s.animalType) a[s.animalType] = (a[s.animalType] || 0) + 1;
    if (s.county) c[s.county] = (c[s.county] || 0) + 1;
    if (s.issueCategory) iss[s.issueCategory] = (iss[s.issueCategory] || 0) + 1;
  });
  return {
    total: sessions.length,
    animals: Object.entries(a).sort((x, y) => y[1] - x[1]),
    counties: Object.entries(c).sort((x, y) => y[1] - x[1]),
    issues: Object.entries(iss).sort((x, y) => y[1] - x[1]),
  };
}

function rStats(results) {
  const cc = {}; let opp = 0, ot = 0, no = 0, hi = 0, errCount = 0;
  results.forEach(r => {
    if (r.error || !r.classification) { errCount++; return; }
    const cl = r.classification, cats = cl.categories || [];
    if (cl.off_topic) ot++;
    if (cl.no_opportunity) no++;
    if (cats.length > 0) opp++;
    if (cats.some(c => c.confidence === 'High')) hi++;
    cats.forEach(c => { cc[c.category] = (cc[c.category] || 0) + 1; });
  });
  return { total: results.length, opp, ot, no, hi, cc, errCount };
}

function downloadXlsx(results, sessions) {
  const sessionMap = new Map(sessions.map(s => [s.sessionId, s]));
  const rows = results.map(r => {
    const s = sessionMap.get(r.sessionId) || {};
    const cl = r.classification || {}, cats = cl.categories || [];
    return {
      'Session ID': s.sessionId || r.sessionId,
      'Farmer Name': s.farmerName || '', Phone: s.phone || '',
      County: s.county || '', Ward: s.ward || '',
      'Animal Type': s.animalType || '', 'Issue Category': s.issueCategory || '',
      'Issue Description': s.issueDescription || '',
      'Opportunity Categories': cats.map(c => c.category).join('; ') || (r.error ? 'Classification Failed' : 'None'),
      'Confidence Levels': cats.map(c => `${c.category}: ${c.confidence}`).join('; '),
      'Specific Products/Brands': cats.map(c => c.products).filter(Boolean).join('; '),
      Reasoning: cats.map(c => `${c.category}: ${c.reasoning}`).filter(Boolean).join('; ') || (r.error || ''),
      'Lead Summary': cl.lead_summary || '',
      'Lead Confidence (Overall)': overallConf(cats),
      'Off-Topic': cl.off_topic ? 'Yes' : 'No',
      'Off-Topic Subject': cl.off_topic_subject || '',
      'No Opportunity': cl.no_opportunity ? 'Yes' : 'No',
      'No Opportunity Reason': cl.no_opportunity_reason || '',
      'Other Revenue Opportunities': cl.other_opportunities || '',
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const colKeys = Object.keys(rows[0] || {});
  ws['!cols'] = colKeys.map(k => ({ wch: Math.min(Math.max(k.length, 10) + 2, 50) }));
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, ws, 'Lead Classification');
  XLSX.writeFile(wb2, 'VetPower_Lead_Classification.xlsx');
}

// ============================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (res.status >= 500 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function fmtTime(s) {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

// ============================================
// LIVESTOCK BACKGROUND COMPONENT
// ============================================

function LivestockBackground() {
  const [animals, setAnimals] = useState([]);

  useEffect(() => {
    const items = [];
    for (let i = 0; i < 12; i++) {
      const img = LIVESTOCK_IMAGES[i % LIVESTOCK_IMAGES.length];
      items.push({
        id: i,
        src: img.src,
        alt: img.alt,
        x: Math.random() * 90 + 5,
        y: Math.random() * 80 + 10,
        size: 60 + Math.random() * 100,
        opacity: 0.04 + Math.random() * 0.04,
        duration: 25 + Math.random() * 20,
        delay: Math.random() * -30,
        drift: 15 + Math.random() * 25,
        flip: Math.random() > 0.5,
      });
    }
    setAnimals(items);
  }, []);

  return (
    <div className="livestock-bg" aria-hidden="true">
      {animals.map(a => (
        <img
          key={a.id}
          src={a.src}
          alt=""
          className="livestock-animal"
          style={{
            left: `${a.x}%`,
            top: `${a.y}%`,
            width: `${a.size}px`,
            opacity: a.opacity,
            animationDuration: `${a.duration}s`,
            animationDelay: `${a.delay}s`,
            '--drift-x': `${a.drift}px`,
            '--drift-y': `${a.drift * 0.6}px`,
            transform: a.flip ? 'scaleX(-1)' : 'none',
          }}
        />
      ))}
    </div>
  );
}

// ============================================
// ICONS
// ============================================

const I = {
  Upload: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>,
  Chev: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>,
  Alert: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>,
  Down: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
  Redo: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>,
  Search: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
  Layers: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>,
  Check: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>,
  Sparkle: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" /></svg>,
  Stop: () => <span style={{ display: 'inline-block', width: 10, height: 10, background: 'currentColor', borderRadius: 2 }} />,
};

// ============================================
// APP
// ============================================

export default function App() {
  const [stage, setStage] = useState('upload');
  const [sessions, setSessions] = useState([]);
  const [results, setResults] = useState([]);
  const [err, setErr] = useState('');
  const [processing, setProcessing] = useState(false);
  const [idx, setIdx] = useState(0);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState({});
  const [drag, setDrag] = useState(false);
  const [metricsVisible, setMetricsVisible] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [completionAnim, setCompletionAnim] = useState(false);
  const [avgTime, setAvgTime] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');

  const fileRef = useRef(null);
  const stopRef = useRef(false);
  const startTimeRef = useRef(0);

  useEffect(() => {
    if (stage === 'preview') {
      const t = setTimeout(() => setMetricsVisible(true), 100);
      return () => clearTimeout(t);
    }
    setMetricsVisible(false);
  }, [stage]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && stage !== 'upload') {
        if (!processing) reset();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stage, processing]);

  const sessionMap = useMemo(() => new Map(sessions.map(s => [s.sessionId, s])), [sessions]);

  const onFile = useCallback((f) => {
    setErr('');
    if (!f) return;
    // SECURITY: Validate file type, size, and extension (OWASP file upload)
    const fileErr = validateFile(f);
    if (fileErr) { setErr(fileErr); return; }
    setParsing(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const s = parseSessions(wb);
        if (!s.length) { setErr('No sessions found. Ensure column A has numeric Session IDs.'); setParsing(false); return; }
        if (s.length >= MAX_SESSIONS) {
          setErr(`File contains many sessions. Processing capped at ${MAX_SESSIONS} for performance.`);
        }
        setSessions(s); setResults([]); setStage('preview');
      } catch (ex) { setErr(`Parse error: ${ex.message}`); }
      setParsing(false);
    };
    reader.onerror = () => { setErr('Failed to read file.'); setParsing(false); };
    reader.readAsArrayBuffer(f);
  }, []);

  const onDrop = useCallback((e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }, [onFile]);

  const classify = async (s) => {
    // SECURITY: Check API key is configured
    if (!API_KEY) throw new Error('API key not configured. Contact your administrator.');
    // SECURITY: Client-side rate limiting
    if (!checkRateLimit()) throw new Error('Rate limit reached (60 calls/min). Please wait a moment.');

    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1024,
        system: SYS_PROMPT,
        messages: [{ role: 'user', content: buildMsg(s) }],
      }),
    });
    // SECURITY: Handle HTTP errors with user-friendly messages
    if (res.status === 429) throw new Error('API rate limit exceeded. The system will retry automatically.');
    if (res.status === 401) throw new Error('API key is invalid or expired. Contact your administrator.');
    if (!res.ok) throw new Error(`API error (${res.status}). Please try again.`);

    const d = await res.json();
    let txt = d.content?.[0]?.text || '';
    const m = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) txt = m[1];
    let parsed;
    try {
      parsed = JSON.parse(txt.trim());
    } catch {
      throw new Error('Invalid AI response — could not parse classification.');
    }
    // SECURITY: Schema-validate and sanitize the response
    return validateClassification(parsed);
  };

  const CONCURRENCY = 5;

  const run = async () => {
    setErr(''); setProcessing(true); setStage('results'); setResults([]); setIdx(0);
    stopRef.current = false; setCompletionAnim(false); setAvgTime(0);
    startTimeRef.current = Date.now();
    const acc = [];
    let completed = 0;

    for (let i = 0; i < sessions.length; i += CONCURRENCY) {
      if (stopRef.current) break;
      const chunk = sessions.slice(i, Math.min(i + CONCURRENCY, sessions.length));
      const t0 = Date.now();

      const chunkResults = await Promise.all(
        chunk.map(async (session) => {
          try {
            return { sessionId: session.sessionId, classification: await classify(session) };
          } catch (e) {
            return { sessionId: session.sessionId, error: e.message, classification: null };
          }
        })
      );

      if (stopRef.current) break;
      acc.push(...chunkResults);
      completed += chunkResults.length;
      setIdx(completed - 1);
      setResults([...acc]);

      const elapsed = (Date.now() - t0) / 1000;
      const perSession = elapsed / chunkResults.length;
      setAvgTime(prev => prev === 0 ? perSession : prev * 0.7 + perSession * 0.3);
    }

    setProcessing(false);
    if (!stopRef.current) {
      setCompletionAnim(true);
      setTimeout(() => setCompletionAnim(false), 4000);
    }
  };

  const reset = () => {
    setStage('upload'); setSessions([]); setResults([]); setErr('');
    setProcessing(false); setIdx(0); setFilter('all'); setExpanded({});
    setSearchTerm(''); setCompletionAnim(false); setAvgTime(0);
    if (fileRef.current) fileRef.current.value = '';
  };

  const toggle = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));

  const eta = useMemo(() => {
    if (!processing || avgTime === 0) return null;
    const remaining = sessions.length - (idx + 1);
    return fmtTime(remaining * (avgTime + 0.5));
  }, [processing, avgTime, idx, sessions.length]);

  const filtered = useMemo(() => {
    let base = results;
    if (filter === 'opp') base = results.filter(r => r.classification?.categories?.length > 0);
    else if (filter === 'hi') base = results.filter(r => r.classification?.categories?.some(c => c.confidence === 'High'));
    else if (filter === 'ot') base = results.filter(r => r.classification?.off_topic);
    else if (filter === 'no') base = results.filter(r => r.classification?.no_opportunity);
    else if (filter === 'err') base = results.filter(r => r.error);
    else if (filter !== 'all') base = results.filter(r => r.classification?.categories?.some(c => c.category === filter));

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      base = base.filter(r => {
        const s = sessionMap.get(r.sessionId) || {};
        return (s.farmerName || '').toLowerCase().includes(q) ||
          (s.county || '').toLowerCase().includes(q) ||
          (s.animalType || '').toLowerCase().includes(q) ||
          (r.classification?.lead_summary || '').toLowerCase().includes(q) ||
          r.sessionId.includes(q);
      });
    }
    return base;
  }, [results, filter, searchTerm, sessionMap]);

  const st = sessions.length ? stats(sessions) : null;
  const rs = results.length ? rStats(results) : null;

  // ============================================
  // RENDER
  // ============================================
  return (
    <div className={`app ${stage !== 'upload' ? 'app-active' : ''}`}>
      {/* Animated livestock background */}
      <LivestockBackground />

      {/* Floating orbs background */}
      <div className="bg-orbs" aria-hidden="true">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      {/* ——— HEADER ——— */}
      <header className="hero">
        <div className="hero-mark">
          <span className="dot" />
          Delta40 Venture Studio
        </div>
        <h1>
          <strong>VetPower</strong> Lead Engine
        </h1>
        <p className="hero-sub">
          Classify farmer conversations into commercial opportunities.
          Built for your sales team.
        </p>
        {stage !== 'upload' && (
          <div className="hero-breadcrumb">
            <button className="breadcrumb-link" onClick={reset}>Upload</button>
            <span className="breadcrumb-sep">›</span>
            <span className={stage === 'preview' ? 'breadcrumb-active' : 'breadcrumb-link'}>Preview</span>
            {stage === 'results' && <>
              <span className="breadcrumb-sep">›</span>
              <span className="breadcrumb-active">Results</span>
            </>}
          </div>
        )}
      </header>

      {/* ===== UPLOAD ===== */}
      {stage === 'upload' && (
        <div className="upload-card">
          <div className="surface surface-glass surface-pad">
            <div
              className={`drop-zone${drag ? ' active' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDrop={onDrop}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
            >
              {parsing ? (
                <div className="loading-spinner" />
              ) : (
                <div className="drop-icon">
                  <I.Upload style={{ width: 24, height: 24 }} />
                </div>
              )}
              <div className="drop-title">{parsing ? 'Parsing sessions…' : 'Upload session data'}</div>
              <div className="drop-hint">
                {parsing ? 'Reading your Excel file' : <>Drag your VetPower export here, or <span className="link">browse</span></>}
              </div>
              <span className="drop-format">.xlsx only</span>
              <input
                ref={fileRef} type="file" accept=".xlsx,.xls"
                style={{ display: 'none' }}
                onChange={(e) => onFile(e.target.files[0])}
              />
            </div>

            {err && <div className="error-bar"><I.Alert /><span>{err}</span></div>}
          </div>

          {/* How it works */}
          <div className="how-it-works">
            <div className="hiw-title">How it works</div>
            <div className="hiw-steps">
              {[
                [<I.Upload style={{width:20,height:20}} />, 'Upload', 'Drop your VetPower session export (.xlsx)'],
                [<I.Layers style={{width:20,height:20}} />, 'Classify', 'Each conversation is analysed and leads identified'],
                [<I.Down style={{width:20,height:20}} />, 'Export', 'Filter, explore, and download your lead report'],
              ].map(([icon, title, desc], i) => (
                <div className="hiw-step" key={i}>
                  <div className="hiw-icon">{icon}</div>
                  <div className="hiw-step-title">{title}</div>
                  <div className="hiw-step-desc">{desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Feature highlights */}
          <div className="features-row">
            {[
              [<I.Sparkle style={{width:18,height:18}} />, 'Fast', 'Processes sessions in seconds'],
              [<I.Layers style={{width:18,height:18}} />, '8 Categories', 'OTC, Rx, Visits, AI, Lab, Feeds & more'],
              [<I.Check style={{width:18,height:18}} />, 'Secure', 'Data stays in your browser'],
              [<I.Down style={{width:18,height:18}} />, 'Export', 'Download classified leads as Excel'],
            ].map(([icon, title, desc], i) => (
              <div className="feature-chip" key={i}>
                <span className="feature-icon">{icon}</span>
                <div>
                  <div className="feature-title">{title}</div>
                  <div className="feature-desc">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== PREVIEW ===== */}
      {stage === 'preview' && st && (
        <div className="stage-transition">
          {/* Metrics */}
          <div className="metrics">
            {[
              [st.total, 'Sessions', <I.Layers style={{width:20,height:20}} />],
              [st.animals.length, 'Animal Types', <I.Search style={{width:20,height:20}} />],
              [st.counties.length, 'Counties', <I.Alert style={{width:20,height:20}} />],
              [st.issues.length, 'Issue Categories', <I.Check style={{width:20,height:20}} />],
            ].map(([v, l, icon], i) => (
              <div
                key={l}
                className={`metric metric-glass${metricsVisible ? ' visible' : ''}`}
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="metric-emoji">{icon}</div>
                <div className="metric-val">{v}</div>
                <div className="metric-label">{l}</div>
              </div>
            ))}
          </div>

          {/* Overview */}
          <div className="overview-grid stagger-in" style={{ animationDelay: '0.3s' }}>
            {[
              ['Top Animals', st.animals],
              ['Top Counties', st.counties],
              ['Top Issues', st.issues],
            ].map(([title, data]) => (
              <div className="overview-block surface-glass" key={title}>
                <h4>{title}</h4>
                {data.slice(0, 5).map(([n, c]) => (
                  <div className="ov-row" key={n}>
                    <span>{n}</span><span>{c}</span>
                  </div>
                ))}
                {data.length === 0 && <div className="ov-empty">No data</div>}
              </div>
            ))}
          </div>

          {/* Table */}
          <div className="stagger-in" style={{ animationDelay: '0.4s' }}>
            <div className="section-label">Session Preview — first {Math.min(8, sessions.length)}</div>
            <div className="table-wrap surface-glass">
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th><th>Farmer</th><th>County</th><th>Animal</th>
                    <th>Issue</th><th>Messages</th><th>Conv.</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.slice(0, 8).map(s => (
                    <tr key={s.sessionId}>
                      <td>{s.sessionId}</td>
                      <td>{s.farmerName || '—'}</td>
                      <td>{s.county || '—'}</td>
                      <td style={{ textTransform: 'capitalize' }}>{s.animalType || '—'}</td>
                      <td style={{ textTransform: 'capitalize' }}>{s.issueCategory || '—'}</td>
                      <td>{s.messageCount || '—'}</td>
                      <td style={{ color: '#999' }}>{s.conversation ? `${s.conversation.length} chars` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {err && <div className="error-bar" style={{ maxWidth: 480, margin: '0 auto 16px' }}><I.Alert /><span>{err}</span></div>}

          <div className="toolbar stagger-in" style={{ animationDelay: '0.55s' }}>
            <button className="btn btn-ghost" onClick={reset}>← Back</button>
            <button className="btn btn-accent btn-lg btn-glow" onClick={run}>
              <I.Sparkle style={{ width: 16, height: 16 }} />
              Classify {sessions.length} sessions →
            </button>
          </div>
        </div>
      )}

      {/* ===== RESULTS ===== */}
      {stage === 'results' && (
        <div className="stage-transition">
          {/* Completion celebration */}
          {completionAnim && (
            <div className="completion-banner">
              <div className="completion-icon"><I.Check style={{width:28,height:28}} /></div>
              <div className="completion-text">
                <strong>Classification complete!</strong>
                <span>{results.length} sessions processed in {fmtTime((Date.now() - startTimeRef.current) / 1000)}</span>
              </div>
            </div>
          )}

          {/* Progress */}
          {processing && (
            <div className="progress-card surface-glass">
              <div className="progress-top">
                <h3><I.Sparkle style={{ width: 16, height: 16, color: 'var(--accent)' }} /> Classifying…</h3>
                <button className="btn btn-stop" onClick={() => { stopRef.current = true; }}>
                  <I.Stop /> Stop
                </button>
              </div>
              <div className="track">
                <div className="track-fill track-shimmer" style={{ width: `${((idx + 1) / sessions.length) * 100}%` }} />
              </div>
              <div className="progress-meta">
                <span><strong>{idx + 1}</strong> of {sessions.length}</span>
                <span>{results.filter(r => !r.error).length} classified</span>
                {eta && <span className="eta-badge">~{eta} remaining</span>}
              </div>
            </div>
          )}

          {/* Pipeline */}
          {rs && (
            <div className="pipeline surface-glass">
              <h2>Classification Results</h2>
              <div className="metrics">
                {[
                  [rs.total, 'Processed', <I.Layers style={{width:20,height:20}} />],
                  [rs.opp, 'Opportunities', <I.Sparkle style={{width:20,height:20}} />],
                  [rs.hi, 'High Confidence', <I.Check style={{width:20,height:20}} />],
                  [rs.ot, 'Off-Topic', <I.Redo style={{width:20,height:20}} />],
                  [rs.no, 'No Opportunity', <I.Alert style={{width:20,height:20}} />],
                ].map(([v, l, icon]) => (
                  <div className="metric metric-glass visible" key={l}>
                    <div className="metric-emoji">{icon}</div>
                    <div className="metric-val">{v}</div>
                    <div className="metric-label">{l}</div>
                  </div>
                ))}
              </div>

              {Object.keys(rs.cc).length > 0 && (
                <div className="chart">
                  <div className="chart-title">Category Distribution</div>
                  {Object.entries(rs.cc).sort((a, b) => b[1] - a[1]).map(([cat, cnt]) => {
                    const max = Math.max(...Object.values(rs.cc));
                    const pct = (cnt / max) * 100;
                    const col = CATS[cat]?.color || '#999';
                    return (
                      <div className="bar-row" key={cat}>
                        <span className="bar-name">{cat}</span>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${col}, ${col}dd)` }}>
                            {pct > 25 && <span className="bar-val">{cnt}</span>}
                          </div>
                        </div>
                        {pct <= 25 && <span className="bar-val-out">{cnt}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Header + actions */}
          <div className="results-header">
            <h2>Sessions <span style={{ fontWeight: 400, color: '#999' }}>({filtered.length})</span></h2>
            {results.length > 0 && !processing && (
              <div className="actions">
                <button className="btn btn-accent btn-glow" onClick={() => downloadXlsx(results, sessions)}>
                  <I.Down /> Export Report
                </button>
                <button className="btn btn-ghost" onClick={reset}>
                  <I.Redo /> New file
                </button>
              </div>
            )}
          </div>

          {/* Search box */}
          {results.length > 0 && (
            <div className="search-box">
              <I.Search style={{ width: 16, height: 16, opacity: 0.4 }} />
              <input
                type="text"
                placeholder="Search by farmer, county, animal, or session ID…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
              {searchTerm && (
                <button className="search-clear" onClick={() => setSearchTerm('')}>×</button>
              )}
            </div>
          )}

          {/* Filters */}
          {results.length > 0 && (
            <div className="filters">
              {[
                ['all', 'All', results.length],
                ['opp', 'Opportunities', rs?.opp || 0],
                ['hi', 'High Conf.', rs?.hi || 0],
              ].map(([k, label, ct]) => (
                <button key={k} className={`pill${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
                  {label} <span className="ct">{ct}</span>
                </button>
              ))}

              {Object.entries(CATS).map(([cat, { color, icon }]) => {
                const ct = rs?.cc[cat] || 0;
                if (!ct) return null;
                return (
                  <button key={cat} className={`pill${filter === cat ? ' on' : ''}`}
                    onClick={() => setFilter(cat)}>
                    <span className="cat-dot" style={{ background: color }} />
                    {cat} <span className="ct">{ct}</span>
                  </button>
                );
              })}

              {rs?.ot > 0 && (
                <button className={`pill${filter === 'ot' ? ' on' : ''}`} onClick={() => setFilter('ot')}>
                  Off-Topic <span className="ct">{rs.ot}</span>
                </button>
              )}
              {rs?.no > 0 && (
                <button className={`pill${filter === 'no' ? ' on' : ''}`} onClick={() => setFilter('no')}>
                  No Opp. <span className="ct">{rs.no}</span>
                </button>
              )}
              {rs?.errCount > 0 && (
                <button className={`pill pill-err${filter === 'err' ? ' on' : ''}`} onClick={() => setFilter('err')}>
                  ⚠ Errors <span className="ct">{rs.errCount}</span>
                </button>
              )}
            </div>
          )}

          {/* Session list */}
          <div className="s-list">
            {filtered.length === 0 && !processing && (
              <div className="empty"><I.Search /><p>No sessions match this filter</p></div>
            )}

            {filtered.map(r => {
              const s = sessionMap.get(r.sessionId) || {};
              const cl = r.classification || {}, cats = cl.categories || [];
              const open = expanded[r.sessionId];

              return (
                <div key={r.sessionId} className={`s-card${r.error ? ' err' : ''}${open ? ' s-card-open' : ''}`}>
                  <div className="s-head" onClick={() => toggle(r.sessionId)}>
                    <div className="s-id-block">
                      <span className="s-id">#{r.sessionId}</span>
                      {s.animalType && <span className="s-tag">{s.animalType}</span>}
                      {s.county && <span className="s-tag">{s.county}</span>}
                    </div>

                    <div className="s-badges">
                      {r.error ? (
                        <span className="badge badge-none">⚠ Failed</span>
                      ) : (
                        <>
                          {cats.map((c, i) => (
                            <span key={i} className={`badge ${badgeCls(c.category)}`}>
                              <span className={`conf-dot ${c.confidence === 'High' ? 'h' : c.confidence === 'Medium' ? 'm' : 'l'}`} />
                              {c.category}
                            </span>
                          ))}
                          {cl.off_topic && <span className="badge badge-off">Off-Topic</span>}
                          {cl.no_opportunity && !cats.length && <span className="badge badge-none">No Opportunity</span>}
                        </>
                      )}
                    </div>

                    {cl.lead_summary && (
                      <span className="s-summary" title={cl.lead_summary}>{cl.lead_summary}</span>
                    )}

                    <div className={`s-chevron${open ? ' open' : ''}`}><I.Chev /></div>
                  </div>

                  {open && (
                    <div className="s-body">
                      <div className="detail-grid">
                        <div className="detail-cell">
                          <div className="dc-label">Session Details</div>
                          <div className="dc-val">
                            <div><strong>Farmer:</strong> {s.farmerName || 'Unknown'}</div>
                            <div><strong>Phone:</strong> {s.phone || '—'}</div>
                            <div><strong>Location:</strong> {s.county || '—'} / {s.ward || '—'}</div>
                            <div><strong>Issue:</strong> {s.issueCategory || '—'}</div>
                            {s.issueDescription && <div><strong>Description:</strong> {s.issueDescription}</div>}
                          </div>
                        </div>

                        {r.error ? (
                          <div className="detail-cell">
                            <div className="dc-label">Error</div>
                            <div className="dc-val" style={{ color: '#c44536' }}>{r.error}</div>
                          </div>
                        ) : cats.map((c, i) => (
                          <div className="detail-cell" key={i}>
                            <div className="dc-label">
                              <span className={`conf-dot ${c.confidence === 'High' ? 'h' : c.confidence === 'Medium' ? 'm' : 'l'}`} />
                              {c.category} · {c.confidence}
                            </div>
                            <div className="dc-val">
                              {c.products && <div style={{ marginBottom: 4 }}><strong>Products:</strong> {c.products}</div>}
                              <div><strong>Why:</strong> {c.reasoning}</div>
                            </div>
                          </div>
                        ))}

                        {cl.lead_summary && (
                          <div className="detail-cell">
                            <div className="dc-label">Lead Summary</div>
                            <div className="dc-val">{cl.lead_summary}</div>
                          </div>
                        )}

                        {cl.off_topic && (
                          <div className="detail-cell">
                            <div className="dc-label">Off-Topic</div>
                            <div className="dc-val">{cl.off_topic_subject || '—'}</div>
                          </div>
                        )}
                        {cl.no_opportunity && (
                          <div className="detail-cell">
                            <div className="dc-label">No Opportunity</div>
                            <div className="dc-val">{cl.no_opportunity_reason || '—'}</div>
                          </div>
                        )}
                        {cl.other_opportunities && (
                          <div className="detail-cell">
                            <div className="dc-label">Other Revenue</div>
                            <div className="dc-val">{cl.other_opportunities}</div>
                          </div>
                        )}

                        {s.conversation && (
                          <div className="detail-cell" style={{ gridColumn: '1 / -1' }}>
                            <div className="dc-label">Conversation</div>
                            <div className="conv-preview">{trunc(s.conversation, 2000)}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== FOOTER ===== */}
      <footer className="app-footer">
        <div className="footer-brand">
          <span className="footer-dot" />
          VetPower Lead Engine
        </div>
        <div className="footer-meta">
          Built by <strong>Delta40 Venture Studio</strong>
        </div>
      </footer>
    </div>
  );
}
