// ============================================================
// web-connect-replicate
// ------------------------------------------------------------
// Appwrite Function yang jadi proxy ke Replicate API untuk web app
// (App.jsx). Selain generate audio, Function ini JUGA men-download hasil
// dari Replicate dan menyimpannya secara PERMANEN ke Appwrite Storage --
// karena file output di Replicate otomatis dihapus ~1 jam setelah generate,
// jadi kalau langsung dipakai apa adanya, link-nya bakal mati kalau user
// buka lagi nanti (mis. dari riwayat generate).
//
// Body request (JSON) -- field-nya PERSIS mengikuti payload yang dikirim
// App.jsx:
// {
//   "mode": "single" | "dialogue",
//   "text": "...",
//   "language": "en", "speed": 1.0, "temperature": 0.7, "output_format": "wav",
//   "speaker_wav": "https://.../voice.wav",
//   "speaker_map": { "Adam": "https://...wav", "Anna": "https://...wav" } // khusus mode dialogue
// }
//
// Response: { success: true, audioUrl: "<URL PERMANEN di Appwrite Storage>" }
// ============================================================

import Replicate from 'replicate';
import { Client, Storage, ID } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION;
// 🗂️ Bucket tempat hasil generate disimpan permanen -- WAJIB punya
// permission "Read: Any" supaya audio-nya bisa diputer langsung dari
// browser tanpa perlu login/API key.
const APPWRITE_AUDIO_BUCKET_ID = process.env.APPWRITE_AUDIO_BUCKET_ID;

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// 🔍 Cek apakah URL sudah benar-benar bisa diakses (anti race condition)
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
      speaker_map,
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

    // 3. Ekstrak URL output dari Replicate (sementara, cuma bertahan ~1 jam)
    let replicateAudioUrl = null;
    if (typeof prediction.output === 'string') {
      replicateAudioUrl = prediction.output;
    } else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
      replicateAudioUrl = prediction.output[0];
    }

    if (!replicateAudioUrl) {
      throw new Error('Prediction succeeded but no output URL was returned.');
    }

    const ready = await waitUntilUrlReady(replicateAudioUrl);
    if (!ready) {
      log('Warning: Replicate output URL belum terkonfirmasi siap, tetap dicoba download.');
    }

    // 4. Download audio dari Replicate ke memory
    log('Downloading audio from Replicate...');
    const audioResponse = await fetch(replicateAudioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio from Replicate (status ${audioResponse.status})`);
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    // 5. Upload ke Appwrite Storage -- ini yang bikin hasilnya PERMANEN,
    //    nggak ikut hilang pas Replicate hapus file aslinya setelah 1 jam.
    log('Uploading audio to Appwrite Storage...');
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);
    const storage = new Storage(client);

    const fileId = ID.unique();
    const fileName = `web-generation-${fileId}.${output_format}`;

    const uploadedFile = await storage.createFile(
      APPWRITE_AUDIO_BUCKET_ID,
      fileId,
      InputFile.fromBuffer(audioBuffer, fileName)
    );

    // 6. Bangun URL permanen ke file yang baru di-upload
    const permanentAudioUrl = `${process.env.APPWRITE_FUNCTION_API_ENDPOINT}/storage/buckets/${APPWRITE_AUDIO_BUCKET_ID}/files/${uploadedFile.$id}/view?project=${process.env.APPWRITE_FUNCTION_PROJECT_ID}`;

    log('Audio saved permanently: ' + permanentAudioUrl);

    return res.json({
      success: true,
      audioUrl: permanentAudioUrl,
    });

  } catch (err) {
    error('CRITICAL ERROR: ' + err.message);
    if (err.stack) error('Stack trace: ' + err.stack);
    return res.json({ success: false, error: err.message }, 500);
  }
};
