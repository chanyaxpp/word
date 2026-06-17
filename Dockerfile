FROM python:3.13-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# ไม่ COPY . . เพราะจะใช้ volume mount แทน
# ทำให้แก้ไขโค้ดได้โดยไม่ต้อง build ใหม่

EXPOSE 5001

# ใช้ FLASK_ENV=development เพื่อเปิด debug/reload อัตโนมัติ
ENV FLASK_ENV=development
ENV FLASK_DEBUG=1

CMD ["python", "-u", "app.py"]
