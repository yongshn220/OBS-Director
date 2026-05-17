"""
X32 Channel Monitor Server
--------------------------
설치: pip install sounddevice numpy websockets
실행: python x32_monitor_server.py
"""

import asyncio
import json
import numpy as np
import sounddevice as sd
import websockets
from websockets.server import serve

# ── 설정 ──────────────────────────────────────────────
DEVICE_NAME = "X32"          # 장치 이름 일부 (자동 검색)
CHANNELS    = 32              # 모니터할 채널 수 (최대 32)
SAMPLERATE  = 48000
BLOCKSIZE   = 2048
WS_PORT     = 8765
# ──────────────────────────────────────────────────────

channel_levels = [0.0] * CHANNELS
connected_clients = set()

def find_device():
    devices = sd.query_devices()
    for i, d in enumerate(devices):
        if DEVICE_NAME.lower() in d['name'].lower() and d['max_input_channels'] >= CHANNELS:
            print(f"✅ 장치 발견: [{i}] {d['name']} ({d['max_input_channels']}ch)")
            return i
    print("❌ X32 장치를 찾지 못했습니다. 사용 가능한 장치 목록:")
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            print(f"   [{i}] {d['name']} ({d['max_input_channels']}ch in)")
    return None

def audio_callback(indata, frames, time_info, status):
    global channel_levels
    for ch in range(CHANNELS):
        if ch < indata.shape[1]:
            rms = float(np.sqrt(np.mean(indata[:, ch] ** 2)))
            # 스무딩: 빠른 상승, 느린 하강
            prev = channel_levels[ch]
            channel_levels[ch] = rms if rms > prev else prev * 0.85 + rms * 0.15

async def broadcast():
    while True:
        if connected_clients:
            data = json.dumps({
                "levels": [round(v, 6) for v in channel_levels],
                "channels": CHANNELS
            })
            await asyncio.gather(
                *[ws.send(data) for ws in connected_clients],
                return_exceptions=True
            )
        await asyncio.sleep(0.05)  # 20fps

async def handler(ws):
    connected_clients.add(ws)
    print(f"🌐 클라이언트 연결됨 (총 {len(connected_clients)}개)")
    try:
        await ws.wait_closed()
    finally:
        connected_clients.discard(ws)
        print(f"🔌 클라이언트 연결 해제 (총 {len(connected_clients)}개)")

async def main():
    device_idx = find_device()
    if device_idx is None:
        print("\n장치 인덱스를 직접 입력하세요 (숫자): ", end="")
        device_idx = int(input())

    stream = sd.InputStream(
        device=device_idx,
        channels=CHANNELS,
        samplerate=SAMPLERATE,
        blocksize=BLOCKSIZE,
        callback=audio_callback
    )

    print(f"\n🎚️  X32 모니터 서버 시작")
    print(f"   WebSocket: ws://localhost:{WS_PORT}")
    print(f"   채널 수: {CHANNELS}ch  |  샘플레이트: {SAMPLERATE}Hz")
    print(f"   브라우저에서 x32_monitor.html 파일을 열어주세요\n")

    with stream:
        async with serve(handler, "localhost", WS_PORT):
            await broadcast()

if __name__ == "__main__":
    asyncio.run(main())
