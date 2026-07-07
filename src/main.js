import Replicate from 'replicate';

const REPLICATE_API_TOKEN = process.env.EXPO_PUBLIC_REPLICATE_API_TOKEN;
const MODEL_VERSION = process.env.EXPO_PUBLIC_REPLICATE_MODEL_VERSION;
// 🌍 Bahasa yang didukung XTTS v2 (kode bahasa sesuai standar ISO yang
// biasa dipakai XTTS / Coqui TTS). Dipakai untuk dropdown pilihan bahasa.
export const SUPPORTED_LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'pl', label: 'Polish' },
    { code: 'tr', label: 'Turkish' },
    { code: 'ru', label: 'Russian' },
    { code: 'nl', label: 'Dutch' },
    { code: 'cs', label: 'Czech' },
    { code: 'ar', label: 'Arabic' },
    { code: 'zh-cn', label: 'Chinese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'hu', label: 'Hungarian' },
    { code: 'ko', label: 'Korean' },
    { code: 'hi', label: 'Hindi' },
];
// 🎚️ Format audio output yang didukung. 'code' dikirim sebagai parameter
// `output_format` ke Replicate, 'label' dipakai untuk tampilan di UI.
export const SUPPORTED_FORMATS = [
    { code: 'mp3', label: 'MP3' },
    { code: 'wav', label: 'WAV' },
    { code: 'ogg', label: 'OGG' },
    { code: 'flac', label: 'FLAC' },
    { code: 'm4a', label: 'M4A' },
];
// 🎚️ Sample rate output yang didukung. 'code' dikirim sebagai parameter
// `sample_rate` (dalam Hz) ke Replicate, 'label' dipakai untuk tampilan di UI.
export const SUPPORTED_SAMPLE_RATES = [
    { code: 44100, label: '44.1 kHz' },
    { code: 48000, label: '48 kHz' },
];
// 🔍 CEK APAKAH URL AUDIO SUDAH BENAR-BENAR BISA DIAKSES (anti race condition)
const waitUntilUrlReady = async (url, maxRetries = 6, delayMs = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await axios.head(url, { timeout: 5000 });
            if (res.status === 200)
                return true;
        }
        catch (e) {
            // belum siap, lanjut retry
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false; // tetap return false setelah max retry, biar tidak infinite loop
};
export const generateVoiceOver = async (text, speakerAudioUrl, speakerId = '', // 🔥 "anna" / "adam" untuk preset, kosong untuk custom voice
language = 'en', // 🌍 sekarang bisa dipilih, default tetap 'en'
speed = 1.0, // 🏃 0.5 - 2.0, kecepatan bicara
temperature = 0.65, // 🎭 0.1 - 1.0, stability vs expressiveness
format = 'mp3', // 🎚️ wav / mp3 / ogg / flac / m4a
sampleRate = 44100 // 🎚️ 44100 atau 48000 (Hz)
) => {
    try {
        // 1. MINTA REPLICATE UNTUK MEMULAI (POST)
        const startResponse = await axios.post('https://api.replicate.com/v1/predictions', {
            version: MODEL_VERSION,
            input: {
                text: text,
                speaker_wav: speakerAudioUrl,
                language: language,
                speaker_id: speakerId,
                speed: speed,
                temperature: temperature,
                output_format: format,
                sample_rate: sampleRate
            }
        }, {
            headers: {
                'Authorization': `Token ${REPLICATE_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        let prediction = startResponse.data;
        const getPredictionUrl = prediction.urls.get;
        // 2. POLLING SAMPAI SELESAI
        while (prediction.status !== 'succeeded' &&
            prediction.status !== 'failed' &&
            prediction.status !== 'canceled') {
            console.log("Prediction status:", prediction.status);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const checkResponse = await axios.get(getPredictionUrl, {
                headers: { 'Authorization': `Token ${REPLICATE_API_TOKEN}` },
                timeout: 10000
            });
            prediction = checkResponse.data;
        }
        if (prediction.status !== 'succeeded') {
            throw new Error(`Replicate process failed: ${prediction.error}`);
        }
        // 3. VERIFIKASI URL OUTPUT BENAR-BENAR SIAP DIAKSES SEBELUM DIKEMBALIKAN
        let outputUrl = null;
        if (typeof prediction.output === 'string') {
            outputUrl = prediction.output;
        }
        else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
            outputUrl = prediction.output[0];
        }
        if (outputUrl) {
            const ready = await waitUntilUrlReady(outputUrl);
            if (!ready) {
                //console.warn('URL audio belum terkonfirmasi siap setelah retry, tetap dikembalikan.');
            }
        }
        // 4. KEMBALIKAN PREDICTION SETELAH URL DIPASTIKAN SIAP
        return prediction;
    }
    catch (error) {
        //console.error('Error di replicateService:', error);
        throw error;
    }
};
// 🎭 MODE DIALOG MULTI-SPEAKER
// ------------------------------------------------------------
// Sama persis pola axios+polling seperti generateVoiceOver di atas, cuma
// input yang dikirim ke Replicate beda: 'script' (skrip dialog format
// "[Nama]: teks...") + 'speaker_map' (JSON string nama->URL audio), bukan
// 'text' + 'speaker_wav' tunggal. Model yang sama (MODEL_VERSION) bisa
// menangani dua-duanya -- ditentukan lewat parameter mana yang diisi.
export const generateDialogueVoiceOver = async (script, speakerMap, // { "Ayah": "https://...wav", "Anak": "https://...wav" }
language = 'en', speed = 1.0, temperature = 0.65, speakerPauseMs = 500, format = 'mp3') => {
    try {
        // 1. MINTA REPLICATE UNTUK MEMULAI (POST)
        const startResponse = await axios.post('https://api.replicate.com/v1/predictions', {
            version: MODEL_VERSION,
            input: {
                script: script,
                speaker_map: JSON.stringify(speakerMap),
                speaker_pause_ms: speakerPauseMs,
                language: language,
                speed: speed,
                temperature: temperature,
                output_format: format,
            }
        }, {
            headers: {
                'Authorization': `Token ${REPLICATE_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        let prediction = startResponse.data;
        const getPredictionUrl = prediction.urls.get;
        // 2. POLLING SAMPAI SELESAI
        while (prediction.status !== 'succeeded' &&
            prediction.status !== 'failed' &&
            prediction.status !== 'canceled') {
            console.log("Dialogue prediction status:", prediction.status);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const checkResponse = await axios.get(getPredictionUrl, {
                headers: { 'Authorization': `Token ${REPLICATE_API_TOKEN}` },
                timeout: 10000
            });
            prediction = checkResponse.data;
        }
        if (prediction.status !== 'succeeded') {
            throw new Error(`Replicate process failed: ${prediction.error}`);
        }
        // 3. VERIFIKASI URL OUTPUT BENAR-BENAR SIAP DIAKSES SEBELUM DIKEMBALIKAN
        let outputUrl = null;
        if (typeof prediction.output === 'string') {
            outputUrl = prediction.output;
        }
        else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
            outputUrl = prediction.output[0];
        }
        if (outputUrl) {
            const ready = await waitUntilUrlReady(outputUrl);
            if (!ready) {
                //console.warn('URL audio belum terkonfirmasi siap setelah retry, tetap dikembalikan.');
            }
        }
        // 4. KEMBALIKAN PREDICTION SETELAH URL DIPASTIKAN SIAP
        return prediction;
    }
    catch (error) {
        throw error;
    }
};
