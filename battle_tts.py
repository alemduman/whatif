import asyncio, base64, json, os, subprocess, time, urllib.request, urllib.error
L = json.load(open('lines.json')); os.makedirs('out', exist_ok=True)
STYLE = "Озвучь как азартный комментатор боёв на арене: энергично, с напряжением и паузами, по-русски. Текст: "
key = os.environ.get('GEMINI_API_KEY', '').strip()
def gemini(text, voice, out):
    body = {"contents": [{"parts": [{"text": STYLE + text}]}], "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
    req = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    d = json.loads(urllib.request.urlopen(req, timeout=180).read())
    for c in d.get('candidates', []):
        for p in (c.get('content') or {}).get('parts', []):
            inl = p.get('inlineData') or p.get('inline_data')
            if inl and inl.get('data'):
                rate = int(inl.get('mimeType', 'rate=24000').split('rate=')[-1].split(';')[0])
                import wave
                with wave.open(out, 'wb') as w:
                    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(base64.b64decode(inl['data']))
                return
    raise RuntimeError('no audio')
async def edge():
    import edge_tts
    for l in L:
        try:
            await edge_tts.Communicate(l['text'].replace('—', ','), 'ru-RU-DmitryNeural', rate='+8%').save(f"out/edge_{l['id']}.mp3")
        except Exception as e:
            print('edge err', l['id'], e)
asyncio.run(edge()) if os.environ.get('EDGE', '1') == '1' else None
for voice in ['Charon']:
    for l in L:
        for attempt in range(4):
            try:
                gemini(l['text'], voice, f"out/{voice}_{l['id']}.wav"); print('ok', voice, l['id']); break
            except urllib.error.HTTPError as e:
                b = e.read().decode(errors='replace')[:300]; print('HTTP', e.code, b)
                if e.code == 429 and 'PerDay' in b: raise SystemExit(0)
                time.sleep(40)
            except Exception as e:
                print('err', e); time.sleep(10)
        time.sleep(7)
