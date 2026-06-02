function goBack() { window.location.href = "index.html"; }

function setStatus(type, text) {
  const badge = document.getElementById("statusBadge");
  const span  = document.getElementById("statusText");
  if (!badge || !span) return;
  badge.className = "status-badge st-" + type;
  span.textContent = text;
  const dot = badge.querySelector(".dot");
  if (dot) dot.className = (type === "listening" || type === "processing") ? "dot pulse" : "dot";
}

const PYTHON_URL = "http://127.0.0.1:5001";
let recognition = null;
let currentEventSource = null;

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
  try {
    const res = await fetch(PYTHON_URL + "/ping", { signal: AbortSignal.timeout(3000) });
    const d   = await res.json();
    if (d.status === "ok") {
      box.innerText = "✅ เชื่อมต่อ Python Server สำเร็จ — พร้อมถอดเสียง\nเลือกตั้งค่าภาษาแล้วกดเริ่มถอดเสียงได้เลยครับ";
      setStatus("idle", "พร้อมใช้งาน");
      return;
    }
  } catch (_) {}
  box.innerText = "⚠️ ไม่พบ Python Server\nกรุณาเปิด Terminal แล้วรัน: python3 app.py";
  setStatus("error", "ไม่พบ Python Server");
}

async function processFileSpeech() {
  const fileInput = document.getElementById("mediaFile");
  const box = document.getElementById("speechResult");

  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    alert("กรุณาเลือกไฟล์เสียงหรือวิดีโอก่อนครับ");
    return;
  }

  const file = fileInput.files[0];
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);

  setStatus("processing", "กำลังส่งไฟล์...");
  box.innerHTML = buildProgressHTML(3, `กำลังส่งไฟล์ (${sizeMB} MB) ไปยังเซิร์ฟเวอร์...`);

  // ดึงค่าการตั้งค่าจากหน้าเว็บ UI
  const sourceLang = document.getElementById("sourceLang").value;
  const mode = document.querySelector('input[name="output_mode"]:checked').value;
  const targetLang = document.getElementById("targetLang").value;
  const modelKey = document.getElementById("modelSelect").value;

  const formData = new FormData();
  formData.append("audio", file);
  formData.append("source_lang", sourceLang);
  formData.append("mode", mode);
  formData.append("target_lang", targetLang);
  formData.append("model", modelKey);

  let chunkTexts = {};
  let allSegments = [];
  let totalChunks = 0;

  try {
    const response = await fetch(PYTHON_URL + "/transcribe-stream", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Server error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          box.innerHTML = buildProgressHTML(evt.pct,
            `ประมวลผลส่วนที่ ${(evt.chunk_index||0)+1}/${totalChunks||'?'} — [${formatTime(evt.seg.end)}]`,
            totalChunks, Object.keys(chunkTexts).length) +
            buildLiveSegments(allSegments);

        } else if (evt.type === "chunk_done") {
          if (evt.total_chunks) totalChunks = evt.total_chunks;
          chunkTexts[evt.chunk_index] = evt.chunk_text;
          const doneCount = Object.keys(chunkTexts).length;
          const pct = evt.pct || Math.round((doneCount / totalChunks) * 90 + 8);
          box.innerHTML =
            buildProgressHTML(pct, `เสร็จส่วนที่ ${doneCount}/${totalChunks}`, totalChunks, doneCount) +
            buildChunkSummary(chunkTexts, totalChunks);

        } else if (evt.type === "done") {
          setStatus("done", "สำเร็จแล้ว");
          box.innerHTML = buildFinalResult(evt.text, evt.segments, evt.total_chunks, evt.language, mode);

        } else if (evt.type === "error") {
          throw new Error(evt.msg);
        }
      }
    }

  } catch (error) {
    console.error(error);
    box.innerHTML = `<span style="color:#e53935;">❌ เกิดข้อผิดพลาด: ${error.message}<br><small>ลองตรวจสอบการทำงานของเซิร์ฟเวอร์หลังบ้าน</small></span>`;
    setStatus("error", "เกิดข้อผิดพลาด");
  }
}

function buildProgressHTML(pct, msg, totalChunks, doneChunks) {
  let chunkBar = "";
  if (totalChunks > 1) {
    const dots = Array.from({ length: totalChunks }, (_, i) => {
      const isDone = i < (doneChunks || 0);
      const isActive = i === (doneChunks || 0);
      const color = isDone ? "#4CAF50" : isActive ? "#2196F3" : "#e0e0e0";
      return `<span style="display:inline-block;width:${Math.max(8, Math.min(20, 180/totalChunks))}px;
        height:8px;border-radius:4px;background:${color};margin:1px;transition:background 0.3s;"></span>`;
    }).join("");
    chunkBar = `<div style="margin:6px 0 2px; text-align:center;">${dots}</div>
      <div style="font-size:11px;color:#888;margin-bottom:4px;">ส่วนที่ ${doneChunks||0}/${totalChunks} เสร็จแล้ว</div>`;
  }

  return `
    <div style="text-align:center; padding:10px 0;">
      <div style="font-size:14px; color:#555; margin-bottom:8px;">⏳ ${msg}</div>
      <div style="background:#eee; border-radius:20px; height:12px; overflow:hidden; margin-bottom:4px;">
        <div style="height:100%; width:${pct}%; background:linear-gradient(90deg,#2196F3,#00bcd4);
             border-radius:20px; transition:width 0.4s ease;"></div>
      </div>
      <div style="font-size:12px; color:#999;">${pct}%</div>
      ${chunkBar}
    </div>`;
}

function buildChunkSummary(chunkTexts, totalChunks) {
  const keys = Object.keys(chunkTexts).sort((a,b) => a-b);
  if (!keys.length) return "";
  return `<div style="margin-top:8px; max-height:140px; overflow-y:auto; font-size:12px;
    border-top:1px dashed #ddd; padding-top:8px;">` +
    keys.map(k => `<p style="margin-bottom:5px; padding:4px 8px; background:#f0f7ff;
      border-radius:6px;"><span style="color:#1976D2;font-weight:bold;">ส่วนที่ ${parseInt(k)+1}</span>
      — ${chunkTexts[k] || '(ว่างเปล่า)'}</p>`).join("") +
    `</div>`;
}

function buildLiveSegments(segs) {
  const last5 = segs.slice(-5);
  return `<div style="margin-top:8px; max-height:110px; overflow-y:auto; font-size:12px; color:#555;
    border-top:1px dashed #ddd; padding-top:6px;">` +
    last5.map(s => `<p style="margin-bottom:3px;">
      <span style="color:#007bff;">[${formatTime(s.start)}-${formatTime(s.end)}]</span> ${s.text}</p>`).join("") +
    `</div>`;
}

function buildFinalResult(text, segments, totalChunks, detectedLang, mode) {
  const labelText = mode === "translate" ? "แปลภาษาเสร็จสิ้น" : "ถอดความรวม";
  let html = `<div style="font-size:14px; color:#333; line-height:1.7; text-align:left;">`;
  html += `<div style="font-size:11px;color:#666;margin-bottom:8px;">🌐 ภาษาต้นฉบับที่ระบบตรวจพบ: <b>${detectedLang.toUpperCase()}</b> | จำนวนส่วน: ${totalChunks}</div>`;
  html += `<b>📝 ผลลัพธ์${labelText}:</b><br>
    <p style="background:#f5f5f5; padding:10px; border-radius:8px; margin:8px 0 15px;
    border-left:3px solid #2ecc71; white-space: pre-wrap;">${text}</p>`;

  if (segments && segments.length > 0) {
    html += `<b>⏰ รายละเอียดแยกตามช่วงเวลา:</b><br>
      <div style="max-height:180px; overflow-y:auto; border:1px solid #ddd; padding:8px;
      border-radius:8px; background:#fafafa; margin-bottom:10px;">`;
    segments.forEach(seg => {
      html += `<p style="margin-bottom:6px; font-size:13px;">
        <span style="color:#007bff; font-weight:bold;">[${formatTime(seg.start)} - ${formatTime(seg.end)}]</span>
        ${seg.text}</p>`;
    });
    html += `</div>`;
  }

  html += `<button onclick="navigator.clipboard.writeText(this.dataset.t).then(()=>this.textContent='✅ คัดลอกแล้ว!')"
    data-t="${text.replace(/"/g, "&quot;")}"
    style="padding:6px 14px; border:1px solid #ccc; border-radius:6px; cursor:pointer;
    font-size:13px; background:#fff; margin-top:4px;">📋 คัดลอกข้อความผลลัพธ์</button>`;
  html += `</div>`;
  return html;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert("กรุณาใช้ Google Chrome ครับ"); return; }
  recognition = new SR();
  recognition.lang = "th-TH";
  recognition.continuous = true;
  recognition.interimResults = true;
  const box = document.getElementById("speechResult");
  box.innerHTML = '<span style="color:#aaa;">🎙️ กำลังฟัง... พูดได้เลยครับ</span>';
  setStatus("listening", "กำลังฟังเสียง...");
  let finalText = "";

  recognition.onresult = function(e) {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      e.results[i].isFinal ? (finalText += t) : (interim += t);
    }
    box.innerHTML =
      '<div style="font-size:13px;color:#888;margin-bottom:8px;">🎙️ อัดเสียงสด (Web Speech API)</div>' +
      '<div style="font-size:16px;color:#222;line-height:1.6;">' + finalText +
      '<span style="color:#aaa;">' + interim + '</span></div>';
  };
  recognition.onerror = (e) => {
    box.innerHTML = '<span style="color:#e53935;">❌ ข้อผิดพลาด: ' + e.error + '</span>';
    setStatus("error", "เกิดข้อผิดพลาด");
  };
  recognition.onend = () => {
    if (document.getElementById("statusText").textContent === "กำลังฟังเสียง...") {
      setStatus("done", "เสร็จสิ้น");
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
  document.getElementById("mediaName").innerText = "ยังไม่ได้เลือกไฟล์";
  document.getElementById("mediaFile").value = "";
  setStatus("idle", "พร้อมใช้งาน");
}