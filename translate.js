/* =========================================================
   translate.js — แปลภาษา + อ่าน .docx + สรุป AI + โหลด PDF/DOCX
   ========================================================= */
function goBack() { window.location.href = "index.html"; }

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "libs/pdf.worker.min.js";
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
  const safePct = Math.min(100, Math.max(0, Math.round(pct)));

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
      <div style="font-size:28px; font-weight:bold; color:#2196F3; text-align:center; margin:8px 0;">${safePct}%</div>
      ${chunkDots}
    </div>`;
}

// ── ฟัง event เลือกไฟล์ (รอ DOM โหลดก่อน) ──────────────────
window.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  if (fileInput) {
    fileInput.addEventListener("change", function(e) {
      const file = e.target.files[0];
      if (!file) return;
      document.getElementById("fileName").innerText = file.name;
      processUploadedFile(file);
    });
  }
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
      // mammoth อาจอยู่ใน global ต่างชื่อกัน ตรวจทุกแบบ
      const mammothLib = window.mammoth || window.Mammoth || (typeof mammoth !== "undefined" ? mammoth : null);
      if (!mammothLib) {
        textarea.value = "⚠️ ไลบรารี Mammoth ยังโหลดไม่เสร็จ กรุณารอสักครู่แล้วลองใหม่";
        setStatus("error", "โหลด mammoth ไม่ได้");
        return;
      }
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammothLib.extractRawText({ arrayBuffer });
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
          await doTranslate(evt.text, targetLang, evt.text, true); // true = มาจากไฟล์เสียง ให้แสดงช่องถอดเสมอ
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

// ── helper ปุ่มคัดลอก ─────────────────────────────────────
function copyBtn(text) {
  const safe = text.replace(/\\/g,"\\\\").replace(/`/g,"\\`");
  return `<button onclick="navigator.clipboard.writeText(\`${safe}\`).then(()=>{this.textContent='✅ คัดลอกแล้ว!';setTimeout(()=>this.textContent='📋 คัดลอก',2000)})"
    style="margin-top:8px;padding:5px 12px;border:1px solid #ccc;border-radius:6px;
    cursor:pointer;font-size:12px;background:#fff;color:#555;">📋 คัดลอก</button>`;
}

// ── แปลด้วย Python server ──────────────────────────────────
async function doTranslate(text, targetLang, transcribedText, forceShowTranscribed) {
  const resultBox = document.getElementById("resultText");

  // แสดงช่องถอดข้อความถ้ามาจากไฟล์เสียง (forceShowTranscribed=true)
  const transcribedSection = document.getElementById("transcribedSection");
  const transcribedBox     = document.getElementById("transcribedText");
  if (forceShowTranscribed && transcribedText) {
    transcribedSection.style.display = "block";
    transcribedBox.innerHTML = `<div style="white-space:pre-wrap;word-break:break-word;">${transcribedText}</div>${copyBtn(transcribedText)}`;
  } else {
    transcribedSection.style.display = "none";
  }

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

    // แสดงคำแปล + placeholder สรุปในกล่องเดียวกัน
    resultBox.innerHTML = `
      <div style="font-size:15px;color:#222;line-height:1.8;white-space:pre-wrap;">${translated}</div>
      ${copyBtn(translated)}
      <div style="font-size:12px;font-weight:bold;color:#388e3c;margin:14px 0 4px;display:flex;align-items:center;gap:5px;">
        🧠 สรุปเนื้อหาอัตโนมัติ (AI)
      </div>
      <div id="inlineSummaryBox" style="padding:12px 14px;background:linear-gradient(135deg,#e8f5e9,#f1f8e9);
        border-left:4px solid #43a047;border-radius:10px;font-size:13px;line-height:1.7;color:#2e7d32;
        white-space:pre-wrap;word-break:break-word;">
        <span style="color:#aaa;">⏳ กำลังสรุปเนื้อหาด้วย AI...</span>
      </div>`;
    setStatus("done", "แปลภาษาเสร็จแล้ว");

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
  const inlineBox = document.getElementById("inlineSummaryBox");

  try {
    const res = await fetch(`${PYTHON_SERVER_URL}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${original}\n\nคำแปล:\n${translated}`, target_lang: targetLangCode })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    _lastSummaryText = (data.summary || "").trim();
    if (inlineBox) inlineBox.innerHTML = _lastSummaryText.replace(/\n/g,"<br>") + copyBtn(_lastSummaryText);
  } catch (err) {
    if (inlineBox) inlineBox.innerHTML = `<span style="color:#e57373;">⚠️ สรุปไม่สำเร็จ: ${err.message}</span>`;
  }
}

// ── show / hide helpers ───────────────────────────────────
function showDownloadBar() {
  document.getElementById("downloadBar").style.display = "flex";
}
function hideSummaryAndDownload() {
  const ts = document.getElementById("transcribedSection");
  if (ts) ts.style.display = "none";
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

// ── Export PDF (html2canvas — รองรับภาษาไทย) ─────────────
async function exportToPDF(original, translated, summary, mode) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
    position: fixed; left: -9999px; top: 0;
    width: 794px; padding: 48px 56px;
    background: #fff; font-family: 'Sarabun', 'Segoe UI', sans-serif;
    font-size: 15px; line-height: 1.8; color: #222; box-sizing: border-box;
  `;

  const esc = s => (s || "-").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>");

  wrapper.innerHTML = `
    <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap" rel="stylesheet">
    <h1 style="font-size:22px;color:#2196F3;margin:0 0 24px;border-bottom:2px solid #e3f2fd;padding-bottom:12px;">
      🌍 ผลลัพธ์การแปลภาษา
    </h1>
    <h2 style="font-size:15px;color:#1565c0;margin:0 0 8px;">🌍 คำแปล</h2>
    <div style="background:#f5f5f5;padding:14px 16px;border-radius:8px;border-left:4px solid #2196F3;margin-bottom:24px;white-space:pre-wrap;word-break:break-word;">${esc(translated)}</div>
    ${summary ? `
    <h2 style="font-size:15px;color:#388e3c;margin:0 0 8px;">🧠 สรุปเนื้อหา (AI)</h2>
    <div style="background:#f1f8e9;padding:14px 16px;border-radius:8px;border-left:4px solid #43a047;color:#2e7d32;white-space:pre-wrap;word-break:break-word;">${esc(summary)}</div>
    ` : ""}
  `;
  document.body.appendChild(wrapper);

  await document.fonts.ready;
  await new Promise(r => setTimeout(r, 300));

  try {
    const canvas = await html2canvas(wrapper, { scale: 2, useCORS: true, backgroundColor: "#fff" });
    const { jsPDF } = window.jspdf;
    const pdf    = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageW  = pdf.internal.pageSize.getWidth();
    const pageH  = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const imgW   = pageW - margin * 2;
    const imgH   = (canvas.height * imgW) / canvas.width;

    let y = margin;
    let remaining = imgH;
    let srcY = 0;
    while (remaining > 0) {
      const sliceH = Math.min(remaining, pageH - margin * 2);
      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width  = canvas.width;
      sliceCanvas.height = (sliceH / imgW) * canvas.width;
      const ctx = sliceCanvas.getContext("2d");
      ctx.drawImage(canvas, 0, srcY * (canvas.width / imgW), canvas.width, sliceCanvas.height, 0, 0, canvas.width, sliceCanvas.height);
      pdf.addImage(sliceCanvas.toDataURL("image/jpeg", 0.95), "JPEG", margin, y, imgW, sliceH);
      remaining -= sliceH;
      srcY += sliceH;
      if (remaining > 0) { pdf.addPage(); y = margin; }
    }

    pdf.save(`potjana_${mode}_${Date.now()}.pdf`);
  } finally {
    document.body.removeChild(wrapper);
  }
}

// ── Export DOCX ───────────────────────────────────────────
async function exportToDOCX(original, translated, summary, mode) {
  // docx@8 expose ตัวเองใน window ชื่อต่าง ๆ — ลองทุกแบบ
  const docxLib = window.docx
    || window.DocxJS
    || window.DOCX
    || (typeof docx !== "undefined" ? docx : null)
    || (typeof DocxJS !== "undefined" ? DocxJS : null);
  if (!docxLib || !docxLib.Document) {
    // แสดง keys ที่มีใน window เพื่อ debug
    const keys = Object.keys(window).filter(k => /doc/i.test(k));
    alert("โหลด DOCX library ไม่สำเร็จ\nGlobal keys ที่พบ: " + (keys.join(", ") || "ไม่พบ") + "\nกรุณาส่ง screenshot นี้ให้ผู้พัฒนา");
    return;
  }
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docxLib;

  const titleText = mode === "translate" ? "ผลลัพธ์การแปลภาษา" : "ผลลัพธ์การถอดเสียง";

  const wrapParagraphs = (text, style = {}) =>
    (text || "-").split("\n").map(line =>
      new Paragraph({ children: [new TextRun({ text: line, ...style })] })
    );

  // แสดงเฉพาะผลลัพธ์สุดท้าย (คำแปล + สรุป)
  const children = [
    new Paragraph({ text: titleText, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: "" }),

    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("🌍 คำแปล")] }),
    ...wrapParagraphs(translated, { bold: true }),
    new Paragraph({ text: "" }),

    ...(summary ? [
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("🧠 สรุปเนื้อหา (AI)")] }),
      ...wrapParagraphs(summary, { color: "2E7D32" }),
    ] : []),
  ];

  const document = new Document({ sections: [{ children }] });
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