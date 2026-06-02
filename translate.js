/* =========================================================
   translate.js — แปลภาษา + อ่าน .docx + สรุป AI + โหลด PDF/DOCX
   ========================================================= */
function goBack() { window.location.href = "index.html"; }

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
}

const PYTHON_SERVER_URL = "http://127.0.0.1:5001";

// ── state ──────────────────────────────────────────────────
let _lastOriginalText   = "";   // ต้นฉบับล่าสุด (ใช้ใน download)
let _lastTranslatedText = "";   // คำแปลล่าสุด
let _lastSummaryText    = "";   // สรุปล่าสุด

// ── utility ────────────────────────────────────────────────
function setStatus(type, text) {
  const badge = document.getElementById("statusBadge");
  const span  = document.getElementById("statusText");
  if (!badge || !span) return;
  badge.className = "status-badge st-" + type;
  span.textContent = text;
  const dot = badge.querySelector(".dot");
  if (dot) dot.className = (type === "processing") ? "dot pulse" : "dot";
}

function buildProgressHTML(pct, msg, totalChunks, doneChunks) {
  let chunkDots = "";
  if (totalChunks > 1) {
    const dotWidth = Math.max(8, Math.min(22, 200 / totalChunks));
    const dots = Array.from({ length: totalChunks }, (_, i) => {
      const done   = i < (doneChunks || 0);
      const active = i === (doneChunks || 0);
      const bg = done ? "#4CAF50" : active ? "#2196F3" : "#ddd";
      return `<span class="chunk-dot" style="width:${dotWidth}px;background:${bg};"></span>`;
    }).join("");
    chunkDots = `<div class="chunk-dots">${dots}</div>`;
  }
  return `
    <div class="progress-wrap">
      <div class="progress-msg">⏳ ${msg}</div>
      <div class="progress-track">
        <div class="progress-bar" style="width:${pct}%;"></div>
      </div>
      ${chunkDots}
    </div>`;
}

// ── ฟัง event เลือกไฟล์ ───────────────────────────────────
document.getElementById("fileInput").addEventListener("change", function(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById("fileName").innerText = file.name;
  processUploadedFile(file);
});

// ── ประมวลผลไฟล์ ──────────────────────────────────────────
async function processUploadedFile(file) {
  const textarea  = document.getElementById("inputText");
  const resultBox = document.getElementById("resultText");
  const nameLower = file.name.toLowerCase();
  const sizeMB    = (file.size / 1024 / 1024).toFixed(1);

  resultBox.innerText = "ผลลัพธ์จากการแปลภาษาจะแสดงตรงนี้...";
  hideSummaryAndDownload();
  textarea.value = `⏳ กำลังดึงข้อมูลจาก ${file.name} (${sizeMB} MB)...`;
  setStatus("processing", "กำลังประมวลผลไฟล์...");

  try {
    // ── .txt ──
    if (nameLower.endsWith(".txt")) {
      const reader = new FileReader();
      reader.onload = e => { textarea.value = e.target.result; setStatus("idle", "พร้อมแปลภาษา"); };
      reader.readAsText(file);

    // ── .docx / .doc ──
    } else if (nameLower.endsWith(".docx") || nameLower.endsWith(".doc")) {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      textarea.value = result.value.trim() || "⚠️ ไม่พบข้อความใน DOCX";
      setStatus("idle", "พร้อมแปลภาษา");

    // ── .pdf ──
    } else if (nameLower.endsWith(".pdf")) {
      const reader = new FileReader();
      reader.onload = async e => {
        const pdf = await pdfjsLib.getDocument(new Uint8Array(e.target.result)).promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page    = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(x => x.str).join(" ") + "\n";
        }
        textarea.value = text.trim() || "⚠️ ไม่พบข้อความใน PDF";
        setStatus("idle", "พร้อมแปลภาษา");
      };
      reader.readAsArrayBuffer(file);

    // ── รูปภาพ ──
    } else if (/\.(jpg|jpeg|png)$/.test(nameLower)) {
      textarea.value = "⏳ กำลัง OCR รูปภาพ...";
      const result = await Tesseract.recognize(file, "tha+eng");
      textarea.value = result.data.text.trim() || "⚠️ ไม่พบข้อความในรูปภาพ";
      setStatus("idle", "พร้อมแปลภาษา");

    // ── เสียง / วิดีโอ ──
    } else if (/\.(mp3|wav|m4a|mp4|mov|ogg|flac|webm)$/.test(nameLower)) {
      await transcribeAndTranslate(file);

    } else {
      textarea.value = "❌ ไม่รองรับไฟล์ประเภทนี้";
      setStatus("error", "ไม่รองรับไฟล์นี้");
    }
  } catch (err) {
    textarea.value = "❌ เกิดข้อผิดพลาด: " + err.message;
    setStatus("error", "เกิดข้อผิดพลาด");
  }
}

// ── ถอดเสียง + แปล (สำหรับไฟล์เสียง/วิดีโอ) ─────────────
async function transcribeAndTranslate(file) {
  const textarea   = document.getElementById("inputText");
  const resultBox  = document.getElementById("resultText");
  const sourceLang = document.getElementById("sourceLang").value;
  const targetLang = document.getElementById("targetLang").value;
  const modelKey   = document.getElementById("modelSelect").value;
  const sizeMB     = (file.size / 1024 / 1024).toFixed(1);

  setStatus("processing", "กำลังถอดเสียง...");
  resultBox.innerHTML = buildProgressHTML(3, `กำลังส่งไฟล์ (${sizeMB} MB)...`);

  const formData = new FormData();
  formData.append("audio", file);
  formData.append("source_lang", sourceLang);
  formData.append("mode", "original");
  formData.append("model", modelKey);

  let chunkTexts  = {};
  let totalChunks = 0;

  try {
    const response = await fetch(`${PYTHON_SERVER_URL}/transcribe-stream`, {
      method: "POST", body: formData
    });
    if (!response.ok) throw new Error(`Server error ${response.status}`);

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }

        if (evt.type === "progress") {
          if (evt.total_chunks) totalChunks = evt.total_chunks;
          resultBox.innerHTML = buildProgressHTML(evt.pct, evt.msg, totalChunks, Object.keys(chunkTexts).length);
        } else if (evt.type === "chunk_done") {
          if (evt.total_chunks) totalChunks = evt.total_chunks;
          chunkTexts[evt.chunk_index] = evt.chunk_text;
          const doneCount = Object.keys(chunkTexts).length;
          resultBox.innerHTML = buildProgressHTML(evt.pct, `ถอดเสียงเสร็จ ${doneCount}/${totalChunks} ส่วน`, totalChunks, doneCount);
        } else if (evt.type === "done") {
          textarea.value = evt.text;
          setStatus("processing", "กำลังแปลภาษา...");
          resultBox.innerHTML = buildProgressHTML(95, "ถอดเสียงเสร็จ กำลังแปล...");
          await doTranslate(evt.text, targetLang);
        } else if (evt.type === "error") {
          throw new Error(evt.msg);
        }
      }
    }
  } catch (err) {
    resultBox.innerHTML = `<span style="color:#e53935;">❌ ${err.message}</span>`;
    setStatus("error", "เกิดข้อผิดพลาด");
  }
}

// ── แปลด้วย Python server ──────────────────────────────────
async function doTranslate(text, targetLang) {
  const resultBox = document.getElementById("resultText");
  try {
    const res = await fetch(`${PYTHON_SERVER_URL}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target: targetLang })
    });
    if (!res.ok) throw new Error("เชื่อมต่อระบบแปลไม่ได้");
    const data       = await res.json();
    const translated = (data.translation || "").trim();

    _lastOriginalText   = text;
    _lastTranslatedText = translated;

    resultBox.innerHTML = `
      <div style="font-size:15px;color:#222;line-height:1.8;white-space:pre-wrap;">${translated}</div>
      <div style="margin-top:10px;">
        <button onclick="navigator.clipboard.writeText(this.dataset.t).then(()=>this.textContent='✅ คัดลอกแล้ว!')"
          data-t="${translated.replace(/"/g,"&quot;")}"
          style="padding:6px 14px;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;">
          📋 คัดลอกคำแปล
        </button>
      </div>`;
    setStatus("done", "แปลภาษาเสร็จแล้ว");

    // แสดง download bar ก่อน แล้วค่อย summarize
    showDownloadBar();
    await summarizeWithClaude(text, translated, targetLang);

  } catch (err) {
    resultBox.innerHTML = `<span style="color:#e53935;">❌ แปลไม่สำเร็จ: ${err.message}</span>`;
    setStatus("error", "แปลภาษาไม่สำเร็จ");
  }
}

// ── ปุ่ม "แปลภาษา" (จากการพิมพ์) ─────────────────────────
async function translateText() {
  const text       = document.getElementById("inputText").value.trim();
  const targetLang = document.getElementById("targetLang").value;
  const resultBox  = document.getElementById("resultText");

  if (!text || text.startsWith("⏳") || text.startsWith("❌")) {
    resultBox.innerHTML = `<span style="color:#e53935;">⚠️ กรุณาพิมพ์ข้อความก่อนครับ</span>`;
    return;
  }
  hideSummaryAndDownload();
  setStatus("processing", "กำลังแปลภาษา...");
  resultBox.innerHTML = buildProgressHTML(40, "กำลังส่งข้อความไปแปล...");
  await doTranslate(text, targetLang);
}

// ── สรุปด้วย Claude API ────────────────────────────────────
async function summarizeWithClaude(original, translated, targetLangCode) {
  const section   = document.getElementById("summarySection");
  const box       = document.getElementById("summaryBox");
  const langLabel = { th: "ภาษาไทย", en: "English", zh: "中文", ko: "한국어", ja: "日本語" }[targetLangCode] || targetLangCode;

  section.style.display = "block";
  box.innerHTML = `<span class="summary-loading">⏳ กำลังสรุปเนื้อหาด้วย AI...</span>`;

  try {
    const res = await fetch(`${PYTHON_SERVER_URL}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${original}\n\nคำแปล:\n${translated}`, target_lang: targetLangCode })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    const summary = data.summary || "";
    _lastSummaryText = summary.trim();
    box.textContent  = _lastSummaryText;
  } catch (err) {
    box.innerHTML = `<span style="color:#e57373;">⚠️ สรุปไม่สำเร็จ: ${err.message}</span>`;
  }
}

// ── show / hide helpers ───────────────────────────────────
function showDownloadBar() {
  document.getElementById("downloadBar").style.display = "flex";
}
function hideSummaryAndDownload() {
  document.getElementById("summarySection").style.display  = "none";
  document.getElementById("downloadBar").style.display = "none";
  _lastOriginalText   = "";
  _lastTranslatedText = "";
  _lastSummaryText    = "";
}

// ── โหลดผลลัพธ์ ───────────────────────────────────────────
async function downloadResult(format) {
  const translated = _lastTranslatedText || document.getElementById("resultText").innerText;
  const summary    = _lastSummaryText;
  const original   = _lastOriginalText || document.getElementById("inputText").value;

  if (!translated || translated.includes("ผลลัพธ์จากการแปล")) {
    alert("กรุณาแปลภาษาก่อนโหลดไฟล์ครับ");
    return;
  }

  if (format === "pdf") {
    await exportToPDF(original, translated, summary, "translate");
  } else {
    await exportToDOCX(original, translated, summary, "translate");
  }
}

// ── Export PDF ────────────────────────────────────────────
async function exportToPDF(original, translated, summary, mode) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const pageW  = doc.internal.pageSize.getWidth();
  const margin = 15;
  const maxW   = pageW - margin * 2;
  let y        = 20;

  const addSection = (title, body, titleColor, bodyColor) => {
    if (y > 260) { doc.addPage(); y = 20; }
    doc.setFontSize(13);
    doc.setTextColor(...titleColor);
    doc.text(title, margin, y);
    y += 7;

    doc.setFontSize(11);
    doc.setTextColor(...bodyColor);
    const lines = doc.splitTextToSize(body || "-", maxW);
    for (const line of lines) {
      if (y > 275) { doc.addPage(); y = 20; }
      doc.text(line, margin, y);
      y += 6;
    }
    y += 5;
  };

  // Header
  doc.setFontSize(18);
  doc.setTextColor(33, 150, 243);
  doc.text(mode === "translate" ? "ผลลัพธ์การแปลภาษา" : "ผลลัพธ์การถอดเสียง", margin, y);
  y += 12;

  addSection("📄 ข้อความต้นฉบับ", original,   [80, 80, 80],   [50, 50, 50]);
  addSection("🌍 คำแปล",          translated, [21, 101, 192], [33, 33, 33]);
  if (summary) addSection("🧠 สรุปเนื้อหา (AI)", summary, [56, 142, 60], [46, 125, 50]);

  doc.save(`potjana_${mode}_${Date.now()}.pdf`);
}

// ── Export DOCX ───────────────────────────────────────────
async function exportToDOCX(original, translated, summary, mode) {
  const docxLib = window.docx;
  if (!docxLib) {
    alert("ไม่สามารถโหลด Library สำหรับสร้าง DOCX ได้ กรุณาตรวจสอบว่ามี Script CDN ในหน้า HTML หรือยัง");
    return;
  }
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docxLib;

  const titleText = mode === "translate" ? "ผลลัพธ์การแปลภาษา" : "ผลลัพธ์การถอดเสียง";

  const wrapParagraphs = (text, style = {}) =>
    (text || "-").split("\n").map(line =>
      new Paragraph({ children: [new TextRun({ text: line, ...style })] })
    );

  const children = [
    new Paragraph({
      text: titleText,
      heading: HeadingLevel.HEADING_1
    }),
    new Paragraph({ text: "" }),

    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("📄 ข้อความต้นฉบับ")] }),
    ...wrapParagraphs(original, { color: "444444" }),
    new Paragraph({ text: "" }),

    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("🌍 คำแปล")] }),
    ...wrapParagraphs(translated, { bold: true }),
    new Paragraph({ text: "" }),

    ...(summary ? [
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("🧠 สรุปเนื้อหา (AI)")] }),
      ...wrapParagraphs(summary, { color: "2E7D32" }),
    ] : []),
  ];

  const document = new Document({
    sections: [{ children }]
  });

  const blob    = await Packer.toBlob(document);
  const url     = URL.createObjectURL(blob);
  const anchor  = window.document.createElement("a");
  anchor.href     = url;
  anchor.download = `potjana_${mode}_${Date.now()}.docx`;
  window.document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => { URL.revokeObjectURL(url); anchor.remove(); }, 1000);
}

// ── รีเซ็ต ────────────────────────────────────────────────
function resetTranslate() {
  document.getElementById("inputText").value      = "";
  document.getElementById("fileName").innerText   = "ยังไม่ได้เลือกไฟล์";
  document.getElementById("fileInput").value      = "";
  document.getElementById("resultText").innerText = "ผลลัพธ์จากการแปลภาษาจะแสดงตรงนี้...";
  hideSummaryAndDownload();
  setStatus("idle", "พร้อมใช้งาน");
}