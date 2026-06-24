# Деплой на cloudlegit.work.gd

`work.gd` — это FreeDNS (afraid.org). Домен сам по себе ничего не хостит — он
должен **указывать на IP сервера**, где крутится Node-приложение. Логика всегда:

```
браузер → cloudlegit.work.gd (DNS) → IP сервера → (nginx/Caddy :80/443) → node :3000
```

Ниже рабочие пути. **Твой выбор — Render (вариант C ниже).**

---

## Вариант C — Render (бесплатно) + Neon Postgres + work.gd

> Важно: на бесплатном Render файловая система **эфемерная** — папка `data/`
> стирается при каждом деплое. Поэтому аккаунты храним в **бесплатном Postgres
> (Neon)**. Код уже это умеет: задаёшь `DATABASE_URL` — и он сам пишет в Postgres
> (и пользователей, и сессии). Без `DATABASE_URL` — пишет в файлы (локалка).

### 1. Бесплатная база Neon (1 раз, ~2 минуты)
1. Зайди на **neon.tech** → Sign up (через GitHub).
2. Create Project → регион поближе (EU).
3. На дашборде скопируй **Connection string** вида
   `postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
   Это и есть `DATABASE_URL`.

### 2. Залить код на GitHub
```bash
cd cloud-site
git init && git add . && git commit -m "Cloud site"
# создай пустой репозиторий на github и:
git remote add origin https://github.com/ТВОЙ_ЛОГИН/cloud-site.git
git push -u origin main
```
(`node_modules`, `data` и `.env` уже в `.gitignore`.)

### 3. Создать Web Service на Render
1. **render.com** → New → **Web Service** → подключи репозиторий `cloud-site`.
2. Render сам увидит `render.yaml`. Если просит вручную:
   - Build Command: `npm install`
   - Start Command: `npm start`
3. В разделе **Environment** добавь переменные:
   - `NODE_ENV` = `production`
   - `SITE_URL` = `https://cloudlegit.work.gd`
   - `SESSION_SECRET` = длинная случайная строка
   - `DATABASE_URL` = строка из Neon (шаг 1)
4. Create → дождись деплоя. Получишь URL вида `cloud-site.onrender.com` — проверь, что открывается.

### 4. Привязать домен cloudlegit.work.gd
1. На Render: твой сервис → **Settings → Custom Domains → Add** → `cloudlegit.work.gd`.
   Render покажет цель для CNAME (обычно `cloud-site.onrender.com`).
2. На **afraid.org (FreeDNS)** в записи `cloudlegit.work.gd`:
   - тип **CNAME**, значение — цель от Render (`cloud-site.onrender.com`).
3. Вернись в Render и нажми **Verify**. Render сам выпустит **HTTPS** (Let's Encrypt).
   Через несколько минут → https://cloudlegit.work.gd 🎉

> Нюанс free-тарифа Render: сервис «засыпает» после ~15 мин без трафика,
> первый заход после сна грузится ~30–50 сек. Аккаунты при этом НЕ теряются
> (они в Neon). Если нужен always-on — это платный план или Railway.

---

## Вариант A — VPS (рекомендую): Ubuntu/Debian

Подойдёт любой дешёвый VPS (Hetzner, Aeza, любой с публичным IP).

### 1. Поставить Node + pm2
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2
```

### 2. Залить проект и запустить
```bash
# скопируй папку cloud-site на сервер (scp / git)
cd cloud-site
npm install --omit=dev
# впиши свой SESSION_SECRET в ecosystem.config.js, потом:
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # выполни команду, которую он напечатает (автозапуск после ребута)
```
Приложение слушает `:3000`.

### 3. DNS: указать домен на IP сервера
На afraid.org (FreeDNS) в записях `cloudlegit.work.gd`:
- тип **A**, значение — **публичный IP твоего VPS**.
Подожди 5–30 мин, проверь: `ping cloudlegit.work.gd` должен отдавать твой IP.

### 4. Поставить впереди nginx (порт 80 → 3000)
```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/cloud
```
Содержимое:
```nginx
server {
    listen 80;
    server_name cloudlegit.work.gd;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/cloud /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
Готово → http://cloudlegit.work.gd

### 5. (опционально) HTTPS бесплатно
Самый простой путь — **Caddy** вместо nginx (сам берёт сертификат Let's Encrypt):
```bash
# /etc/caddy/Caddyfile
cloudlegit.work.gd {
    reverse_proxy 127.0.0.1:3000
}
```
После HTTPS поменяй `SITE_URL` на `https://cloudlegit.work.gd` в `ecosystem.config.js`
и `pm2 restart cloud-site` — тогда включатся secure-cookie.

---

## Вариант B — со своего ПК (без VPS)

1. Запусти `pm2 start ecosystem.config.js` (или `npm start`) на ПК — слушает `:3000`.
2. На роутере сделай **проброс портов**: внешний 80 → твой локальный IP:3000.
3. Узнай свой **публичный IP** (2ip.ru), пропиши его A-записью в FreeDNS.
4. Открой → http://cloudlegit.work.gd

Минусы: ПК должен быть включён, белый IP у провайдера, и это палит твой домашний IP.
Для реального проекта лучше Вариант A.

---

## Чек-лист перед публикацией
- [ ] Сменил `SESSION_SECRET` на длинную случайную строку.
- [ ] A-запись `cloudlegit.work.gd` указывает на IP сервера.
- [ ] `pm2 save` + `pm2 startup` (переживёт ребут).
- [ ] (если HTTPS) `SITE_URL=https://...` и перезапуск.
- [ ] Папка `data/` в бэкапе — там пользователи и заказы.
