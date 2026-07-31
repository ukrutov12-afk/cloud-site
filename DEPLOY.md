# Деплой Zephyr на Render без потери пользователей

Используйте существующий Web Service. Пользователи находятся не в архиве, а в PostgreSQL/Neon по адресу из `DATABASE_URL`.

## Перед деплоем

- сохраните текущие названия переменных окружения;
- убедитесь, что `DATABASE_URL` указывает на прежнюю базу;
- укажите администраторов в `ADMIN_EMAILS` через запятую;
- не добавляйте `.env` в Git.

## Настройки сервиса

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /healthz
```

После первого деплоя проверьте регистрацию, вход старого пользователя, `/account` и `/admin`. Таблицы обновляются только через `CREATE TABLE IF NOT EXISTS` и `ADD COLUMN IF NOT EXISTS`; существующие строки не удаляются.
