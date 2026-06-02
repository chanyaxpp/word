function goBack() { window.location.href = "index.html"; }

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
}

const PYTHON_SERVER_URL = "http://127.0.0.1:5001";

document.getElementById("fileInput").addEventListener("change", function(event) {
  const file = event.target.files[0];
  if (!file) return;
  document.getElementById("fileName").innerText = file.name;
  processUploadedFile(file);
});

async function processUploadedFile(file) {
  const targetTextarea = document.getElementById("inputText");
  const fileNameLower = file.name.toLowerCase();
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);

  // รีเซ็ตผลลัพธ์เก่าออก
  document.getElementById("resultText").innerText = "ผลลัพธ์จากการแปลภาษาจะแสดงตรงนี้...";

  targetTextarea.value = `⏳ กำลังดึงข้อมูลจากไฟล์ ${file.name} (${sizeMB} MB)...`;

  try {
    if (fileNameLower.endsWith(".txt")) {
      const reader = new FileReader();
      reader.onload = function(e) { targetTextarea.value = e.target.result; };
      reader.readAsText(file);

    } else if (fileNameLower.endsWith(".pdf")) {
      const reader = new FileReader();
      reader.onload = async function(e) {
        const typedarray = new Uint8Array(e.target.result);
        const pdf = await pdfjsLib.getDocument(typedarray).promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          fullText += textContent.items.map(item => item.str).join(" ") + "\n";
        }
        targetTextarea.value = fullText.trim() || "⚠️ ไม่พบข้อความในไฟล์ PDF นี้";
      };
      reader.readAsArrayBuffer(file);

    } else if (/\.(jpg|jpeg|png)$/.test(fileNameLower)) {
      targetTextarea.value = "⏳ กำลังทำ OCR อ่านข้อความจากรูปภาพ...";
      const result = await Tesseract.recognize(file, 'tha+eng');
      targetTextarea.value = result.data.text.trim() || "⚠️ ไม่พบข้อความในรูปภาพ";

    } else if (/\.(mp3|wav|m4a|mp4|mov|ogg|flac|webm)$/.test(fileNameLower)) {
      // ถอดเสียงก่อน — ไม่แปลอัตโนมัติ รอให้ผู้ใช้กดแปลเอง
      await transcribeOnly(file, targetTextarea);

    } else {
      targetTextarea.value = "❌ ไม่รองรับไฟล์ประเภทนี้";
    }
  } catch (error) {
    targetTextarea.value = "❌ เกิดข้อผิดพลาดในการอ่านไฟล์: " + error.message;
  }
}

// ── ขั้นที่ 1: ถอดเสียงอย่างเดียว ไม่แปลอัตโนมัติ ──
async function transcribeOnly(file, textarea) {
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  textarea.value = `⏳ กำลังส่งไฟล์เสียง (${sizeMB} MB) ไปยังเซิร์ฟเวอร์...`;

  const modelSelect = document.getElementById("modelSelect");
  const modelKey = modelSelect ? modelSelect.value : "typhoon";

  const formData = new FormData();
  formData.append("audio", file);
  formData.append("source_lang", "auto");
  formData.append("mode", "original");
  formData.append("model", modelKey);

  let chunkTexts = {};
  let partialText = "";
  let totalChunks = 0;

  try {
    const response = await fetch(`${PYTHON_SERVER_URL}/transcribe-stream`, {
      method: "POST", body: formData
    });
    if (!response.ok) throw new Error(`Server error ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          textarea.value = `⏳ ${evt.msg} (${evt.pct}%)`;

        } else if (evt.type === "segment") {
          partialText += evt.seg.text + " ";
          textarea.value = `⏳ กำลังถอดเสียงส่วนที่ ${(evt.chunk_index||0)+1}/${totalChunks||'?'}...\n\n${partialText.trim()}`;

        } else if (evt.type === "chunk_done") {
          if (evt.total_chunks) totalChunks = evt.total_chunks;
          chunkTexts[evt.chunk_index] = evt.chunk_text;
          const doneCount = Object.keys(chunkTexts).length;
          textarea.value = `⏳ ถอดเสียงเสร็จแล้ว ${doneCount}/${totalChunks} ส่วน...\n\n${Object.values(chunkTexts).join(" ").trim()}`;

        } else if (evt.type === "done") {
          // ✅ ถอดเสียงเสร็จ — แสดงข้อความในกล่อง รอผู้ใช้กดแปลเอง
          textarea.value = evt.text;
          document.getElementById("resultText").innerHTML =
            `<span style="color:#4CAF50;">✅ ถอดเสียงเสร็จแล้ว! กดปุ่ม <b>🚀 แปลภาษา</b> ด้านบนเพื่อแปลข้อความได้เลยครับ</span>`;

        } else if (evt.type === "error") {
          throw new Error(evt.msg);
        }
      }
    }

  } catch (err) {
    // Fallback: ลองเรียก /transcribe แบบปกติ
    textarea.value = "⏳ กำลังลองถอดเสียงแบบ fallback...";
    try {
      const formData2 = new FormData();
      formData2.append("audio", file);
      formData2.append("source_lang", "auto");
      const res = await fetch(`${PYTHON_SERVER_URL}/transcribe`, { method: "POST", body: formData2 });
      const data = await res.json();
      if (data.text) {
        textarea.value = data.text;
        document.getElementById("resultText").innerHTML =
          `<span style="color:#4CAF50;">✅ ถอดเสียงเสร็จแล้ว! กดปุ่ม <b>🚀 แปลภาษา</b> ด้านบนเพื่อแปลได้เลยครับ</span>`;
      } else {
        textarea.value = "❌ ถอดเสียงไม่สำเร็จ";
      }
    } catch (e2) {
      textarea.value = "❌ เกิดข้อผิดพลาด: " + e2.message;
    }
  }
}

// ── ขั้นที่ 2: แปลภาษา — ส่งข้อความทั้งหมดครั้งเดียว ──
async function translateText() {
  const text = document.getElementById("inputText").value.trim();
  const targetLang = document.getElementById("language").value;
  const resultText = document.getElementById("resultText");

  if (!text || text.startsWith("⏳") || text.startsWith("❌")) {
    resultText.innerHTML = `<span style="color:#e53935;">⚠️ กรุณาพิมพ์ข้อความ หรือรอให้ถอดเสียงเสร็จก่อนครับ</span>`;
    return;
  }

  resultText.innerHTML = buildProgress(40, "กำลังส่งข้อความไปแปลภาษา...");

  try {
    const res = await fetch(`${PYTHON_SERVER_URL}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, target: targetLang })
    });

    if (!res.ok) throw new Error("ไม่สามารถเชื่อมต่อระบบแปลภาษาของเซิร์ฟเวอร์ได้");
    const data = await res.json();
    const finalTranslation = data.translation || "";

    resultText.innerHTML = `
      <div style="font-size:15px; color:#222; line-height:1.8; white-space:pre-wrap; text-align:left;">${finalTranslation.trim()}</div>
      <div style="text-align:left; margin-top:10px;">
        <button onclick="navigator.clipboard.writeText(this.dataset.t).then(()=>this.textContent='✅ คัดลอกแล้ว!')"
          data-t="${finalTranslation.trim().replace(/"/g,'&quot;')}"
          style="padding:6px 14px; border:1px solid #ccc; border-radius:6px;
          cursor:pointer; font-size:13px; background:#fff;">📋 คัดลอกคำแปล</button>
      </div>`;

  } catch (error) {
    resultText.innerHTML = `<span style="color:#e53935;">❌ ${error.message}</span>`;
  }
}

function buildProgress(pct, msg) {
  return `
    <div style="text-align:center; padding:8px 0;">
      <div style="font-size:13px; color:#555; margin-bottom:8px;">⏳ ${msg}</div>
      <div style="background:#eee; border-radius:20px; height:10px; overflow:hidden; margin-bottom:4px;">
        <div style="height:100%; width:${pct}%; background:linear-gradient(90deg,#4CAF50,#2196F3);
             border-radius:20px; transition:width 0.5s ease;"></div>
      </div>
      <div style="font-size:11px; color:#aaa;">${pct}%</div>
    </div>`;
}

function resetTranslate() {
  document.getElementById("inputText").value = "";
  document.getElementById("fileName").innerText = "ยังไม่ได้เลือกไฟล์";
  document.getElementById("fileInput").value = "";
  document.getElementById("resultText").innerText = "ผลลัพธ์จากการแปลภาษาจะแสดงตรงนี้...";
}