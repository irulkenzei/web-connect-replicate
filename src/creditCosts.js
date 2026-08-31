// ============================================================
// creditCosts.js -- SUMBER KEBENARAN biaya kredit AI generation.
//
// File ini DISALIN PERSIS SAMA ke tiap generation function (pola yang
// sama dengan CREDIT_PACKS di create-checkout / create-midtrans-transaction
// / *-webhook). Kalau ubah nilai di sini, WAJIB sync ke SEMUA salinan.
// Salinan kanonik ada di functions/_shared/ -- test _shared/verifyCopies
// membandingkan tiap salinan dengan yang ini.
//
// Aturan penting:
//   - Backend adalah SATU-SATUNYA sumber kebenaran biaya. Frontend boleh
//     menampilkan estimasi, tapi TIDAK PERNAH dipercaya.
//   - Nilai yang benar-benar dikenakan disimpan di credit_ledger
//     (cost_snapshot + config_version) supaya histori transaksi tetap
//     akurat walau harga berubah di masa depan.
// ============================================================

const CONFIG_VERSION = '2026-08-31';

// type:
//   'flat'    -> biaya tetap per request. maxChars (opsional) = batas
//                input yang mendefinisikan "1 generation".
//   'perUnit' -> creditsPerUnit * jumlah unit (unit = 'image' | 'generation').
//                Jumlah unit ditentukan SERVER dari request/hasil, bukan client.
//   'free'    -> 0 kredit DAN lewati seluruh alur reserve/settle/refund
//                (cukup catat request_id untuk idempotency + tracking).
const CREDIT_COSTS = {
  speech: { type: 'flat', credits: 15, maxChars: 500 },
  dialogue: { type: 'flat', credits: 15, maxChars: 500 },
  emotion: { type: 'flat', credits: 15, maxChars: 500 },
  translate: { type: 'flat', credits: 15, maxChars: 500 },
  subtitle: { type: 'flat', credits: 15 },
  backsound: { type: 'flat', credits: 15 },
  soundEffect: { type: 'flat', credits: 15 },

  music: { type: 'perUnit', creditsPerUnit: 750, unit: 'generation' },
  avatar: { type: 'perUnit', creditsPerUnit: 750, unit: 'generation' },
  fluxMax: { type: 'perUnit', creditsPerUnit: 150, unit: 'image' },

  documentConvert: { type: 'free', credits: 0 },
  freeImage: { type: 'free', credits: 0 },
  cloudflareImage: { type: 'free', credits: 0 },
};

// Hitung biaya SEBENARNYA untuk 1 request. PURE -- tidak akses DB/network.
//
// input:
//   { chars?: number, units?: number }
//   - chars  : panjang teks (untuk validasi maxChars pada type 'flat')
//   - units  : jumlah gambar / generasi (type 'perUnit'; default 1)
//
// return: { feature, version, amount, unitBasis, quantity }
// throw : feature tak dikenal, atau input.chars melebihi maxChars.
function computeCost(feature, input = {}) {
  const spec = CREDIT_COSTS[feature];
  if (!spec) throw new Error(`Unknown credit feature: "${feature}"`);

  if (spec.type === 'free') {
    return { feature, version: CONFIG_VERSION, amount: 0, unitBasis: 'free', quantity: 0 };
  }

  if (spec.type === 'flat') {
    if (spec.maxChars && typeof input.chars === 'number' && input.chars > spec.maxChars) {
      throw new Error(`Input (${input.chars} chars) exceeds the ${spec.maxChars}-character limit for "${feature}"`);
    }
    return { feature, version: CONFIG_VERSION, amount: spec.credits, unitBasis: 'request', quantity: 1 };
  }

  if (spec.type === 'perUnit') {
    const qty = Math.max(1, Math.floor(Number(input.units) || 1));
    return {
      feature,
      version: CONFIG_VERSION,
      amount: spec.creditsPerUnit * qty,
      unitBasis: spec.unit,
      quantity: qty,
    };
  }

  throw new Error(`Unhandled cost type "${spec.type}" for "${feature}"`);
}

// Versi "aman" untuk estimasi UI: tidak melempar kalau input melewati
// cap (di-clamp ke cap) supaya tampilan tetap muncul.
function estimateCost(feature, input = {}) {
  const spec = CREDIT_COSTS[feature];
  if (!spec) return { feature, version: CONFIG_VERSION, amount: 0, unitBasis: 'unknown', quantity: 0 };
  const safe = { ...input };
  if (spec.maxChars && typeof safe.chars === 'number') {
    safe.chars = Math.min(safe.chars, spec.maxChars);
  }
  return computeCost(feature, safe);
}

export { CONFIG_VERSION, CREDIT_COSTS, computeCost, estimateCost };
