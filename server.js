/**
 * Dosya Paylaş — minimalist dosya paylaşım sunucusu
 * ---------------------------------------------------
 * Node.js + Express + multer
 *
 * - 100MB (104.857.600 bayt) katı yükleme limiti
 * - 5 karakterlik kısa kimlikler (ör. /f/a7x9q)
 * - Dosyalar ./uploads, meta veriler ./data/files.json içinde tutulur
 * - Güvenli başlıklar (nosniff, Content-Disposition: attachment)
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const app = express();

/* ------------------------------------------------------------------ */
/* Sabitler                                                            */
/* ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB = 104.857.600 bayt
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'files.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Karışabilecek karakterler (0/O, 1/I/l) çıkarılmış alfabe
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const ID_LENGTH = 5;

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */
function ensureDirs() {
  for (const dir of [UPLOAD_DIR, DATA_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** Rastgele 5 karakterlik kimlik üretir. */
function generateId() {
  const bytes = crypto.randomBytes(ID_LENGTH);
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) {
    id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return id;
}

/** JSON indeksini okur (bozuk dosyada güvenli şekilde boş nesne döner). */
async function readIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('[index] okunamadı, sıfırlanıyor:', err.message);
    return {};
  }
}

/** İndeksi atomik olarak yazar (tmp dosya + rename). */
async function writeIndex(index) {
  const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
  await fsp.rename(tmp, INDEX_FILE);
}

/** Yüklenen dosya adını güvenli hale getirir (görüntüleme amaçlı saklanır). */
function sanitizeOriginalName(name) {
  const base = path.basename(String(name || 'dosya'));
  // Kontrol karakterleri ve yol ayraçlarını temizle
  return base.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 180) || 'dosya';
}

/** Diske yazarken kullandığımız güvenli uzantı (en fazla 10 karakter). */
function safeExtension(name) {
  const ext = path.extname(path.basename(String(name || ''))).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** 1.5 MB -> "1,5 MB" gibi okunabilir boyut. */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} ${units[i]}`;
}

/** İçerik türünden güvenli önizleme sınıfı belirler. */
function previewKind(mime) {
  const type = String(mime || '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'pdf';
  return 'none';
}

/* ------------------------------------------------------------------ */
/* multer yapılandırması                                               */
/* ------------------------------------------------------------------ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Kimlik, upload akışı başlamadan önce atanır; çakışma ihtimaline karşı
    // benzersiz bir geçici ad kullanılır, kayıt sonrası kimlikle yeniden adlandırılır.
    const temp = `tmp-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    cb(null, temp);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 10,
  },
});

/* ------------------------------------------------------------------ */
/* Güvenlik başlıkları                                                 */
/* ------------------------------------------------------------------ */
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
      "frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

/* ------------------------------------------------------------------ */
/* API: Yükleme                                                        */
/* ------------------------------------------------------------------ */
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    // --- multer hataları (limit aşımı vb.) ---
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `Dosya boyutu 100MB sınırını aşıyor!`,
          code: 'FILE_TOO_LARGE',
        });
      }
      console.error('[upload] multer hatası:', err.message);
      return res.status(400).json({ error: 'Yükleme başarısız oldu. Lütfen tekrar deneyin.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Dosya bulunamadı. Lütfen bir dosya seçin.' });
    }

    // --- ikinci savunma hattı: boyut kontrolü ---
    if (req.file.size > MAX_FILE_SIZE) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(413).json({
        error: 'Dosya boyutu 100MB sınırını aşıyor!',
        code: 'FILE_TOO_LARGE',
      });
    }
    if (req.file.size === 0) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Boş dosyalar yüklenemez.' });
    }

    try {
      const index = await readIndex();

      // Benzersiz kimlik üret
      let id = generateId();
      let attempts = 0;
      while (index[id] && attempts < 50) {
        id = generateId();
        attempts += 1;
      }
      if (index[id]) {
        throw new Error('Kimlik üretilemedi');
      }

      const originalName = sanitizeOriginalName(req.file.originalname);
      const ext = safeExtension(originalName);
      const finalName = `${id}${ext}`;
      const finalPath = path.join(UPLOAD_DIR, finalName);

      await fsp.rename(req.file.path, finalPath);

      index[id] = {
        id,
        originalName,
        storedName: finalName,
        size: req.file.size,
        sizeText: formatBytes(req.file.size),
        mimeType: req.file.mimetype || 'application/octet-stream',
        preview: previewKind(req.file.mimetype),
        createdAt: new Date().toISOString(),
        downloads: 0,
      };
      await writeIndex(index);

      const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const url = `${base.replace(/\/$/, '')}/f/${id}`;

      // Yükleme yanıtı: istemci doğrudan bağlantıyı gösterebilir
      return res.status(201).json({
        id,
        url,
        shortPath: `/f/${id}`,
        fileName: originalName,
        size: req.file.size,
        sizeText: formatBytes(req.file.size),
        mimeType: index[id].mimeType,
        preview: index[id].preview,
        createdAt: index[id].createdAt,
      });
    } catch (e) {
      console.error('[upload] kayıt hatası:', e.message);
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(500).json({ error: 'Sunucu hatası. Lütfen tekrar deneyin.' });
    }
  });
});

/* ------------------------------------------------------------------ */
/* API: Meta veri                                                      */
/* ------------------------------------------------------------------ */
app.get('/api/files/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9]{5}$/.test(id)) {
    return res.status(400).json({ error: 'Geçersiz bağlantı.' });
  }
  const index = await readIndex();
  const file = index[id];
  if (!file) return res.status(404).json({ error: 'Dosya bulunamadı veya kaldırılmış.' });

  return res.json({
    id: file.id,
    fileName: file.originalName,
    size: file.size,
    sizeText: file.sizeText,
    mimeType: file.mimeType,
    preview: file.preview,
    createdAt: file.createdAt,
  });
});

/* ------------------------------------------------------------------ */
/* Dosya sunumu                                                        */
/* ------------------------------------------------------------------ */
function setFileSecurityHeaders(res, { inline }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (inline) {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  } else {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(res.locals.fileName || 'dosya')}`
    );
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
}

/** /d/:id — her zaman indirir (indirme sayfasındaki ana buton). */
app.get('/d/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9]{5}$/.test(id)) return res.status(404).send('Dosya bulunamadı.');
  const index = await readIndex();
  const file = index[id];
  if (!file) return res.status(404).send('Dosya bulunamadı.');
  const filePath = path.join(UPLOAD_DIR, path.basename(file.storedName));

  // İndirme sayısını arttır (kritik değil, hata yutulur)
  index[id].downloads = (index[id].downloads || 0) + 1;
  writeIndex(index).catch(() => {});

  res.locals.fileName = file.originalName;
  setFileSecurityHeaders(res, { inline: false });
  res.type('application/octet-stream');
  res.download(filePath, file.originalName, (err) => {
    if (err && !res.headersSent) {
      res.status(404).send('Dosya bulunamadı.');
    }
  });
});

/** /p/:id — sadece resim/medya/pdf önizlemesi için satır içi sunum. */
app.get('/p/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9]{5}$/.test(id)) return res.status(404).send('Dosya bulunamadı.');
  const index = await readIndex();
  const file = index[id];
  if (!file) return res.status(404).send('Dosya bulunamadı.');

  // Satır içi sunum yalnızca güvenli önizleme türlerinde
  if (file.preview === 'none') return res.redirect(`/d/${id}`);

  const filePath = path.join(UPLOAD_DIR, path.basename(file.storedName));
  setFileSecurityHeaders(res, { inline: true });
  res.type(file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  return res.sendFile(filePath);
});

/* ------------------------------------------------------------------ */
/* Sayfalar                                                            */
/* ------------------------------------------------------------------ */

// Ana sayfa
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// İndirme sayfası (sunucu tarafında render edilir, JS gerekmez)
app.get('/f/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9]{5}$/.test(id)) {
    return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  }
  const index = await readIndex();
  const file = index[id];
  if (!file) return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));

  const html = renderDownloadPage(req, file);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(html);
});

/* ------------------------------------------------------------------ */
/* İndirme sayfası şablonu                                             */
/* ------------------------------------------------------------------ */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDownloadPage(req, file) {
  const id = escapeHtml(file.id);
  const name = escapeHtml(file.originalName);
  const nameAttr = escapeHtml(file.originalName);
  const sizeText = escapeHtml(file.sizeText);
  const mimeType = escapeHtml(file.mimeType);
  const createdAt = new Date(file.createdAt).toLocaleString('tr-TR', {
    dateStyle: 'long',
    timeStyle: 'short',
  });

  let previewHtml = '';
  const inlineUrl = `/p/${id}`;
  if (file.preview === 'image') {
    previewHtml = `<figure class="preview preview-image">
        <img src="${inlineUrl}" alt="${nameAttr} önizlemesi" loading="lazy" />
      </figure>`;
  } else if (file.preview === 'video') {
    previewHtml = `<figure class="preview preview-video">
        <video src="${inlineUrl}" controls preload="metadata"></video>
      </figure>`;
  } else if (file.preview === 'audio') {
    previewHtml = `<figure class="preview preview-audio">
        <audio src="${inlineUrl}" controls preload="metadata"></audio>
      </figure>`;
  } else if (file.preview === 'pdf') {
    previewHtml = `<figure class="preview preview-pdf">
        <iframe src="${inlineUrl}" title="${nameAttr} önizlemesi" loading="lazy"></iframe>
      </figure>`;
  }

  const fileIcon = {
    image: '🖼️',
    video: '🎬',
    audio: '🎵',
    pdf: '📄',
    none: '📦',
  }[file.preview] || '📦';

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${name} — Dosya Paylaş</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="#0f172a" />
  <link rel="stylesheet" href="/style.css" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
</head>
<body class="page-download">
  <div class="shell">
    <header class="brand brand--compact">
      <a class="brand__link" href="/">
        <span class="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/></svg>
        </span>
        <span class="brand__name">Dosya Paylaş</span>
      </a>
    </header>

    <main class="card download-card">
      <div class="download-head">
        <div class="file-badge" aria-hidden="true">${fileIcon}</div>
        <h1 class="download-title" title="${nameAttr}">${name}</h1>
        <p class="download-sub">Bağlantıya sahip herkes bu dosyayı indirebilir.</p>
      </div>

      ${previewHtml}

      <dl class="meta-grid">
        <div class="meta-item">
          <dt>Boyut</dt>
          <dd>${sizeText}</dd>
        </div>
        <div class="meta-item">
          <dt>Tür</dt>
          <dd>${mimeType}</dd>
        </div>
        <div class="meta-item">
          <dt>Yüklenme</dt>
          <dd>${escapeHtml(createdAt)}</dd>
        </div>
        <div class="meta-item">
          <dt>Kısa kod</dt>
          <dd class="mono">${id}</dd>
        </div>
      </dl>

      <a class="btn btn--primary btn--block btn--download" href="/d/${id}" download>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/></svg>
        Dosyayı İndir
      </a>

      <div class="copy-row">
        <input class="input copy-input" id="shareUrl" type="text" readonly
               value="${escapeHtml(`${req.protocol}://${req.get('host')}/f/${id}`)}"
               aria-label="Paylaşım bağlantısı" />
        <button class="btn btn--ghost" id="copyBtn" type="button" data-copy-target="shareUrl">
          Linki Kopyala
        </button>
      </div>

      <p class="download-foot">
        <a class="link" href="/">Yeni bir dosya yükle</a>
      </p>
    </main>

    <footer class="foot">
      <p>Dosya Paylaş — hızlı, ücretsiz ve kayıt gerektirmez. Maksimum 100MB.</p>
    </footer>
  </div>
  <script src="/app.js" defer></script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* 404 & hata yönetimi                                                 */
/* ------------------------------------------------------------------ */
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.use((err, req, res, next) => {
  console.error('[server] beklenmeyen hata:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Sunucu hatası. Lütfen tekrar deneyin.' });
});

/* ------------------------------------------------------------------ */
/* Başlat                                                              */
/* ------------------------------------------------------------------ */
ensureDirs();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dosya Paylaş çalışıyor: http://localhost:${PORT}`);
  console.log(`Yükleme limiti: ${formatBytes(MAX_FILE_SIZE)} | Klasör: ${UPLOAD_DIR}`);
});

module.exports = app;
