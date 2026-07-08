// ============================================================
// web-connect-replicate
// ------------------------------------------------------------
// PENTING soal async execution: Appwrite TIDAK PERNAH menyimpan
// responseBody untuk eksekusi async ("Response bodies and headers are not
// stored anywhere, so they are only ever returned via synchronous
// executions" -- dokumentasi resmi Appwrite). Karena generate audio pasti
// lebih dari 30 detik (batas keras eksekusi synchronous), kita WAJIB pakai
// async: true -- tapi itu artinya client TIDAK BISA ambil hasil lewat
// getExecution() sama sekali, apapun yang dicoba.
//
// Solusinya: Function ini nulis hasil generate ke collection Database
// (`web_generation_jobs`), pakai `requestId` yang dikirim client sebagai
// document ID. Client polling ke DOKUMEN ITU (databases.getDocument),
// BUKAN ke status eksekusi -- karena Database (beda dari Execution)
// memang didesain untuk nyimpen data secara permanen.
//
// Body request (JSON):
// {
//   "requestId": "...",  // 🆕 WAJIB -- ID unik dibuat client (ID.unique()),
//                         //     dipakai sebagai document ID job ini.
//   "mode": "single" | "dialogue",
//   "text": "...", "language": "en", "speed": 1.0, "temperature": 0.7,
//   "output_format": "wav", "speaker_wav": "...", "speaker_map": {...}
// }
// ============================================================

import Replicate from 'replicate';
import { Client, Storage, Databases, ID } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION;
const APPWRITE_AUDIO_BUCKET_ID = process.env.APPWRITE_AUDIO_BUCKET_ID;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID; // 🆕 perlu ditambah
const JOBS_COLLECTION_ID = 'web_generation_jobs'; // 🆕 collection baru

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

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

  let databases;
  let requestId;

  try {
    const payload = req.body
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)
      : {};

    const {
      requestId: reqId,
      mode = 'single',
      text,
      speaker_wav,
      speaker_map,
      speaker_pause_ms = 500,
      language = 'en',
      speed = 1.0,
      temperature = 0.65,
      output_format = 'wav',
      background_music, // 🎵 opsional -- URL musik latar untuk auto-ducking
      music_volume_db = -10.0,
    } = payload;

    requestId = reqId;

    if (!requestId) {
      return res.json({ success: false, error: 'requestId is required' }, 400);
    }

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);
    databases = new Databases(client);
    const storage = new Storage(client);

    let input;

    if (mode === 'dialogue') {
      if (!text) {
        throw new Error('text (dialogue script) is required for dialogue mode');
      }
      if (!speaker_map) {
        throw new Error('speaker_map is required for dialogue mode (map of speaker name -> voice URL).');
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
        throw new Error('text and speaker_wav are required for single-speaker mode');
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

    // 🎵 Teruskan parameter background music ke Replicate KALAU diisi --
    // sengaja ditulis di luar if/else mode di atas, biar berlaku sama untuk
    // mode single MAUPUN dialogue tanpa duplikasi kode.
    if (background_music) {
      input.background_music = background_music;
      input.music_volume_db = music_volume_db;
    }

    log('Starting Replicate prediction with mode: ' + mode);
    let prediction = await replicate.predictions.create({
      version: MODEL_VERSION,
      input,
    });

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

    let replicateAudioUrl = null;
    if (typeof prediction.output === 'string') {
      replicateAudioUrl = prediction.output;
    } else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
      replicateAudioUrl = prediction.output[0];
    }

    if (!replicateAudioUrl) {
      throw new Error('Prediction succeeded but no output URL was returned.');
    }

    await waitUntilUrlReady(replicateAudioUrl);

    log('Downloading audio from Replicate...');
    const audioResponse = await fetch(replicateAudioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio from Replicate (status ${audioResponse.status})`);
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    log('Uploading audio to Appwrite Storage...');
    const fileId = ID.unique();
    const fileName = `web-generation-${fileId}.${output_format}`;

    const uploadedFile = await storage.createFile(
      APPWRITE_AUDIO_BUCKET_ID,
      fileId,
      InputFile.fromBuffer(audioBuffer, fileName)
    );

    const permanentAudioUrl = `${process.env.APPWRITE_FUNCTION_API_ENDPOINT}/storage/buckets/${APPWRITE_AUDIO_BUCKET_ID}/files/${uploadedFile.$id}/view?project=${process.env.APPWRITE_FUNCTION_PROJECT_ID}`;

    log('Audio saved permanently: ' + permanentAudioUrl);

    // 📝 INI KUNCINYA -- tulis hasil ke Database, bukan cuma res.json().
    // Client bakal polling dokumen ini, bukan getExecution().
    await databases.createDocument(
      APPWRITE_DATABASE_ID,
      JOBS_COLLECTION_ID,
      requestId,
      {
        status: 'completed',
        audio_url: permanentAudioUrl,
        file_name: fileName,
        error_message: '',
      }
    );

    return res.json({ success: true, audioUrl: permanentAudioUrl, fileName });

  } catch (err) {
    error('CRITICAL ERROR: ' + err.message);
    if (err.stack) error('Stack trace: ' + err.stack);

    // Tulis status gagal ke job document juga, supaya client yang lagi
    // polling nggak nunggu selamanya -- dia bakal lihat status "failed".
    if (databases && requestId) {
      try {
        await databases.createDocument(
          APPWRITE_DATABASE_ID,
          JOBS_COLLECTION_ID,
          requestId,
          { status: 'failed', audio_url: '', file_name: '', error_message: err.message }
        );
      } catch (writeErr) {
        error('Gagal nulis job failed ke database: ' + writeErr.message);
      }
    }

    return res.json({ success: false, error: err.message }, 500);
  }
};
