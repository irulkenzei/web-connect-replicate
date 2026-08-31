// ============================================================
// creditLedger.js -- reservasi kredit atomik + ledger transaksi.
//
// DISALIN PERSIS SAMA ke tiap PAID generation function + webhook-nya.
// Salinan kanonik: functions/_shared/creditLedger.js
//
// Model:  reserve  -> (generate)  -> settle (sukses)  /  refund (gagal)
//
//   1. reserveCredits()  dipanggil di generation function SEBELUM memicu
//      job pihak-3. Memotong saldo secara atomik. Kalau saldo kurang,
//      TIDAK ADA yang terpotong dan return { ok:false, reason:'insufficient' }.
//   2. settleCredits()   dipanggil di webhook saat job SUKSES. Saldo sudah
//      terpotong di step 1 -- ini hanya mengunci status ledger.
//   3. refundCredits()   dipanggil di webhook saat job GAGAL, ATAU dari
//      cron rekonsiliasi untuk row 'reserved' yang basi (webhook tak datang).
//
// Atomicity: saldo = user_stats.credit_balance (SATU kolom integer).
//   Appwrite tidak punya transaksi multi-dokumen, tapi
//   decrementDocumentAttribute(..., min:0) itu atomik per-atribut dan
//   MELEMPAR kalau hasilnya < 0 -- cukup untuk model reserve/settle di
//   satu field saldo.
//
// Idempotency: setiap request menulis SATU row di credit_ledger dengan
//   $id = requestId (index unik). createDocument akan gagal kalau row
//   sudah ada -> retry/webhook-ganda tidak akan double-charge/refund,
//   dan transisi status dijaga (hanya 'reserved' yang bisa di-settle/refund).
//
// PRASYARAT: node-appwrite >= 14 (Appwrite Server >= 1.6) untuk
//   increment/decrementDocumentAttribute. Untuk function yang masih
//   node-appwrite ^13, naikkan dulu ke ^20.
// ============================================================
import { Query } from 'node-appwrite';
import { computeCost } from './creditCosts.js';

const LEDGER_COLLECTION = 'credit_ledger';
const STATS_COLLECTION = 'user_stats';

async function findStatsDoc(databases, dbId, userId) {
  const r = await databases.listDocuments(dbId, STATS_COLLECTION, [
    Query.equal('user_id', userId),
    Query.limit(1),
  ]);
  return r.documents[0] || null;
}

async function getLedgerRow(databases, dbId, requestId) {
  try {
    return await databases.getDocument(dbId, LEDGER_COLLECTION, requestId);
  } catch {
    return null;
  }
}

async function writeLedgerRow(databases, dbId, data) {
  try {
    const now = new Date().toISOString();
    await databases.createDocument(dbId, LEDGER_COLLECTION, data.request_id, {
      ...data,
      created_at: now,
      updated_at: now,
    });
    return true;
  } catch (e) {
    const msg = String(e?.message || '');
    // Row sudah ada (race / retry) -- aman diabaikan oleh pemanggil.
    if (/already exists|requested ID already|Document with the requested ID/i.test(msg)) return false;
    throw e;
  }
}

// ------------------------------------------------------------
// RESERVE -- panggil di generation function SEBELUM memicu job pihak-3.
//
// args: { userId, requestId, feature, input, enforce }
//   input   -> diteruskan ke computeCost: { chars?, units? }
//   enforce -> true  (default): potong saldo betulan.
//              false (log-only): TIDAK potong saldo, tapi tetap tulis
//              ledger row (dry_run:true) supaya angka bisa divalidasi
//              lawan trafik nyata sebelum enforcement dinyalakan.
//
// return:
//   { ok:true,  amount:0,  free:true }               -> feature gratis
//   { ok:true,  amount:N,  balanceAfter:M }          -> lanjut generate
//   { ok:true,  amount:N,  dryRun:true }             -> log-only, lanjut generate
//   { ok:false, reason:'duplicate'|'insufficient'|'no_stats'|'error', message }
// ------------------------------------------------------------
async function reserveCredits(databases, dbId, { userId, requestId, feature, input = {}, enforce = true }) {
  if (!userId || !requestId) {
    return { ok: false, reason: 'error', message: 'userId and requestId are required' };
  }

  let cost;
  try {
    cost = computeCost(feature, input);
  } catch (e) {
    return { ok: false, reason: 'error', message: e.message };
  }

  const snapshot = JSON.stringify(cost);
  const base = {
    request_id: requestId,
    user_id: userId,
    feature,
    unit_basis: cost.unitBasis,
    quantity: cost.quantity,
    config_version: cost.version,
    cost_snapshot: snapshot,
  };

  // Feature gratis -> catat row 'free' saja, tidak menyentuh saldo.
  if (cost.amount === 0) {
    await writeLedgerRow(databases, dbId, { ...base, amount: 0, status: 'free' });
    return { ok: true, amount: 0, free: true };
  }

  // Sudah pernah diproses? (retry / double submit)
  const existing = await getLedgerRow(databases, dbId, requestId);
  if (existing) {
    return { ok: false, reason: 'duplicate', message: `request ${requestId} already has a ledger row (${existing.status})` };
  }

  const stats = await findStatsDoc(databases, dbId, userId);
  if (!stats) {
    return { ok: false, reason: 'no_stats', message: `no user_stats document for user ${userId}` };
  }

  // ---- LOG-ONLY: catat saja, jangan potong saldo ----
  if (!enforce) {
    await writeLedgerRow(databases, dbId, {
      ...base,
      amount: -cost.amount,
      status: 'reserved',
      balance_after: stats.credit_balance ?? null,
      dry_run: true,
    });
    return { ok: true, amount: cost.amount, dryRun: true };
  }

  // ---- ENFORCE: potong saldo secara atomik ----
  // min:0 -> Appwrite melempar kalau hasilnya negatif, jadi tidak akan
  // ada saldo yang terpotong saat kredit kurang.
  let balanceAfter;
  try {
    const updated = await databases.decrementDocumentAttribute(
      dbId,
      STATS_COLLECTION,
      stats.$id,
      'credit_balance',
      cost.amount,
      0
    );
    balanceAfter = updated.credit_balance;
  } catch (e) {
    return {
      ok: false,
      reason: 'insufficient',
      message: `not enough credits (need ${cost.amount}, have ${stats.credit_balance || 0})`,
    };
  }

  const wrote = await writeLedgerRow(databases, dbId, {
    ...base,
    amount: -cost.amount,
    status: 'reserved',
    balance_after: balanceAfter,
    dry_run: false,
  });

  // Kalau ledger row gagal ditulis karena SUDAH ADA (race yang lolos
  // pengecekan di atas), balikin saldo yang barusan kita potong supaya
  // tidak dobel.
  if (!wrote) {
    try {
      await databases.incrementDocumentAttribute(dbId, STATS_COLLECTION, stats.$id, 'credit_balance', cost.amount);
    } catch {
      /* biarkan cron rekonsiliasi yang menangani */
    }
    return { ok: false, reason: 'duplicate', message: `race: ledger row for ${requestId} already exists` };
  }

  return { ok: true, amount: cost.amount, balanceAfter };
}

// ------------------------------------------------------------
// SETTLE -- panggil di webhook saat job SUKSES.
// Idempotent: hanya row berstatus 'reserved' yang berubah.
// ------------------------------------------------------------
async function settleCredits(databases, dbId, requestId) {
  const row = await getLedgerRow(databases, dbId, requestId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'reserved') return { ok: true, noop: true, status: row.status };

  await databases.updateDocument(dbId, LEDGER_COLLECTION, requestId, {
    status: 'settled',
    updated_at: new Date().toISOString(),
  });
  return { ok: true };
}

// ------------------------------------------------------------
// REFUND -- panggil di webhook saat job GAGAL, atau dari cron
// rekonsiliasi untuk row 'reserved' yang basi.
// Idempotent: hanya row berstatus 'reserved' yang di-refund.
// ------------------------------------------------------------
async function refundCredits(databases, dbId, requestId, reason = 'failed') {
  const row = await getLedgerRow(databases, dbId, requestId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'reserved') return { ok: true, noop: true, status: row.status };

  const amount = Math.abs(row.amount);

  // Row log-only (dry_run) tidak pernah memotong saldo -> jangan
  // menambah balik. Cukup tandai statusnya.
  if (!row.dry_run) {
    const stats = await findStatsDoc(databases, dbId, row.user_id);
    if (stats) {
      await databases.incrementDocumentAttribute(dbId, STATS_COLLECTION, stats.$id, 'credit_balance', amount);
    }
  }

  await databases.updateDocument(dbId, LEDGER_COLLECTION, requestId, {
    status: 'refunded',
    refund_reason: String(reason).slice(0, 200),
    updated_at: new Date().toISOString(),
  });
  return { ok: true, refunded: row.dry_run ? 0 : amount };
}

// ------------------------------------------------------------
// guardReserve -- pembungkus reserveCredits untuk generation function
// yang berpola "async + webhook + job doc" (image / music / avatar / dst).
//
// Ambil user_id dari dokumen job, reserve, lalu terjemahkan hasilnya jadi
// keputusan yang tinggal dipakai caller:
//
//   const g = await guardReserve(databases, DATABASE_ID, {
//     jobsCollection: MUSIC_JOBS_COLLECTION_ID, requestId,
//     feature: 'backsound', input: {}, enforce, log, error,
//   });
//   if (!g.proceed) return res.json(g.body, g.status);
//
// Saat log-only (enforce=false): non-fatal apa pun -> proceed:true.
// Saat enforce: insufficient -> 402, duplicate -> 409, error lain -> 500.
// ------------------------------------------------------------
async function guardReserve(databases, dbId, opts) {
  const {
    jobsCollection,
    requestId,
    feature,
    input = {},
    enforce = false,
    userId: userIdOverride,
    log = () => {},
    error = () => {},
  } = opts;

  const markFailed = async (msg) => {
    try {
      await databases.updateDocument(dbId, jobsCollection, requestId, {
        status: 'failed',
        error_message: msg,
      });
    } catch {
      /* biarkan */
    }
  };

  let userId = userIdOverride;
  try {
    if (!userId) {
      const job = await databases.getDocument(dbId, jobsCollection, requestId);
      userId = job.user_id;
      // beberapa fitur menyimpan penanda di job doc yang mengubah feature
      if (feature === 'backsound' && job.sound_effect) opts.feature = 'soundEffect';
    }
  } catch (e) {
    error(`[credit] gagal baca job doc ${requestId}: ${e.message}`);
    if (enforce) {
      await markFailed('Credit check failed (job not found).');
      return { proceed: false, body: { ok: false, error: 'credit_check_failed' }, status: 500 };
    }
    return { proceed: true, dryRun: true };
  }

  let reserve;
  try {
    reserve = await reserveCredits(databases, dbId, {
      userId,
      requestId,
      feature: opts.feature || feature,
      input,
      enforce,
    });
  } catch (e) {
    error(`[credit] reserve threw for ${requestId}: ${e.message}`);
    if (enforce) {
      await markFailed('Credit system error.');
      return { proceed: false, body: { ok: false, error: 'credit_system_error' }, status: 500 };
    }
    return { proceed: true, dryRun: true };
  }

  if (reserve.ok) {
    log(`[credit] ${opts.feature || feature} reserve ${requestId}: ${JSON.stringify(reserve)}`);
    return { proceed: true, amount: reserve.amount, dryRun: !!reserve.dryRun, free: !!reserve.free };
  }

  if (reserve.reason === 'insufficient') {
    await markFailed('Not enough credits for this generation.');
    return { proceed: false, body: { ok: false, error: 'insufficient_credits' }, status: 402 };
  }
  if (reserve.reason === 'duplicate') {
    // Sudah pernah diproses (retry / double-submit) -- jangan generate ulang.
    return { proceed: false, body: { ok: false, error: 'duplicate_request' }, status: 409 };
  }

  // no_stats / error
  log(`[credit] reserve non-fatal (${reserve.reason}): ${reserve.message}`);
  if (enforce) {
    await markFailed('Credit check failed.');
    return { proceed: false, body: { ok: false, error: 'credit_check_failed' }, status: 500 };
  }
  return { proceed: true, dryRun: true };
}

export {
  reserveCredits,
  settleCredits,
  refundCredits,
  guardReserve,
  LEDGER_COLLECTION,
  STATS_COLLECTION,
};
