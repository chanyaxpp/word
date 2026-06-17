from flask import Flask, request, jsonify, Response, send_from_directory
from transformers import pipeline, AutoModelForSpeechSeq2Seq, AutoProcessor
from flask_cors import CORS
import os
import tempfile
import subprocess
import json
import re
import torch
import gc
import traceback

app = Flask(__name__)
CORS(app)

@app.route("/")
def index():
    return send_from_directory("/app", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("/app", filename)

app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# ── ตั้งค่า device: CUDA > MPS (Apple Silicon M1/M2/M3) > CPU ──
if torch.cuda.is_available():
    DEVICE = "cuda"
elif torch.backends.mps.is_available():
    DEVICE = "mps"
else:
    DEVICE = "cpu"

TORCH_DTYPE = torch.float16 if DEVICE in ("cuda", "mps") else torch.float32

print(f"✅ ใช้ device: {DEVICE} | dtype: {TORCH_DTYPE}")

# ── กำหนดโมเดลที่รองรับ (โหลด on-demand เมื่อใช้จริง) ──
MODELS = {
    "typhoon":    "scb10x/typhoon-isan-asr-whisper",
    "whisper_th": "biodatlab/whisper-th-medium-combined",
}

asr_pipelines = {}  # โหลด on-demand เมื่อใช้จริงครั้งแรก

def get_pipeline(model_key):
    """โหลดโมเดลเมื่อต้องการใช้ครั้งแรก เพื่อประหยัด RAM"""
    if model_key not in asr_pipelines:
        model_name = MODELS.get(model_key, MODELS["typhoon"])
        print(f"กำลังโหลดโมเดล [{model_key}] {model_name} | device={DEVICE} ...")
        asr_pipelines[model_key] = pipeline(
            "automatic-speech-recognition",
            model=model_name,
            device=DEVICE,
            dtype=TORCH_DTYPE,
            batch_size=8 if DEVICE in ("cuda", "mps") else 4,
        )
        print(f"✅ โมเดล [{model_key}] พร้อมใช้งานแล้ว!")
    return asr_pipelines[model_key]

ALLOWED_EXTENSIONS = {'.mp3', '.wav', '.m4a', '.mp4', '.mov', '.ogg', '.flac', '.webm'}

TH_WORD_REPAIR = {
    "น้ำต่อหู":  "น้ำเต้าหู้",
    "ทวนลือง":   "ถั่วเหลือง",
    "น้ำต้มหู้": "น้ำเต้าหู้",
    "ทัวเหลือง": "ถั่วเหลือง",
    "ทวนเหลือง": "ถั่วเหลือง",
}

def get_audio_duration(wav_path):
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", wav_path
    ], capture_output=True, text=True)
    try:
        return float(probe.stdout.strip())
    except:
        return 0.0

def detect_silence_splits(wav_path, target_chunk=30, min_silence_len=0.5, silence_thresh=-35):
    duration = get_audio_duration(wav_path)
    if duration == 0 or duration <= target_chunk * 1.5:
        return [(0, None)]

    result = subprocess.run([
        "ffmpeg", "-i", wav_path,
        "-af", f"silencedetect=noise={silence_thresh}dB:d={min_silence_len}",
        "-f", "null", "-"
    ], capture_output=True, text=True)

    silence_ends = []
    for m in re.finditer(r"silence_end: ([\d.]+)", result.stderr):
        t = float(m.group(1))
        if t < duration - 2:
            silence_ends.append(t)

    if not silence_ends:
        splits = []
        t = 0.0
        while t < duration:
            end = min(t + target_chunk, duration)
            splits.append((t, end if end < duration else None))
            t = end
        return splits

    splits = []
    current_start = 0.0
    next_target = target_chunk

    while current_start < duration - 5:
        window_start = next_target - 15
        window_end = next_target + 15
        candidates = [t for t in silence_ends if window_start < t < window_end and t > current_start + 5]

        if candidates:
            best = min(candidates, key=lambda t: abs(t - next_target))
        else:
            candidates = [t for t in silence_ends if t > current_start + 10]
            if candidates:
                after_half = [t for t in candidates if t >= current_start + target_chunk * 0.5]
                best = after_half[0] if after_half else candidates[-1]
            else:
                best = min(current_start + target_chunk, duration)

        splits.append((current_start, best))
        current_start = best
        next_target = current_start + target_chunk

    if current_start < duration - 1:
        splits.append((current_start, None))
    return splits

def extract_chunk(wav_path, start, end, out_path):
    cmd = ["ffmpeg", "-y", "-i", wav_path, "-ss", str(start)]
    if end is not None:
        cmd += ["-t", str(end - start)]
    cmd += ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out_path]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

def repair_text(text):
    for w, r in TH_WORD_REPAIR.items():
        text = text.replace(w, r)
    return text

def google_translate(text, target_lang):
    import urllib.request
    import urllib.parse
    if not text.strip():
        return ""
    try:
        params = urllib.parse.urlencode({"client": "gtx", "sl": "auto", "tl": target_lang, "dt": "t", "q": text})
        url = f"https://translate.googleapis.com/translate_a/single?{params}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        translated = ""
        if raw and isinstance(raw[0], list):
            for part in raw[0]:
                if part and part[0]:
                    translated += part[0]
        return translated
    except Exception as e:
        print(f"Google Translate Error: {e}")
        return text

def transcribe_chunk(chunk_path, offset=0.0, task="transcribe", source_lang=None, model_key="typhoon"):
    """ถอดเสียง 1 chunk — เลือกโมเดลได้ด้วย model_key พร้อม MPS/CUDA optimization"""
    try:
        selected_pipeline = get_pipeline(model_key)

        # num_beams=1 (greedy) เร็วขึ้น ~35% โดยไม่เสียความแม่นยำภาษาไทย
        gen_kwargs = {
            "num_beams": 1,
            "temperature": 0.0,
        }
        if task == "translate":
            gen_kwargs["task"] = "translate"
        # บังคับภาษาต้นฉบับถ้าผู้ใช้ระบุ — ถ้า auto ให้ Whisper ตรวจเอง
        if source_lang and source_lang != "auto":
            gen_kwargs["language"] = source_lang

        # ใช้ torch.inference_mode() เพื่อเร็วขึ้นและประหยัด memory
        with torch.inference_mode():
            result = selected_pipeline(
                chunk_path,
                return_timestamps=True,
                generate_kwargs=gen_kwargs,
            )

        full_text = repair_text(result["text"].strip())

        segments = []
        if result.get("chunks"):
            for chunk in result["chunks"]:
                ts = chunk.get("timestamp", (0, 0))
                seg_start = (ts[0] if ts[0] is not None else 0) + offset
                seg_end   = (ts[1] if ts[1] is not None else seg_start + 1) + offset
                seg_text  = repair_text(chunk["text"].strip())
                segments.append({
                    "start": round(seg_start, 2),
                    "end":   round(seg_end, 2),
                    "text":  seg_text,
                })

        detected_language = "th/isan" if model_key == "typhoon" else "th/en"
        return full_text, segments, detected_language

    finally:
        gc.collect()
        if DEVICE == "cuda" and torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif DEVICE == "mps":
            torch.mps.empty_cache()

@app.route("/ping", methods=["GET"])
def ping():
    return jsonify({"status": "ok"})

@app.route("/summarize", methods=["POST"])
def summarize_text():
    """สรุปข้อความด้วย Claude API (claude-haiku-4-5)"""
    import urllib.request as _urllib_req

    data = request.get_json()
    if not data or "text" not in data:
        return jsonify({"error": "ต้องระบุ text"}), 400

    text        = data["text"].strip()
    target_lang = data.get("target_lang", "th")

    if not text:
        return jsonify({"summary": ""}), 200

    lang_label = {
        "th": "ภาษาไทย", "en": "English", "zh": "ภาษาจีน (中文)",
        "ko": "ภาษาเกาหลี (한국어)", "ja": "ภาษาญี่ปุ่น (日本語)",
    }.get(target_lang, "ภาษาไทย")

    prompt = (
        f"คุณคือผู้ช่วย AI ที่เชี่ยวชาญการสรุปเนื้อหาภาษาไทย\n\n"
        f"ต่อไปนี้คือข้อความที่ถอดจากเสียงหรือแปลมา:\n\n"
        f"{text[:4000]}\n\n"
        f"สรุปเนื้อหาข้างต้นเป็น{lang_label} ในรูปแบบย่อหน้าสั้น ๆ 3-5 ประโยค "
        f"โดยบอกว่าบทความ/เสียงนี้พูดถึงอะไร ใจความสำคัญคืออะไร และข้อสรุปคืออะไร "
        f"ห้ามใช้ bullet หรือเลขข้อ ให้เขียนเป็นร้อยแก้วต่อเนื่องที่อ่านเข้าใจได้ทันที "
        f"ตอบเป็น{lang_label}เท่านั้น ไม่ต้องมีคำนำ"
    )

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        # fallback: extractive 3 ประโยคแรกที่ยาวสุด
        sentences = [s.strip() for s in re.split(r'\n+|(?<=[.!?])\s+', text) if len(s.strip()) > 15]
        top = sorted(sentences, key=len, reverse=True)[:3]
        return jsonify({"summary": "\n".join(f"{i+1}. {s}" for i, s in enumerate(top))})

    def extractive_fallback(t):
        sentences = [s.strip() for s in re.split(r'\n+|(?<=[.!?])\s+', t) if len(s.strip()) > 15]
        top = sorted(sentences, key=len, reverse=True)[:3]
        return "\n".join(f"{i+1}. {s}" for i, s in enumerate(top))

    try:
        payload = json.dumps({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 600,
            "messages": [{"role": "user", "content": prompt}]
        }).encode("utf-8")

        req = _urllib_req.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )
        with _urllib_req.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))

        summary = result["content"][0]["text"].strip()
        return jsonify({"summary": summary})

    except _urllib_req.HTTPError as e:
        if e.code in (401, 403):
            print(f"[WARN /summarize] API key ไม่ถูกต้องหรือหมดอายุ (HTTP {e.code}) — ใช้ extractive fallback")
            return jsonify({"summary": extractive_fallback(text)})
        err = traceback.format_exc()
        print(f"[ERROR /summarize Claude]\n{err}")
        return jsonify({"error": str(e)}), 500

    except Exception as e:
        err = traceback.format_exc()
        print(f"[ERROR /summarize Claude]\n{err}")
        return jsonify({"error": str(e)}), 500


@app.route("/translate", methods=["POST"])
def translate_text():
    data = request.get_json()
    if not data or "text" not in data or "target" not in data:
        return jsonify({"error": "ต้องระบุ text และ target"}), 400
    res = google_translate(data["text"], data["target"])
    return jsonify({"translation": res, "engine": "google"})

@app.route("/transcribe", methods=["POST"])
def transcribe_simple():
    """Route สำหรับ fallback — ถอดเสียงแบบไม่ streaming"""
    if "audio" not in request.files:
        return jsonify({"error": "ไม่พบไฟล์"}), 400

    audio_file = request.files["audio"]
    model_key = request.form.get("model", "typhoon")
    ext = os.path.splitext(audio_file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": f"ไม่รองรับ {ext}"}), 400

    tmp_upload = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
    tmp_upload_path = tmp_upload.name
    audio_file.save(tmp_upload_path)
    tmp_upload.close()
    tmp_wav_path = tmp_upload_path + "_converted.wav"

    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", tmp_upload_path,
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmp_wav_path
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

        text, segments, detected_lang = transcribe_chunk(tmp_wav_path, offset=0.0, model_key=model_key)
        return jsonify({"text": text, "segments": segments, "language": detected_lang})

    except Exception as e:
        err = traceback.format_exc()
        print(f"[ERROR /transcribe]\n{err}")
        return jsonify({"error": str(e), "detail": err}), 500
    finally:
        for p in [tmp_upload_path, tmp_wav_path]:
            if p and os.path.exists(p):
                try: os.remove(p)
                except: pass

@app.route("/transcribe-stream", methods=["POST"])
def transcribe_stream():
    if "audio" not in request.files:
        return jsonify({"error": "ไม่พบไฟล์"}), 400

    audio_file  = request.files["audio"]
    source_lang = request.form.get("source_lang", "auto")
    mode        = request.form.get("mode", "original")
    target_lang = request.form.get("target_lang", "th")
    model_key   = request.form.get("model", "typhoon")

    ext = os.path.splitext(audio_file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": f"ไม่รองรับ {ext}"}), 400

    tmp_upload = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
    tmp_upload_path = tmp_upload.name
    audio_file.save(tmp_upload_path)
    tmp_upload.close()
    tmp_wav_path = tmp_upload_path + "_converted.wav"

    def generate():
        chunk_paths = []
        try:
            yield f"data: {json.dumps({'type':'progress','pct':3,'msg':'กำลังแปลงไฟล์เสียง...'})}\n\n"

            # แปลงไฟล์เสียงให้เหมาะกับ ASR (ไม่ใช้ audio filter — Whisper จัดการ noise ได้เองดีอยู่แล้ว)
            subprocess.run([
                "ffmpeg", "-y", "-i", tmp_upload_path,
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmp_wav_path
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

            duration   = get_audio_duration(tmp_wav_path)
            # ไฟล์สั้น (<3 นาที) ใช้ chunk ใหญ่ขึ้นเพื่อลดจำนวนรอบ
            chunk_size = 60 if duration < 180 else 30
            splits     = detect_silence_splits(tmp_wav_path, target_chunk=chunk_size)
            total_chunks = len(splits)

            yield f"data: {json.dumps({'type':'progress','pct':8,'msg':f'ไฟล์ยาว {duration:.0f} วินาที แบ่งเป็น {total_chunks} ส่วน...'})}\n\n"

            for i, (start, end) in enumerate(splits):
                chunk_path = tmp_wav_path + f"_chunk{i}.wav"
                chunk_paths.append(chunk_path)
                extract_chunk(tmp_wav_path, start, end, chunk_path)

            all_texts        = []
            all_segments     = []
            final_detected_lang = "th/isan"

            for i, (start, end) in enumerate(splits):
                pct = 12 + int(((i + 0.5) / total_chunks) * 83)
                yield f"data: {json.dumps({'type':'progress','pct':pct,'msg':f'ถอดเสียงส่วนที่ {i+1}/{total_chunks} [{model_key}]...'})}\n\n"

                whisper_task = "translate" if (mode == "translate" and target_lang == "en") else "transcribe"
                text, segs, det_lang = transcribe_chunk(
                    chunk_paths[i], offset=start,
                    task=whisper_task, source_lang=source_lang,
                    model_key=model_key
                )

                if i == 0:
                    final_detected_lang = det_lang

                # แปลแบบ batch ครั้งเดียวตอนจบ chunk ไม่แปลทีละ segment
                if mode == "translate" and target_lang and target_lang != "en":
                    text = google_translate(text, target_lang)

                all_texts.append(text)
                all_segments.extend(segs)

                done_pct = 12 + int(((i + 1) / total_chunks) * 83)
                for seg in segs:
                    yield f"data: {json.dumps({'type':'segment','pct':done_pct,'seg':seg,'chunk_index':i})}\n\n"
                yield f"data: {json.dumps({'type':'chunk_done','pct':done_pct,'chunk_index':i,'chunk_text':text})}\n\n"

            final_text = " ".join(t for t in all_texts if t).strip()
            yield f"data: {json.dumps({'type':'done','pct':100,'text':final_text,'segments':all_segments,'language':final_detected_lang,'total_chunks':total_chunks,'model':model_key})}\n\n"

        except Exception as e:
            err_detail = traceback.format_exc()
            print(f"[ERROR /transcribe-stream]\n{err_detail}")
            yield f"data: {json.dumps({'type':'error','msg':str(e),'detail':err_detail[:500]})}\n\n"
        finally:
            for p in [tmp_upload_path, tmp_wav_path] + chunk_paths:
                if p and os.path.exists(p):
                    try: os.remove(p)
                    except: pass

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=5001, debug=debug_mode, threaded=True, use_reloader=debug_mode)