import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';

// ============================================
// CONSTANTS
// ============================================

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
    if (sid && sid !== '' && !isNaN(Number(sid))) {
      if (cur) { cur.conversation = cur._parts.filter(Boolean).join('\n'); out.push(cur); }
      cur = {
        sessionId: String(sid), started: r[1] || '', ended: r[2] || '', duration: r[3] || '',
        farmerName: r[4] || 'Unknown', phone: r[5] || '', ward: r[6] || '', county: r[7] || '',
        animalType: r[8] || '', issueCategory: r[9] || '', issueDescription: r[10] || '',
        messageCount: r[11] || '', avgResponseTime: r[12] || '',
        feedbackGiven: r[13] || '', feedbackRating: r[14] || '',
        _parts: [], prescriptionNotes: r[39] || '',
      };
      if (r[15]) cur._parts.push(String(r[15]));
    } else if (cur && r[15]) {
      cur._parts.push(String(r[15]));
    }
  }
  if (cur) { cur.conversation = cur._parts.filter(Boolean).join('\n'); out.push(cur); }
  return out.map(({ _parts, ...rest }) => rest);
}

function trunc(t, n = 3000) { return !t ? '' : t.length <= n ? t : t.slice(0, n) + '\n…[truncated]'; }

function buildMsg(s) {
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
  const cc = {}; let opp = 0, ot = 0, no = 0, hi = 0;
  results.forEach(r => {
    if (r.error || !r.classification) return;
    const cl = r.classification, cats = cl.categories || [];
    if (cl.off_topic) ot++;
    if (cl.no_opportunity) no++;
    if (cats.length > 0) opp++;
    if (cats.some(c => c.confidence === 'High')) hi++;
    cats.forEach(c => { cc[c.category] = (cc[c.category] || 0) + 1; });
  });
  return { total: results.length, opp, ot, no, hi, cc };
}

function downloadXlsx(results, sessions) {
  const rows = results.map(r => {
    const s = sessions.find(x => x.sessionId === r.sessionId) || {};
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
  ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.min(Math.max(k.length, ...rows.map(r => String(r[k] || '').length)) + 2, 50) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lead Classification');
  XLSX.writeFile(wb, 'VetPower_Lead_Classification.xlsx');
}

// ============================================
// ICONS — minimal, Apple-style line icons
// ============================================

const I = {
  Upload: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>,
  Chev: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>,
  Alert: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>,
  Down: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
  Redo: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>,
  Search: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
  Layers: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>,
  File: (p) => <svg {...p} xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>,
  Stop: () => <span style={{ display: 'inline-block', width: 10, height: 10, background: 'currentColor', borderRadius: 2 }} />,
};

// ============================================
// APP
// ============================================

export default function App() {
  const [stage, setStage] = useState('upload');
  const [sessions, setSessions] = useState([]);
  const [results, setResults] = useState([]);
  const [apiKey, setApiKey] = useState('');
  const [err, setErr] = useState('');
  const [processing, setProcessing] = useState(false);
  const [idx, setIdx] = useState(0);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState({});
  const [drag, setDrag] = useState(false);
  const [metricsVisible, setMetricsVisible] = useState(false);

  const fileRef = useRef(null);
  const stopRef = useRef(false);

  // Stagger metrics animation on preview mount
  useEffect(() => {
    if (stage === 'preview') {
      const t = setTimeout(() => setMetricsVisible(true), 100);
      return () => clearTimeout(t);
    }
    setMetricsVisible(false);
  }, [stage]);

  // --- File handling ---
  const onFile = useCallback((f) => {
    setErr('');
    if (!f) return;
    if (!f.name.match(/\.xlsx?$/i)) {
      setErr('Please upload an Excel file (.xlsx). Other formats are not supported.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const s = parseSessions(wb);
        if (!s.length) { setErr('No sessions found. Ensure column A has numeric Session IDs.'); return; }
        setSessions(s); setResults([]); setStage('preview');
      } catch (ex) { setErr(`Parse error: ${ex.message}`); }
    };
    reader.onerror = () => setErr('Failed to read file.');
    reader.readAsArrayBuffer(f);
  }, []);

  const onDrop = useCallback((e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }, [onFile]);

  // --- Classification ---
  const classify = async (s) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1024,
        system: SYS_PROMPT,
        messages: [{ role: 'user', content: buildMsg(s) }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    let txt = d.content?.[0]?.text || '';
    const m = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) txt = m[1];
    return JSON.parse(txt.trim());
  };

  const run = async () => {
    if (!apiKey.trim()) { setErr('Enter your Anthropic API key first.'); return; }
    setErr(''); setProcessing(true); setStage('results'); setResults([]); setIdx(0); stopRef.current = false;
    const acc = [];
    for (let i = 0; i < sessions.length; i++) {
      if (stopRef.current) break;
      setIdx(i);
      try {
        acc.push({ sessionId: sessions[i].sessionId, classification: await classify(sessions[i]) });
      } catch (e) {
        acc.push({ sessionId: sessions[i].sessionId, error: e.message, classification: null });
      }
      setResults([...acc]);
      if (i < sessions.length - 1 && !stopRef.current) await new Promise(r => setTimeout(r, 500));
    }
    setProcessing(false);
  };

  const reset = () => {
    setStage('upload'); setSessions([]); setResults([]); setErr('');
    setProcessing(false); setIdx(0); setFilter('all'); setExpanded({});
    if (fileRef.current) fileRef.current.value = '';
  };

  const toggle = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));

  // --- Filtered results ---
  const filtered = (() => {
    if (filter === 'all') return results;
    if (filter === 'opp') return results.filter(r => r.classification?.categories?.length > 0);
    if (filter === 'hi') return results.filter(r => r.classification?.categories?.some(c => c.confidence === 'High'));
    if (filter === 'ot') return results.filter(r => r.classification?.off_topic);
    if (filter === 'no') return results.filter(r => r.classification?.no_opportunity);
    return results.filter(r => r.classification?.categories?.some(c => c.category === filter));
  })();

  const st = sessions.length ? stats(sessions) : null;
  const rs = results.length ? rStats(results) : null;

  // ============================================
  // RENDER
  // ============================================
  return (
    <div className="app">

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
          Powered by AI. Built for your sales team.
        </p>
      </header>

      {/* ===== UPLOAD ===== */}
      {stage === 'upload' && (
        <div className="upload-card">
          <div className="surface surface-pad">
            <div
              className={`drop-zone${drag ? ' active' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDrop={onDrop}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
            >
              <div className="drop-icon">
                <I.Upload style={{ width: 24, height: 24 }} />
              </div>
              <div className="drop-title">Upload session data</div>
              <div className="drop-hint">
                Drag your VetPower export here, or <span className="link">browse</span>
              </div>
              <span className="drop-format">.xlsx only</span>
              <input
                ref={fileRef} type="file" accept=".xlsx,.xls"
                style={{ display: 'none' }}
                onChange={(e) => onFile(e.target.files[0])}
              />
            </div>

            <div className="key-block">
              <div className="key-label">
                <I.Layers style={{ width: 14, height: 14, color: '#0d9b6a' }} />
                Anthropic API Key
              </div>
              <input
                className="key-input" type="password"
                placeholder="sk-ant-api03-…"
                value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              />
              <div className="key-hint">Required for classification · stored in memory only</div>
            </div>

            {err && <div className="error-bar"><I.Alert /><span>{err}</span></div>}
          </div>
        </div>
      )}

      {/* ===== PREVIEW ===== */}
      {stage === 'preview' && st && (
        <div>
          {/* Metrics */}
          <div className="metrics">
            {[
              [st.total, 'Sessions'],
              [st.animals.length, 'Animal Types'],
              [st.counties.length, 'Counties'],
              [st.issues.length, 'Issue Categories'],
            ].map(([v, l], i) => (
              <div
                key={l}
                className={`metric${metricsVisible ? ' visible' : ''}`}
                style={{ animationDelay: `${i * 80}ms` }}
              >
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
              <div className="overview-block" key={title}>
                <h4>{title}</h4>
                {data.slice(0, 5).map(([n, c]) => (
                  <div className="ov-row" key={n}>
                    <span>{n}</span><span>{c}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Table */}
          <div className="stagger-in" style={{ animationDelay: '0.4s' }}>
            <div className="section-label">Session Preview — first {Math.min(8, sessions.length)}</div>
            <div className="table-wrap">
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

          {/* API key if missing */}
          {!apiKey.trim() && (
            <div className="surface surface-pad stagger-in" style={{ maxWidth: 480, margin: '0 auto 24px', animationDelay: '0.5s' }}>
              <div className="key-label">
                <I.Layers style={{ width: 14, height: 14, color: '#0d9b6a' }} />
                Anthropic API Key
              </div>
              <input
                className="key-input" type="password"
                placeholder="sk-ant-api03-…"
                value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              />
              <div className="key-hint">Enter before classifying</div>
            </div>
          )}

          {err && <div className="error-bar" style={{ maxWidth: 480, margin: '0 auto 16px' }}><I.Alert /><span>{err}</span></div>}

          <div className="toolbar stagger-in" style={{ animationDelay: '0.55s' }}>
            <button className="btn btn-ghost" onClick={reset}>← Back</button>
            <button className="btn btn-accent btn-lg" onClick={run}>
              Classify {sessions.length} sessions →
            </button>
          </div>
        </div>
      )}

      {/* ===== RESULTS ===== */}
      {stage === 'results' && (
        <div>
          {/* Progress */}
          {processing && (
            <div className="progress-card">
              <div className="progress-top">
                <h3>Classifying…</h3>
                <button className="btn btn-stop" onClick={() => { stopRef.current = true; }}>
                  <I.Stop /> Stop
                </button>
              </div>
              <div className="track">
                <div className="track-fill" style={{ width: `${((idx + 1) / sessions.length) * 100}%` }} />
              </div>
              <div className="progress-meta">
                <span><strong>{idx + 1}</strong> of {sessions.length}</span>
                <span>{results.length} classified</span>
              </div>
            </div>
          )}

          {/* Pipeline */}
          {rs && (
            <div className="pipeline">
              <h2>Pipeline</h2>
              <div className="metrics">
                {[
                  [rs.total, 'Processed'],
                  [rs.opp, 'Opportunities'],
                  [rs.hi, 'High Confidence'],
                  [rs.ot, 'Off-Topic'],
                  [rs.no, 'No Opportunity'],
                ].map(([v, l]) => (
                  <div className="metric visible" key={l}>
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
                          <div className="bar-fill" style={{ width: `${pct}%`, background: col }}>
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
                <button className="btn btn-accent" onClick={() => downloadXlsx(results, sessions)}>
                  <I.Down /> Export
                </button>
                <button className="btn btn-ghost" onClick={reset}>
                  <I.Redo /> New file
                </button>
              </div>
            )}
          </div>

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

              {Object.entries(CATS).map(([cat, { color }]) => {
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
            </div>
          )}

          {/* Session list */}
          <div className="s-list">
            {filtered.length === 0 && !processing && (
              <div className="empty"><I.Search /><p>No sessions match this filter</p></div>
            )}

            {filtered.map(r => {
              const s = sessions.find(x => x.sessionId === r.sessionId) || {};
              const cl = r.classification || {}, cats = cl.categories || [];
              const open = expanded[r.sessionId];

              return (
                <div key={r.sessionId} className={`s-card${r.error ? ' err' : ''}`}>
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
    </div>
  );
}
