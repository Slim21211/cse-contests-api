# cse-contests-api

Загрузка конкурсных работ для https://contests.cse-hr.ru. Это одна **Supabase Edge Function** `uploads`, без своего сервера.

## Зачем она нужна

Работы хранятся в бакете VK Cloud. Писать туда можно только с секретным ключом, а ключ даёт полный доступ к бакету: удалить или подменить любую работу. Поэтому в браузер его отдавать нельзя.

Функция держит ключ у себя и выдаёт браузеру одноразовые пропуска: «можно положить вот эту часть вот этого файла в течение 6 часов». Перед этим она проверяет, что человек вошёл через VK.

```
браузер ──POST /uploads/start─────▶ функция: проверяет VK-токен, создаёт загрузку в VK Cloud,
        ◀── ссылки на части ───────          подписывает ссылку на каждую часть (8 МБ)
браузер ──PUT части (×3 параллельно)──────────────────────────▶ VK Cloud (напрямую)
браузер ──POST /uploads/complete──▶ функция: склеивает части → { publicUrl }
```

Сам файл через функцию не проходит, только 2–3 маленьких JSON-запроса. Поэтому таймауты и лимиты размера ей не страшны, а бесплатного тарифа Supabase хватает с запасом:
- 500 000 вызовов в месяц, а одна работа — это около 3 вызовов;
- 2 с процессорного времени на запрос, а функция тратит миллисекунды.

Ретраи, прогресс и обновление истёкших ссылок делает сайт (`src/utils/uploadUtils.ts` в cse-contests-web).

**Защита:**
- VK-токен проверяется у `id.vk.com` вместе с нашим `client_id`;
- ключ файла имеет вид `сезон/конкурс/vkId/время_имя.расширение` и проверяется целиком, поэтому завершить или отменить загрузку может только её автор;
- разрешены только типы, которые показывает сайт (без html/svg/js — бакет публичный); Content-Type задаёт сервер по расширению, документы и архивы отдаются с `Content-Disposition: attachment`;
- размер не больше `MAX_FILE_SIZE_MB` и соблюдается хранилищем: заявленный размер записан в ключ (`…/время-размер_имя.расш`), а каждая ссылка подписана вместе с точным `Content-Length` своей части — лишний байт VK Cloud отклонит (403). Ссылки выдаются только на части, посчитанные при старте.

## API

База: `https://<project-ref>.supabase.co/functions/v1/uploads`

| Метод | Тело | Ответ |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `POST /start` | `{ fileName, size, contest }` | `{ key, uploadId, partSize, parts: [{ partNumber, url }] }` |
| `POST /sign-parts` | `{ key, uploadId, partNumbers }` | `{ parts }` — новые ссылки взамен истёкших |
| `POST /complete` | `{ key, uploadId, parts: [{ partNumber, etag }] }` | `{ publicUrl }` |
| `POST /abort` | `{ key, uploadId }` | `{ ok }` |
| `POST /session` | `{}` | `{ token, expiresAt }` — JWT для базы Supabase (`role: authenticated`, `vk_user_id`), подписан `DB_JWT_SECRET` |

Все `POST` требуют заголовок `Authorization: Bearer <VK access token>`. `contest` принимает значения `child`, `team` или `individual`.

## Первый запуск

Все команды выполняются в папке проекта. Supabase CLI ставится вместе с `npm install` и запускается через `npx supabase`.

**1. Зависимости и `.env`**
```bash
npm install
cp .env.example .env    # заполнить VK_APP_ID и ключи VK Cloud
```
Ключи VK Cloud: личный кабинет → Объектное хранилище → Аккаунты. Нужен аккаунт с правами на запись в `cse-contests`.

**2. CORS бакета (один раз)**
Без этого браузер не сможет грузить напрямую в бакет.
```bash
npm run setup-bucket
```

**3. Вход в Supabase и секреты функции (один раз)**
```bash
npx supabase login
npx supabase secrets set --env-file .env --project-ref <project-ref>
```
`project-ref` — это часть адреса проекта: `https://<project-ref>.supabase.co`. Секреты можно смотреть и менять в панели: Edge Functions → Secrets.

**4. Деплой**
- вручную: `npx supabase functions deploy uploads --no-verify-jwt --use-api --project-ref <project-ref>`;
- автоматически: при пуше в `main`, если менялась функция. Для этого в Settings → Secrets and variables → Actions нужны секреты:
  - `SUPABASE_ACCESS_TOKEN` — https://supabase.com/dashboard/account/tokens;
  - `SUPABASE_PROJECT_REF`.

Проверка: `curl https://<project-ref>.supabase.co/functions/v1/uploads/health`.

**5. Сайт**
Ничего настраивать не нужно: cse-contests-web по умолчанию обращается к `<VITE_SUPABASE_URL>/functions/v1`.

## Логи и мониторинг

Логи функции: панель Supabase → Edge Functions → uploads → Logs. Своего сервера нет, так что следить за падениями процесса не нужно, этим занимается Supabase.

Бесплатный проект Supabase засыпает после 7 дней без активности. Во время конкурса это не грозит, а между сезонами проект будят в панели.

## Структура

```
supabase/functions/uploads/index.ts   функция целиком
supabase/functions/uploads/deno.json  зависимости функции (aws4fetch — подпись запросов S3)
supabase/config.toml                  verify_jwt = false: вход проверяем через VK, а не Supabase Auth
scripts/setup-bucket.ts               CORS и автоочистка недогруженных файлов в бакете
.github/workflows/deploy.yml          деплой функции
```
