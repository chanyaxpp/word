/* =========================================================
   script.js — ถอดเสียง + สรุป AI + โหลด PDF/DOCX
   ========================================================= */
function goBack() { window.location.href = "index.html"; }

// ใช้ path สัมพัทธ์ — Flask serve หน้าเว็บเองอยู่แล้ว (ดู app.py route "/")
// ทำให้ใช้งานได้ทันทีไม่ว่าจะเปิดผ่าน localhost, 127.0.0.1 หรือ IP เครื่องจริง
// (ไม่ต้องแก้ IP เองอีกต่อไป — ปัญหาเดิมคือ IP เครื่องเปลี่ยนไปแล้วแต่โค้ด hardcode ไว้)
const PYTHON_URL     = "";

let recognition       = null;
let currentEventSource = null;

// ── state ──────────────────────────────────────────────────
let _lastTranscribedText = "";
let _lastSummaryText     = "";

// ── status badge ──────────────────────────────────────────
function setStatus(type, text) {
  const badge = document.getElementById("statusBadge");
  const span  = document.getElementById("statusText");
  if (!badge || !span) return;
  badge.className = "status-badge st-" + type;
  span.textContent = text;
  const dot = badge.querySelector(".dot");
  if (dot) dot.className = (type === "listening" || type === "processing") ? "dot pulse" : "dot";
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

// ── DOMContentLoaded ──────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("mediaFile");
  if (input) {
    input.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      document.getElementById("mediaName").innerText = file.name;
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      document.getElementById("speechResult").innerText =
        `📁 เลือกไฟล์: ${file.name} (${sizeMB} MB)\nกดปุ่มด้านล่างเพื่อเริ่มถอดเสียง`;
      setStatus("idle", "มีไฟล์พร้อมแปลง");
    });
  }
  checkServer();
});

async function checkServer() {
  const box = document.getElementById("speechResult");
  // retry สูงสุด 10 ครั้ง ห่างกัน 3 วินาที รวม 30 วินาที
  // รองรับกรณีโมเดล Typhoon กำลังโหลดครั้งแรก ซึ่งใช้เวลา 10-30 วินาที
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      box.innerText = `⏳ กำลังเชื่อมต่อ Server... (${attempt}/10)`;
      const res = await fetch(PYTHON_URL + "/ping", { signal: AbortSignal.timeout(5000) });
      const d   = await res.json();
      if (d.status === "ok") {
        box.innerText = "✅ เชื่อมต่อ Server สำเร็จ — พร้อมถอดเสียง";
        setStatus("idle", "พร้อมใช้งาน");
        return;
      }
    } catch (_) {}
    if (attempt < 10) await new Promise(r => setTimeout(r, 3000));
  }
  box.innerText = "⚠️ ไม่พบ Python Server\nกรุณาตรวจสอบว่า Docker container รันอยู่:\n  docker compose up";
  setStatus("error", "ไม่พบ Python Server");
}

// ── ถอดเสียงจากไฟล์ ──────────────────────────────────────
async function processFileSpeech() {
  const fileInput = document.getElementById("mediaFile");
  const box       = document.getElementById("speechResult");

  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    alert("กรุณาเลือกไฟล์เสียงหรือวิดีโอก่อนครับ");
    return;
  }

  hideSummaryAndDownload();
  _lastTranscribedText = "";
  _lastSummaryText     = "";

  const file       = fileInput.files[0];
  const sizeMB     = (file.size / 1024 / 1024).toFixed(1);
  const sourceLang = document.getElementById("sourceLang").value;
  const mode       = document.querySelector('input[name="output_mode"]:checked').value;
  const targetLang = mode === "translate" ? document.getElementById("targetLang").value : "";
  const modelKey   = document.getElementById("modelSelect").value;

  setStatus("processing", "กำลังส่งไฟล์...");
  box.innerHTML = buildProgressHTML(3, `กำลังส่งไฟล์ (${sizeMB} MB)...`);

  const formData = new FormData();
  formData.append("audio", file);
  formData.append("source_lang", sourceLang);
  formData.append("mode", mode);
  if (targetLang) formData.append("target_lang", targetLang);
  formData.append("model", modelKey);

  let chunkTexts   = {};
  let allSegments  = [];
  let totalChunks  = 0;

  try {
    const response = await fetch(PYTHON_URL + "/transcribe-stream", {
      method: "POST", body: formData
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";
    setStatus("processing", "กำลังถอดเสียง...");

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
          box.innerHTML = buildProgressHTML(evt.pct, evt.msg, totalChunks, Object.keys(chunkTexts).length);

        } else if (evt.type === "segment") {
          allSegments.push(evt.seg);
          box.innerHTML = buildProgressHTML(
            evt.pct,
            `ถอดเสียงส่วนที่ ${(evt.chunk_index || 0) + 1}/${totalChunks || "?"}`,
            totalChunks, Object.keys(chunkTexts).length
          );

        } else if (evt.type === "chunk_done") {
          if (evt.total_chunks) totalChunks = evt.total_chunks;
          chunkTexts[evt.chunk_index] = evt.chunk_text;
          const done = Object.keys(chunkTexts).length;
          box.innerHTML = buildProgressHTML(evt.pct, `เสร็จ ${done}/${totalChunks} ส่วน`, totalChunks, done);

        } else if (evt.type === "done") {
          setStatus("done", "เสร็จแล้ว");
          _lastTranscribedText = evt.text;
          box.innerHTML = buildFinalResult(evt.text, evt.segments, evt.language, mode);

          // แสดง download bar + สรุป
          showDownloadBar();
          await summarizeWithClaude(evt.text, mode);

        } else if (evt.type === "error") {
          throw new Error(evt.msg);
        }
      }
    }

  } catch (error) {
    box.innerHTML = `<span style="color:#e53935;">❌ ${error.message}</span>`;
    setStatus("error", "เกิดข้อผิดพลาด");
  }
}

// ── สร้าง HTML ผลลัพธ์สุดท้าย ─────────────────────────────
// ── helper ปุ่มคัดลอก ─────────────────────────────────────
function copyBtn(text) {
  const safe = text.replace(/\\/g,"\\\\").replace(/`/g,"\\`");
  return `<button onclick="navigator.clipboard.writeText(\`${safe}\`).then(()=>{this.textContent='✅ คัดลอกแล้ว!';setTimeout(()=>this.textContent='📋 คัดลอก',2000)})"
    style="margin-top:8px;padding:5px 12px;border:1px solid #ccc;border-radius:6px;
    cursor:pointer;font-size:12px;background:#fff;color:#555;">📋 คัดลอก</button>`;
}

// ── สร้าง HTML ผลลัพธ์สุดท้าย ─────────────────────────────
function buildFinalResult(text, segments, detectedLang, mode) {
  const label = mode === "translate" ? "แปลภาษาเสร็จสิ้น" : "ถอดความรวม";
  let html = `<div style="font-size:12px;color:#888;margin-bottom:8px;">🌐 ภาษา: <b>${detectedLang.toUpperCase()}</b></div>`;
  html += `<b>📝 ${label}:</b>
    <div style="background:#f0f0f0;padding:10px;border-radius:8px;margin:8px 0 4px;
    border-left:3px solid #2ecc71;white-space:pre-wrap;">${text}</div>
    ${copyBtn(text)}`;

  if (segments && segments.length > 0) {
    html += `<b style="display:block;margin-top:12px;">⏰ รายละเอียดตามช่วงเวลา:</b>
      <div style="max-height:180px;overflow-y:auto;border:1px solid #ddd;padding:8px;
      border-radius:8px;background:#fafafa;margin-bottom:10px;">`;
    segments.forEach(seg => {
      html += `<p style="margin-bottom:5px;font-size:13px;">
        <span style="color:#007bff;font-weight:bold;">[${formatTime(seg.start)}-${formatTime(seg.end)}]</span>
        ${seg.text}</p>`;
    });
    html += `</div>`;
  }

  html += `
    <div style="font-size:12px;font-weight:bold;color:#388e3c;margin:14px 0 4px;display:flex;align-items:center;gap:5px;">
      🧠 สรุปเนื้อหาอัตโนมัติ (AI)
    </div>
    <div id="inlineSummaryBox" style="padding:12px 14px;background:linear-gradient(135deg,#e8f5e9,#f1f8e9);
      border-left:4px solid #43a047;border-radius:10px;font-size:13px;line-height:1.7;color:#2e7d32;
      white-space:pre-wrap;word-break:break-word;">
      <span style="color:#aaa;">⏳ กำลังสรุปเนื้อหาด้วย AI...</span>
    </div>`;
  return html;
}

function formatTime(s) {
  const m   = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

// ── สรุปด้วย Claude API ────────────────────────────────────
async function summarizeWithClaude(text, mode) {
  // เขียนลง inlineSummaryBox (อยู่ใน buildFinalResult) ถ้ามี
  // ถ้าไม่มี (กรณีไมค์สด) ให้ใช้ summarySection เดิม
  const inlineBox = document.getElementById("inlineSummaryBox");
  const section   = document.getElementById("summarySection");
  const box       = document.getElementById("summaryBox");

  if (!inlineBox) {
    // กรณีไมค์สด — ใช้ summarySection
    section.style.display = "block";
    box.innerHTML = `<span class="summary-loading">⏳ กำลังสรุปเนื้อหาด้วย AI...</span>`;
  }

  try {
    const res = await fetch(`${PYTHON_URL}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target_lang: "th" })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    _lastSummaryText = (data.summary || "").trim();

    if (inlineBox) {
      inlineBox.innerHTML = _lastSummaryText.replace(/\n/g,"<br>") + copyBtn(_lastSummaryText);
    } else {
      box.innerHTML = _lastSummaryText.replace(/\n/g,"<br>") + copyBtn(_lastSummaryText);
    }
  } catch (err) {
    const errHTML = `<span style="color:#e57373;">⚠️ สรุปไม่สำเร็จ: ${err.message}</span>`;
    if (inlineBox) {
      inlineBox.innerHTML = errHTML;
    } else {
      box.innerHTML = errHTML;
    }
  }
}

// ── show/hide helpers ─────────────────────────────────────
function showDownloadBar() {
  document.getElementById("downloadBar").style.display = "flex";
}
function hideSummaryAndDownload() {
  document.getElementById("summarySection").style.display = "none";
  document.getElementById("downloadBar").style.display    = "none";
}

// ── โหลดผลลัพธ์ ───────────────────────────────────────────
async function downloadResult(format) {
  if (!_lastTranscribedText) {
    alert("กรุณาถอดเสียงก่อนโหลดไฟล์ครับ");
    return;
  }
  if (format === "pdf") {
    await exportToPDF(_lastTranscribedText, _lastSummaryText, "speech");
  } else {
    await exportToDOCX(_lastTranscribedText, _lastSummaryText, "speech");
  }
}

// ── Export PDF (html2canvas — รองรับภาษาไทย) ─────────────
async function exportToPDF(text, summary, mode) {
  // สร้าง div ชั่วคราวสำหรับ render
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
      📝 ผลลัพธ์การถอดเสียง
    </h1>
    <h2 style="font-size:15px;color:#1565c0;margin:0 0 8px;">📝 ข้อความที่ถอดได้</h2>
    <div style="background:#f5f5f5;padding:14px 16px;border-radius:8px;border-left:4px solid #2196F3;margin-bottom:24px;white-space:pre-wrap;word-break:break-word;">${esc(text)}</div>
    ${summary ? `
    <h2 style="font-size:15px;color:#388e3c;margin:0 0 8px;">🧠 สรุปเนื้อหา (AI)</h2>
    <div style="background:#f1f8e9;padding:14px 16px;border-radius:8px;border-left:4px solid #43a047;color:#2e7d32;white-space:pre-wrap;word-break:break-word;">${esc(summary)}</div>
    ` : ""}
  `;
  document.body.appendChild(wrapper);

  // รอฟอนต์โหลด
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
    const imgData = canvas.toDataURL("image/jpeg", 0.95);

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

    pdf.save(`potjana_speech_${Date.now()}.pdf`);
  } finally {
    document.body.removeChild(wrapper);
  }
}

// ── Export DOCX ───────────────────────────────────────────
async function exportToDOCX(text, summary, mode) {
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

  const wrapParagraphs = (t, style = {}) =>
    (t || "-").split("\n").map(line =>
      new Paragraph({ children: [new TextRun({ text: line, ...style })] })
    );

  // แสดงเฉพาะผลลัพธ์สุดท้าย (ถอดความ + สรุป)
  const children = [
    new Paragraph({ text: "ผลลัพธ์การถอดเสียง", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: "" }),
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("📝 ข้อความที่ถอดได้")] }),
    ...wrapParagraphs(text, { bold: true }),
    new Paragraph({ text: "" }),
    ...(summary ? [
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("🧠 สรุปเนื้อหา (AI)")] }),
      ...wrapParagraphs(summary, { color: "2E7D32" }),
    ] : []),
  ];

  const document = new Document({ sections: [{ children }] });
  const blob     = await Packer.toBlob(document);
  const url      = URL.createObjectURL(blob);
  const anchor   = window.document.createElement("a");
  anchor.href     = url;
  anchor.download = `potjana_speech_${Date.now()}.docx`;
  window.document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => { URL.revokeObjectURL(url); anchor.remove(); }, 1000);
}

// ── ไมค์สด ────────────────────────────────────────────────
function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert("กรุณาใช้ Google Chrome ครับ"); return; }
  recognition = new SR();
  recognition.lang         = "th-TH";
  recognition.continuous   = true;
  recognition.interimResults = true;
  const box = document.getElementById("speechResult");
  box.innerHTML = '<span style="color:#aaa;">🎙️ กำลังฟัง... พูดได้เลย</span>';
  setStatus("listening", "กำลังฟังเสียง...");
  hideSummaryAndDownload();
  let finalText = "";

  recognition.onresult = function(e) {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      e.results[i].isFinal ? (finalText += t) : (interim += t);
    }
    box.innerHTML = '<div style="font-size:13px;color:#888;margin-bottom:6px;">🎙️ อัดเสียงสด</div>' +
      '<div style="font-size:16px;color:#222;line-height:1.6;">' + finalText +
      '<span style="color:#aaa;">' + interim + "</span></div>";
    _lastTranscribedText = finalText;
  };
  recognition.onerror = (e) => {
    box.innerHTML = '<span style="color:#e53935;">❌ ' + e.error + "</span>";
    setStatus("error", "เกิดข้อผิดพลาด");
  };
  recognition.onend = async () => {
    setStatus("done", "หยุดบันทึกแล้ว");
    if (_lastTranscribedText) {
      // แสดงข้อความพร้อมปุ่มคัดลอก + placeholder สรุป
      box.innerHTML = `
        <div style="font-size:13px;color:#888;margin-bottom:6px;">🎙️ อัดเสียงสด</div>
        <div style="font-size:16px;color:#222;line-height:1.6;white-space:pre-wrap;">${_lastTranscribedText}</div>
        ${copyBtn(_lastTranscribedText)}
        <div style="font-size:12px;font-weight:bold;color:#388e3c;margin:14px 0 4px;display:flex;align-items:center;gap:5px;">
          🧠 สรุปเนื้อหาอัตโนมัติ (AI)
        </div>
        <div id="inlineSummaryBox" style="padding:12px 14px;background:linear-gradient(135deg,#e8f5e9,#f1f8e9);
          border-left:4px solid #43a047;border-radius:10px;font-size:13px;line-height:1.7;color:#2e7d32;
          white-space:pre-wrap;word-break:break-word;">
          <span style="color:#aaa;">⏳ กำลังสรุปเนื้อหาด้วย AI...</span>
        </div>`;
      showDownloadBar();
      await summarizeWithClaude(_lastTranscribedText, "original");
    }
  };
  recognition.start();
}

function stopSpeech() {
  if (recognition) { recognition.stop(); setStatus("done", "หยุดบันทึกแล้ว"); }
}

function resetSpeech() {
  if (recognition) recognition.stop();
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }
  document.getElementById("speechResult").innerText = "ข้อความจากการแปลงเสียงจะแสดงที่นี่...";
  document.getElementById("mediaName").innerText    = "ยังไม่ได้เลือกไฟล์";
  document.getElementById("mediaFile").value        = "";
  hideSummaryAndDownload();
  _lastTranscribedText = "";
  _lastSummaryText     = "";
  setStatus("idle", "พร้อมใช้งาน");
}