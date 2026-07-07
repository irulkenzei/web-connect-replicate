// ============================================================
// web-connect-replicate (Function ID: 6a4bedd10009fe338821)
// ------------------------------------------------------------
// Appwrite Function yang jadi proxy ke Replicate API untuk web app
// (App.jsx). Tujuannya: REPLICATE_API_TOKEN tidak pernah ter-expose ke
// browser -- token itu cuma hidup di sini (env var server-side), bukan di
// kode client yang ke-bundle Vite.
//
// Body request (JSON) -- field-nya PERSIS mengikuti payload yang dikirim
// App.jsx, jangan diubah tanpa ikut update App.jsx juga:
// {
//   "mode": "single" | "dialogue",
//   "text": "...",              // untuk mode dialogue, ini isinya skrip dialog lengkap
//   "language": "id",
//   "speed": 1.0,
//   "temperature": 0.7,
//   "output_format": "wav",
//   "speaker_wav": "https://.../voice.wav",
//   "speaker_map": { "Adam": "https://...wav", "Anna": "https://...wav" } // opsional, khusus mode dialogue
// }
//
// Response: { success: true, audioUrl: "..." }
// ============================================================

import Replicate from 'replicate';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION;

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// 🔍 Cek apakah URL audio output sudah benar-benar bisa diakses (anti race
// condition). Pakai fetch bawaan Node, tidak perlu axios.
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
  return false;
}

export default async ({ req, res, log, error }) => {
  log('web-connect-replicate function started');

  try {
    const payload = req.body
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)
      : {};

    const {
      mode = 'single',
      text,
      speaker_wav,
      speaker_map, // opsional -- App.jsx belum kirim ini untuk mode dialogue
      speaker_pause_ms = 500,
      language = 'en',
      speed = 1.0,
      temperature = 0.65,
      output_format = 'wav',
    } = payload;

    let input;

    if (mode === 'dialogue') {
      if (!text) {
        return res.json({ success: false, error: 'text (dialogue script) is required for dialogue mode' }, 400);
      }
      if (!speaker_map) {
        // App.jsx saat ini belum punya UI untuk assign voice per-speaker di
        // mode dialogue -- tanpa speaker_map, model tidak tahu speaker_wav
        // mana yang dipakai untuk nama speaker mana. Kasih pesan yang jelas
        // supaya gampang di-debug dari sisi client nanti.
        return res.json({
          success: false,
          error: 'speaker_map is required for dialogue mode (map of speaker name -> voice URL). This field is not yet sent by the current web UI.',
        }, 400);
      }
      input = {
        script: text,
        speaker_map: typeof speaker_map === 'string' ? speaker_map : JSON.stringify(speaker_map),
        speaker_pause_ms,
        language,
        speed,
        temperature,
        output_format,
      };
    } else {
      if (!text || !speaker_wav) {
        return res.json({ success: false, error: 'text and speaker_wav are required for single-speaker mode' }, 400);
      }
      input = {
        text,
        speaker_wav,
        language,
        speed,
        temperature,
        output_format,
      };
    }

    // 1. Mulai prediction lewat Replicate SDK
    log('Starting Replicate prediction with mode: ' + mode);
    let prediction = await replicate.predictions.create({
      version: MODEL_VERSION,
      input,
    });

    // 2. Polling manual sampai selesai
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
    let audioUrl = null;
    if (typeof prediction.output === 'string') {
      audioUrl = prediction.output;
    } else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
      audioUrl = prediction.output[0];
    }

    if (!audioUrl) {
      throw new Error('Prediction succeeded but no output URL was returned.');
    }

    // 4. Verifikasi URL benar-benar siap diakses sebelum dikembalikan
    const ready = await waitUntilUrlReady(audioUrl);
    if (!ready) {
      log('Warning: audioUrl belum terkonfirmasi siap setelah retry, tetap dikembalikan.');
    }

    log('Prediction succeeded: ' + prediction.id);

    return res.json({
      success: true,
      audioUrl,
    });

  } catch (err) {
    error('CRITICAL ERROR: ' + err.message);
    if (err.stack) error('Stack trace: ' + err.stack);
    return res.json({ success: false, error: err.message }, 500);
  }
};
