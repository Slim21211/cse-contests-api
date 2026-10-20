// Supabase Edge Function «uploads» — выдаёт браузеру одноразовые ссылки на загрузку
// частей файла прямо в VK Cloud и собирает файл после загрузки.
// Сам файл через функцию не проходит, поэтому таймауты и лимиты размера ей не страшны.
//
//   POST /uploads/start        { fileName, contentType, size, contest } → { key, uploadId, partSize, parts }
//   POST /uploads/sign-parts   { key, uploadId, partNumbers }           → { parts }
//   POST /uploads/complete     { key, uploadId, parts:[{partNumber,etag}] } → { publicUrl }
//   POST /uploads/abort        { key, uploadId }                        → { ok }
//   GET  /uploads/health                                                → { ok }
//
// Все POST требуют заголовок Authorization: Bearer <VK ID access token>.

import { AwsClient } from 'aws4fetch';

const env = (name: string, fallback?: string) => {
  const value = Deno.env.get(name) ?? fallback;
  if (value === undefined) throw new Error(`Не задан секрет ${name}`);
  return value;
};

const config = {
  corsOrigins: env('CORS_ORIGINS', 'https://contests.cse-hr.ru,https://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  vkAppId: env('VK_APP_ID'),
  vkIdBaseUrl: env('VK_ID_BASE_URL', 'https://id.vk.com'),
  s3Endpoint: env('S3_ENDPOINT', 'https://hb.ru-msk.vkcloud-storage.ru').replace(/\/$/, ''),
  s3Region: env('S3_REGION', 'ru-msk'),
  s3Bucket: env('S3_BUCKET', 'cse-contests'),
  s3AccessKeyId: env('S3_ACCESS_KEY_ID'),
  s3SecretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  /** true — бакет в пути URL (только для локальных S3-эмуляторов). */
  s3ForcePathStyle: env('S3_FORCE_PATH_STYLE', 'false') === 'true',
  maxFileSizeBytes: Number(env('MAX_FILE_SIZE_MB', '2048')) * 1024 * 1024,
  urlTtlSeconds: Number(env('UPLOAD_URL_TTL_SECONDS', String(6 * 60 * 60))),
};

const s3 = new AwsClient({
  accessKeyId: config.s3AccessKeyId,
  secretAccessKey: config.s3SecretAccessKey,
  service: 's3',
  region: config.s3Region,
});

// ---------- константы и проверки ----------

const CONTESTS = ['child', 'team', 'individual'];

// Только типы, которые умеет показывать сайт. Никаких html/svg/js — бакет публичный.
const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp',
  'mp4', 'mov', 'webm', 'ogg', 'avi', 'mkv', 'm4v',
  'mp3', 'wav', 'aac', 'oga', 'm4a',
  'pdf', 'doc', 'docx', 'txt', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'csv',
  'zip', 'rar', '7z',
]);

const MIN_PART_SIZE = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const getExtension = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

/** Безопасное имя для ключа: кириллица → латиница, остальное → «_». */
const safeName = (name: string) => {
  const ext = getExtension(name);
  const base = name.slice(0, name.length - ext.length - 1) || 'file';
  const latin = [...base.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('');
  const cleaned = latin.normalize('NFKD').replace(/[^a-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `${cleaned || 'file'}.${ext}`;
};

/** Ключ «конкурс/vkId/время_имя»: завершить или отменить загрузку может только её автор. */
const assertOwnKey = (key: unknown, userId: number): string => {
  if (typeof key !== 'string') throw badRequest('Некорректный ключ файла');
  const [contest, owner] = key.split('/');
  if (!CONTESTS.includes(contest) || owner !== String(userId)) {
    throw badRequest('Файл принадлежит другому пользователю');
  }
  return key;
};

const assertUploadId = (uploadId: unknown): string => {
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 1024) throw badRequest('Некорректный uploadId');
  return uploadId;
};

// ---------- VK ID ----------

const tokenCache = new Map<string, { userId: number; expiresAt: number }>();

/** Спрашивает у VK, чей это токен. client_id подтверждает, что токен выдан нашему приложению. */
const requireVkUser = async (req: Request): Promise<number> => {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'unauthorized', 'Требуется вход через VK');

  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;

  let res: Response;
  try {
    res = await fetch(`${config.vkIdBaseUrl}/oauth2/user_info?client_id=${encodeURIComponent(config.vkAppId)}`, {
      method: 'POST',
      body: new URLSearchParams({ access_token: token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('VK user_info unavailable:', err);
    throw new HttpError(503, 'vk_unavailable', 'Не удалось проверить вход через VK, попробуйте позже');
  }
  const data = await res.json().catch(() => null);
  const userId = Number(data?.user?.user_id);
  if (!res.ok || !userId) throw new HttpError(401, 'unauthorized', 'Сессия VK истекла, войдите заново');

  tokenCache.set(token, { userId, expiresAt: Date.now() + 5 * 60 * 1000 });
  return userId;
};

// ---------- S3 (VK Cloud) ----------

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

const objectUrl = (key: string) => {
  const endpoint = new URL(config.s3Endpoint);
  return config.s3ForcePathStyle
    ? `${config.s3Endpoint}/${config.s3Bucket}/${encodeKey(key)}`
    : `${endpoint.protocol}//${config.s3Bucket}.${endpoint.host}/${encodeKey(key)}`;
};

/** Ошибку S3 превращаем в понятную. NoSuchUpload → 404. */
const s3Error = async (res: Response, action: string) => {
  const text = await res.text();
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? `HTTP ${res.status}`;
  console.error(`S3 ${action} failed: ${code} ${text.slice(0, 300)}`);
  if (code === 'NoSuchUpload' || res.status === 404) {
    return new HttpError(404, 'no_such_upload', 'Загрузка не найдена или уже завершена');
  }
  return new HttpError(502, 'storage_error', 'Ошибка хранилища, попробуйте ещё раз');
};

const signPart = async (key: string, uploadId: string, partNumber: number) => {
  const url = new URL(objectUrl(key));
  url.searchParams.set('partNumber', String(partNumber));
  url.searchParams.set('uploadId', uploadId);
  url.searchParams.set('X-Amz-Expires', String(config.urlTtlSeconds));
  const signed = await s3.sign(url.toString(), { method: 'PUT', aws: { signQuery: true } });
  return signed.url;
};

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- обработчики ----------

const start = async (body: Record<string, unknown>, userId: number) => {
  const { fileName, contentType, size, contest } = body;
  if (typeof contest !== 'string' || !CONTESTS.includes(contest)) throw badRequest('Неизвестный конкурс');
  if (typeof fileName !== 'string' || !fileName || fileName.length > 255) throw badRequest('Некорректное имя файла');
  if (!ALLOWED_EXTENSIONS.has(getExtension(fileName))) throw badRequest('Этот тип файла не поддерживается');
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) throw badRequest('Некорректный размер файла');
  if (size > config.maxFileSizeBytes) {
    throw badRequest(`Файл больше ${Math.round(config.maxFileSizeBytes / 1024 / 1024)} МБ`);
  }

  const key = `${contest}/${userId}/${Date.now()}_${safeName(fileName)}`;
  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / (1024 * 1024)) * 1024 * 1024);
  const partCount = Math.ceil(size / partSize);

  const res = await s3.fetch(`${objectUrl(key)}?uploads`, {
    method: 'POST',
    headers: {
      'Content-Type': typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream',
      'x-amz-acl': 'public-read',
    },
  });
  if (!res.ok) throw await s3Error(res, 'CreateMultipartUpload');
  const uploadId = (await res.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new HttpError(502, 'storage_error', 'Хранилище не вернуло uploadId');

  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, i) => ({ partNumber: i + 1, url: await signPart(key, uploadId, i + 1) }))
  );
  console.log(`upload start: user=${userId} key=${key} size=${size} parts=${partCount}`);
  return { key, uploadId, partSize, parts };
};

const signParts = async (body: Record<string, unknown>, userId: number) => {
  const key = assertOwnKey(body.key, userId);
  const uploadId = assertUploadId(body.uploadId);
  const { partNumbers } = body;
  if (
    !Array.isArray(partNumbers) ||
    partNumbers.length === 0 ||
    partNumbers.length > MAX_PARTS ||
    !partNumbers.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_PARTS)
  ) {
    throw badRequest('Некорректные номера частей');
  }
  const parts = await Promise.all(
    (partNumbers as number[]).map(async (partNumber) => ({ partNumber, url: await signPart(key, uploadId, partNumber) }))
  );
  return { parts };
};

const complete = async (body: Record<string, unknown>, userId: number) => {
  const key = assertOwnKey(body.key, userId);
  const uploadId = assertUploadId(body.uploadId);
  const { parts } = body;
  if (
    !Array.isArray(parts) ||
    parts.length === 0 ||
    parts.length > MAX_PARTS ||
    !parts.every((p) => Number.isInteger(p?.partNumber) && typeof p?.etag === 'string' && p.etag)
  ) {
    throw badRequest('Некорректный список частей');
  }

  const xml =
    '<CompleteMultipartUpload>' +
    (parts as { partNumber: number; etag: string }[])
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
      .join('') +
    '</CompleteMultipartUpload>';

  const res = await s3.fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  // S3 может ответить 200, но с ошибкой внутри тела.
  const text = await res.clone().text();
  if (!res.ok || text.includes('<Error>')) throw await s3Error(new Response(text, { status: res.ok ? 500 : res.status }), 'Complete');

  console.log(`upload complete: user=${userId} key=${key}`);
  return { publicUrl: objectUrl(key) };
};

const abort = async (body: Record<string, unknown>, userId: number) => {
  const key = assertOwnKey(body.key, userId);
  const uploadId = assertUploadId(body.uploadId);
  const res = await s3.fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await s3Error(res, 'Abort');
  return { ok: true };
};

const routes: Record<string, (body: Record<string, unknown>, userId: number) => Promise<unknown>> = {
  start,
  'sign-parts': signParts,
  complete,
  abort,
};

// ---------- HTTP ----------

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get('origin') ?? '';
  return config.corsOrigins.includes(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };
};

export const handler = async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // Путь вида /uploads/start (Supabase) или /functions/v1/uploads/start — берём последний сегмент.
  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';

  if (req.method === 'GET' && action === 'health') return json({ ok: true });

  const route = routes[action];
  if (req.method !== 'POST' || !route) return json({ error: 'not_found' }, 404);

  try {
    const userId = await requireVkUser(req);
    const body = await req.json().catch(() => {
      throw badRequest('Тело запроса должно быть JSON');
    });
    return json(await route(body ?? {}, userId));
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
    console.error(`${action} failed:`, err);
    return json({ error: 'internal', message: 'Внутренняя ошибка, попробуйте ещё раз' }, 500);
  }
};

Deno.serve(handler);
