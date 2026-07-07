// ============================================================
// web-connect-replicate
// ------------------------------------------------------------
// Appwrite Function yang jadi proxy ke Replicate API. Tujuannya: supaya
// REPLICATE_API_TOKEN tidak pernah ter-expose ke client (web/app) -- token
// itu cuma hidup di sini, di env var server-side, bukan di .env client
// yang ke-bundle ke browser/HP.
//
// Body request (JSON), ada 2 mode:
//
// Mode single-speaker: {
//   "mode": "single",
//   "text": "...",
//   "speakerWav": "https://.../speaker.wav",
//   "language": "en", "speed": 1.0, "temperature": 0.65, "format": "mp3"
// }
//
// Mode dialog multi-speaker: {
//   "mode": "dialogue",
//   "script": "[Adam]: teks...\n[Anna]: teks...",
//   "speakerMap": { "Adam": "https://...wav", "Anna": "https://...wav" },
//   "speakerPauseMs": 500,
//   "language": "en", "speed": 1.0, "temperature": 0.65, "format": "mp3"
// }
//
// Response: { success: true, outputUrl, predictionId }
// ============================================================

import Replicate from 'replicate';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION;

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// 🔍 Cek apakah URL audio output sudah benar-benar bisa diakses (anti race
// condition -- kadang file Replicate belum fully committed walau status
// prediction sudah "succeeded"). Pakai fetch bawaan Node (tidak perlu axios).
async function waitUntilUrlReady(url, maxRetries = 6, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const headRes = await fetch(url, { method: 'HEAD' });
      if (headRes.ok) return true;
    } catch (e) {
      // belum siap, lanjut retry
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false; // tetap return false setelah max retry, biar tidak infinite loop
}

export default async ({ req, res, log, error }) => {
  log('web-connect-replicate function started');

  try {
    const payload = req.body
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)
      : {};

    const {
      mode = 'single', // 'single' | 'dialogue'
      text,
      speakerWav,
      script,
      speakerMap,
      speakerPauseMs = 500,
      language = 'en',
      speed = 1.0,
      temperature = 0.65,
      format = 'mp3',
    } = payload;

    let input;

    if (mode === 'dialogue') {
      if (!script || !speakerMap) {
        return res.json({ success: false, error: 'script and speakerMap are required for dialogue mode' }, 400);
      }
      input = {
        script,
        speaker_map: JSON.stringify(speakerMap),
        speaker_pause_ms: speakerPauseMs,
        language,
        speed,
        temperature,
        output_format: format,
      };
    } else {
      if (!text || !speakerWav) {
        return res.json({ success: false, error: 'text and speakerWav are required for single-speaker mode' }, 400);
      }
      input = {
        text,
        speaker_wav: speakerWav,
        language,
        speed,
        temperature,
        output_format: format,
      };
    }

    // 1. Mulai prediction lewat Replicate SDK (bukan axios manual)
    log('Starting Replicate prediction...');
    let prediction = await replicate.predictions.create({
      version: MODEL_VERSION,
      input,
    });

    // 2. Polling manual sampai selesai -- SDK punya replicate.wait() bawaan,
    //    tapi polling manual di sini dipertahankan supaya timeout-nya bisa
    //    kita kontrol sendiri (generate audio panjang bisa makan waktu lebih
    //    dari default timeout bawaan SDK).
    while (
      prediction.status !== 'succeeded' &&
      prediction.status !== 'failed' &&
      prediction.status !== 'canceled'
    ) {
      log('Prediction status: ' + prediction.status);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      prediction = await replicate.predictions.get(prediction.id);
    }

    if (prediction.status !== 'succeeded') {
      throw new Error(`Replicate process failed: ${prediction.error || 'unknown error'}`);
    }

    // 3. Ekstrak URL output
    let outputUrl = null;
    if (typeof prediction.output === 'string') {
      outputUrl = prediction.output;
    } else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
      outputUrl = prediction.output[0];
    }

    // 4. Verifikasi URL benar-benar siap diakses sebelum dikembalikan
    if (outputUrl) {
      const ready = await waitUntilUrlReady(outputUrl);
      if (!ready) {
        log('Warning: output URL belum terkonfirmasi siap setelah retry, tetap dikembalikan.');
      }
    }

    log('Prediction succeeded: ' + prediction.id);

    return res.json({
      success: true,
      outputUrl,
      predictionId: prediction.id,
    });

  } catch (err) {
    error('CRITICAL ERROR: ' + err.message);
    if (err.stack) error('Stack trace: ' + err.stack);
    return res.json({ success: false, error: err.message }, 500);
  }
};
