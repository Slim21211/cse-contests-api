// Отмена брошенных незавершённых загрузок: `npm run cleanup-uploads` (нужен .env или переменные окружения).
// Запускается раз в сутки из GitHub Actions (.github/workflows/cleanup-uploads.yml), потому что
// правило lifecycle в VK Cloud ключам функции недоступно.
//
// Готовые файлы скрипт не трогает: он работает только со списком незавершённых multipart-загрузок
// (ListMultipartUploads), а AbortMultipartUpload удаляет лишь их части. Завершённых объектов в этом
// списке нет. Загрузка сайта занимает максимум часы (ссылки живут UPLOAD_URL_TTL_SECONDS), поэтому
// всё старше CLEANUP_MIN_AGE_HOURS (по умолчанию 48) точно брошено.
//
// DRY_RUN=true — только показать, что было бы отменено.

import 'dotenv/config';
import { AbortMultipartUploadCommand, ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Не задана переменная ${name} (см. .env.example)`);
  return value;
};

const Bucket = env('S3_BUCKET', 'cse-contests');
const minAgeHours = Number(env('CLEANUP_MIN_AGE_HOURS', '48'));
if (!Number.isFinite(minAgeHours) || minAgeHours < 24) {
  throw new Error('CLEANUP_MIN_AGE_HOURS должен быть не меньше 24');
}
const dryRun = process.env.DRY_RUN === 'true';
const cutoff = Date.now() - minAgeHours * 3600 * 1000;

const s3 = new S3Client({
  endpoint: env('S3_ENDPOINT', 'https://hb.ru-msk.vkcloud-storage.ru'),
  region: env('S3_REGION', 'ru-msk'),
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// Сначала собираем весь список, потом отменяем — чтобы не сбивать постраничный обход.
const stale: { Key: string; UploadId: string; Initiated: Date }[] = [];
let total = 0;
let KeyMarker: string | undefined;
let UploadIdMarker: string | undefined;
do {
  const page = await s3.send(new ListMultipartUploadsCommand({ Bucket, KeyMarker, UploadIdMarker }));
  for (const u of page.Uploads ?? []) {
    total++;
    if (u.Key && u.UploadId && u.Initiated && u.Initiated.getTime() < cutoff) {
      stale.push({ Key: u.Key, UploadId: u.UploadId, Initiated: u.Initiated });
    }
  }
  if (!page.IsTruncated) break;
  KeyMarker = page.NextKeyMarker;
  UploadIdMarker = page.NextUploadIdMarker;
} while (KeyMarker || UploadIdMarker);

console.log(`Незавершённых загрузок: ${total}, старше ${minAgeHours} ч: ${stale.length}${dryRun ? ' (DRY_RUN)' : ''}`);

let failed = 0;
for (const u of stale) {
  const line = `${u.Initiated.toISOString()}  ${u.Key}`;
  if (dryRun) {
    console.log('  отменил бы', line);
    continue;
  }
  try {
    await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: u.Key, UploadId: u.UploadId }));
    console.log('  отменена', line);
  } catch (err) {
    failed++;
    console.error('  ошибка', line, (err as Error).message);
  }
}

if (failed) {
  console.error(`Не удалось отменить: ${failed}`);
  process.exit(1);
}
