// Однократная настройка бакета VK Cloud: `npm run setup-bucket` (нужен .env рядом с package.json).
// 1. CORS — без него браузер не сможет грузить части файла напрямую в бакет.
// 2. Lifecycle — автоудаление брошенных незавершённых загрузок через 2 дня.

import 'dotenv/config';
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Не задана переменная ${name} (см. .env.example)`);
  return value;
};

const Bucket = env('S3_BUCKET', 'cse-contests');
const origins = env('CORS_ORIGINS', 'https://contests.cse-hr.ru,https://localhost')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const s3 = new S3Client({
  endpoint: env('S3_ENDPOINT', 'https://hb.ru-msk.vkcloud-storage.ru'),
  region: env('S3_REGION', 'ru-msk'),
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

await s3.send(
  new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
          AllowedHeaders: ['*'],
          // Без ETag в ответе браузер не сможет сообщить номера загруженных частей.
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  })
);
const cors = await s3.send(new GetBucketCorsCommand({ Bucket }));
console.log('CORS установлен:', JSON.stringify(cors.CORSRules, null, 2));

try {
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'abort-incomplete-multipart',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
          },
        ],
      },
    })
  );
  console.log('Lifecycle установлен: незавершённые загрузки удаляются через 2 дня');
} catch (err) {
  // Не критично: сайт сам отменяет загрузку при ошибке.
  console.warn('Lifecycle не установлен (хранилище может не поддерживать это правило):', (err as Error).message);
}
