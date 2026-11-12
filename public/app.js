/* ==================================================================
   Dosya Paylaş — istemci mantığı
   - Sürükle-bırak, dosya seçici ve panodan yapıştırma ile otomatik yükleme
   - XHR ile gerçek ilerleme + hız göstergesi, iptal desteği
   - Kısa bağlantıyı kopyalama ve formu sıfırlama
   Aynı dosya indirme sayfasında da yüklenir; orada sadece kopyalama
   düğmesini bağlar (eksik öğeler için tüm kod korumalıdır).
   ================================================================== */
(function () {
  'use strict';

  /* ---------------- Sabitler ---------------- */

  // 100MB = 104.857.600 bayt (sunucudaki sınırla birebir aynı)
  var MAX_FILE_SIZE = 104857600;
  var SIZE_LIMIT_TEXT = 'Dosya boyutu 100MB sınırını aşıyor!';

  /* ---------------- Küçük yardımcılar ---------------- */

  function $(id) {
    return document.getElementById(id);
  }

  /** 1.234.567 → "1,2 MB" gibi okunur boyut metni. */
  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB'];
    var value = bytes / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    // Küçük değerlerde tek ondalık, büyüklerde tam sayı yeterli
    var rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    return String(rounded).replace('.', ',') + ' ' + units[i];
  }

  /** Dosya türüne göre küçük bir simge. */
  function iconFor(file) {
    var type = (file && file.type) || '';
    var name = (file && file.name) || '';
    if (type.indexOf('image/') === 0) return '🖼️';
    if (type.indexOf('video/') === 0) return '🎬';
    if (type.indexOf('audio/') === 0) return '🎵';
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) return '📕';
    if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return '🗜️';
    if (/\.(doc|docx|odt)$/i.test(name)) return '📝';
    if (/\.(xls|xlsx|csv|ods)$/i.test(name)) return '📊';
    if (/\.(ppt|pptx)$/i.test(name)) return '📽️';
    return '📦';
  }

  /* ---------------- Bildirimler (toast) ---------------- */

  var toastStack = $('toastStack');

  /**
   * Ekranın altında kısa süreli bildirim gösterir.
   * @param {string} message
   * @param {'info'|'error'} [kind]
   */
  function toast(message, kind) {
    if (!toastStack) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' toast--error' : '');
    el.setAttribute('role', 'status');
    el.textContent = message;
    toastStack.appendChild(el);

    // 3,6 saniye sonra yumuşakça kaldır
    window.setTimeout(function () {
      el.classList.add('is-leaving');
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 220);
    }, 3600);
  }

  /* ---------------- Panelleri değiştirme ---------------- */

  var panels = {
    dropzone: $('dropzone'),
    upload: $('uploadPanel'),
    success: $('successPanel'),
    error: $('errorPanel'),
  };

  /** Yalnızca istenen paneli görünür yapar (null → hepsi kapalı). */
  function showPanel(name) {
    ['upload', 'success', 'error'].forEach(function (key) {
      var node = panels[key];
      if (!node) return;
      if (key === name) {
        node.hidden = false;
      } else {
        node.hidden = true;
      }
    });
    // Sürükleme alanı yükleme sırasında gizlenir, sonuç/hata sonrası geri gelir
    if (panels.dropzone) {
      panels.dropzone.hidden = name === 'upload' || name === 'success';
      panels.dropzone.classList.remove('is-dragover');
    }
    var pasteHint = document.querySelector('.paste-hint');
    if (pasteHint) pasteHint.hidden = name === 'upload' || name === 'success';
  }

  /* ---------------- Kopyalama ---------------- */

  /**
   * Metni panoya kopyalar. Güvenli bağlam yoksa eski yöntemi dener.
   * @returns {Promise<boolean>}
   */
  function copyText(text, inputEl) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return legacyCopy(text, inputEl);
        }
      );
    }
    return Promise.resolve(legacyCopy(text, inputEl));
  }

  function legacyCopy(text, inputEl) {
    try {
      if (inputEl) {
        inputEl.focus();
        inputEl.select();
      }
      return document.execCommand('copy');
    } catch (e) {
      return false;
    }
  }

  /**
   * Kopyalandı geri bildirimi: düğme metni 2 saniye değişir.
   */
  function flashCopied(button, label) {
    if (!button) return;
    var original = button.getAttribute('data-label') || button.textContent.trim();
    button.setAttribute('data-label', original);
    button.textContent = label || 'Kopyalandı!';
    button.classList.add('is-copied');
    window.clearTimeout(button._copyTimer);
    button._copyTimer = window.setTimeout(function () {
      button.textContent = original;
      button.classList.remove('is-copied');
    }, 2000);
  }

  /* ---------------- Ana sayfa: yükleme akışı ---------------- */

  var els = {
    fileInput: $('fileInput'),
    uploadFileName: $('uploadFileName'),
    uploadFileSize: $('uploadFileSize'),
    uploadFileIcon: $('uploadFileIcon'),
    cancelBtn: $('cancelBtn'),
    progressWrap: $('progressWrap'),
    progressBar: $('progressBar'),
    progressPct: $('progressPct'),
    uploadDetail: $('uploadDetail'),
    successSub: $('successSub'),
    shortUrl: $('shortUrl'),
    copyBtn: $('copyBtn'),
    openLink: $('openLink'),
    resetBtn: $('resetBtn'),
    errorText: $('errorText'),
    errorResetBtn: $('errorResetBtn'),
    pasteKbd: $('pasteKbd'),
  };

  var hasHomePage = !!(panels.dropzone && els.shortUrl);
  var currentXhr = null; // etkin yükleme isteği
  var isBusy = false; // yükleme sürüyor mu?

  /** macOS'ta "⌘" göster. */
  if (els.pasteKbd) {
    var isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
    if (isMac) els.pasteKbd.textContent = '⌘';
  }

  /** İlerleme çubuğunu yüzde değerine göre günceller. */
  function setProgress(percent) {
    var pct = Math.max(0, Math.min(100, Math.round(percent)));
    if (els.progressBar) els.progressBar.style.width = pct + '%';
    if (els.progressPct) els.progressPct.textContent = '%' + pct;
    if (els.progressWrap) {
      els.progressWrap.setAttribute('aria-valuenow', String(pct));
      els.progressWrap.classList.remove('is-indeterminate');
    }
  }

  /** Hız metni: 3,4 MB/s */
  function speedText(bytesPerSecond) {
    if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
    return formatBytes(bytesPerSecond) + '/s';
  }

  /** Hata ekranını gösterir. */
  function fail(message) {
    if (!hasHomePage) {
      toast(message || 'Bir şeyler ters gitti.', 'error');
      return;
    }
    if (els.errorText) els.errorText.textContent = message || 'Bir şeyler ters gitti.';
    showPanel('error');
  }

  /** Formu ilk hâline döndürür. */
  function resetForm() {
    if (currentXhr) {
      try {
        currentXhr.abort();
      } catch (e) {
        /* yoksay */
      }
      currentXhr = null;
    }
    isBusy = false;
    if (els.fileInput) els.fileInput.value = '';
    setProgress(0);
    if (els.uploadDetail) els.uploadDetail.textContent = 'Yükleniyor…';
    if (els.shortUrl) els.shortUrl.value = '';
    showPanel(null);
  }

  /**
   * Yükleme öncesi doğrulama. Geçerliyse true döner.
   * Hata durumunda Türkçe bildirim gösterir.
   */
  function validate(file) {
    if (!file) {
      toast('Lütfen bir dosya seçin.', 'error');
      return false;
    }
    if (file.size === 0) {
      toast('Boş dosyalar yüklenemez.', 'error');
      return false;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast(SIZE_LIMIT_TEXT, 'error');
      return false;
    }
    return true;
  }

  /** Asıl yükleme: XHR ile ilerleme ve hız takibi. */
  function startUpload(file) {
    if (isBusy) {
      toast('Zaten bir yükleme sürüyor. Lütfen bekleyin.', 'error');
      return;
    }
    if (!validate(file)) return;

    isBusy = true;
    showPanel('upload');

    if (els.uploadFileName) els.uploadFileName.textContent = file.name || 'ekran-goruntusu.png';
    if (els.uploadFileSize) els.uploadFileSize.textContent = formatBytes(file.size);
    if (els.uploadFileIcon) els.uploadFileIcon.textContent = iconFor(file);
    if (els.uploadDetail) els.uploadDetail.textContent = 'Yükleniyor…';
    setProgress(0);

    var xhr = new XMLHttpRequest();
    currentXhr = xhr;

    var startedAt = Date.now();
    var lastLoaded = 0;
    var lastTime = startedAt;
    var smoothedSpeed = 0;

    xhr.upload.addEventListener('progress', function (event) {
      if (!event.lengthComputable) return;
      var percent = (event.loaded / event.total) * 100;
      setProgress(percent);

      // Hız: iki ölçüm arasındaki fark, hafifçe yumuşatılmış
      var now = Date.now();
      var dt = (now - lastTime) / 1000;
      if (dt > 0.25) {
        var instant = (event.loaded - lastLoaded) / dt;
        smoothedSpeed = smoothedSpeed ? smoothedSpeed * 0.6 + instant * 0.4 : instant;
        lastLoaded = event.loaded;
        lastTime = now;
      }

      if (els.uploadDetail) {
        var parts = [];
        if (percent < 100) {
          parts.push(formatBytes(event.loaded) + ' / ' + formatBytes(event.total));
          var speed = speedText(smoothedSpeed);
          if (speed) parts.push(speed);
        } else {
          parts.push('İşleniyor…');
        }
        els.uploadDetail.textContent = parts.join(' · ');
      }
    });

    xhr.upload.addEventListener('load', function () {
      setProgress(100);
      if (els.uploadDetail) els.uploadDetail.textContent = 'İşleniyor…';
    });

    xhr.addEventListener('load', function () {
      isBusy = false;
      currentXhr = null;
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = null;
      }

      if (xhr.status === 201 && data && data.shortPath) {
        setProgress(100);
        if (els.successSub) {
          els.successSub.textContent =
            (data.fileName || 'Dosya') + ' · ' + (data.sizeText || formatBytes(file.size));
        }
        var absolute = data.url || window.location.origin + data.shortPath;
        if (els.shortUrl) els.shortUrl.value = absolute;
        if (els.openLink) els.openLink.href = data.shortPath;
        showPanel('success');
        toast('Dosya yüklendi! Bağlantın hazır.');
        window.setTimeout(function () {
          if (els.copyBtn) els.copyBtn.focus();
        }, 60);
        return;
      }

      var message =
        (data && data.error) ||
        (xhr.status === 413
          ? SIZE_LIMIT_TEXT
          : 'Yükleme başarısız oldu. Lütfen tekrar deneyin.');
      fail(message);
    });

    xhr.addEventListener('error', function () {
      isBusy = false;
      currentXhr = null;
      fail('Bağlantı hatası. İnternet bağlantınızı kontrol edip tekrar deneyin.');
    });

    xhr.addEventListener('timeout', function () {
      isBusy = false;
      currentXhr = null;
      fail('Yükleme zaman aşımına uğradı. Lütfen tekrar deneyin.');
    });

    xhr.addEventListener('abort', function () {
      isBusy = false;
      currentXhr = null;
    });

    var form = new FormData();
    form.append('file', file, file.name || 'ekran-goruntusu.png');

    xhr.open('POST', '/api/upload', true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.send(form);
  }

  /* ---------------- Ana sayfa: olaylar ---------------- */

  if (hasHomePage) {
    // Tıklama / klavye ile dosya seçici
    panels.dropzone.addEventListener('click', function () {
      if (isBusy) return;
      if (els.fileInput) els.fileInput.click();
    });
    panels.dropzone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        if (!isBusy && els.fileInput) els.fileInput.click();
      }
    });

    if (els.fileInput) {
      els.fileInput.addEventListener('change', function () {
        var file = els.fileInput.files && els.fileInput.files[0];
        if (file) startUpload(file);
      });
    }

    // Sürükle-bırak: alan üzerinde
    ['dragenter', 'dragover'].forEach(function (type) {
      panels.dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (!isBusy) panels.dropzone.classList.add('is-dragover');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      });
    });

    ['dragleave', 'dragend'].forEach(function (type) {
      panels.dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        // Alt öğeler arasında gezinirken yanıp sönmeyi önle
        if (event.relatedTarget && panels.dropzone.contains(event.relatedTarget)) return;
        panels.dropzone.classList.remove('is-dragover');
      });
    });

    panels.dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      panels.dropzone.classList.remove('is-dragover');
      var dt = event.dataTransfer;
      if (!dt) return;
      var files = dt.files;
      if (files && files.length > 0) {
        if (files.length > 1) toast('Tek seferde yalnızca bir dosya yükleyebilirsiniz.', 'error');
        startUpload(files[0]);
        return;
      }
      // Sürüklenen metin bir URL ise indirmeye çalışmak yerine uyar
      toast('Lütfen bir dosya sürükleyin.', 'error');
    });

    // Tarayıcının dosyayı sayfada açmasını engelle
    ['dragover', 'drop'].forEach(function (type) {
      document.addEventListener(type, function (event) {
        if (panels.dropzone && panels.dropzone.contains(event.target)) return;
        event.preventDefault();
      });
    });

    // Panodan yapıştırma (ekran görüntüsü veya dosya)
    document.addEventListener('paste', function (event) {
      if (isBusy) return;
      // Form alanına yapıştırma yapılıyorsa karışma
      var target = event.target;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (!event.clipboardData) return;

      var files = event.clipboardData.files;
      var file = files && files.length ? files[0] : null;

      if (!file) {
        // Bazı tarayıcılar dosyayı items içinde verir
        var items = event.clipboardData.items || [];
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].kind === 'file') {
            file = items[i].getAsFile();
            break;
          }
        }
      }

      if (!file) {
        toast('Panoda yüklenebilecek bir dosya bulunamadı.', 'error');
        return;
      }
      event.preventDefault();
      startUpload(file);
    });

    // İptal
    if (els.cancelBtn) {
      els.cancelBtn.addEventListener('click', function () {
        if (currentXhr) {
          try {
            currentXhr.abort();
          } catch (e) {
            /* yoksay */
          }
          currentXhr = null;
        }
        isBusy = false;
        resetForm();
        toast('Yükleme iptal edildi.');
      });
    }

    // Kopyala
    if (els.copyBtn) {
      els.copyBtn.addEventListener('click', function () {
        var value = els.shortUrl ? els.shortUrl.value : '';
        if (!value) return;
        copyText(value, els.shortUrl).then(function (ok) {
          if (ok) {
            flashCopied(els.copyBtn, 'Bağlantı Kopyalandı!');
            toast('Bağlantı Kopyalandı!');
          } else {
            if (els.shortUrl) {
              els.shortUrl.focus();
              els.shortUrl.select();
            }
            toast('Kopyalanamadı. Bağlantıyı elle seçebilirsiniz.', 'error');
          }
        });
      });
    }

    if (els.resetBtn) els.resetBtn.addEventListener('click', resetForm);
    if (els.errorResetBtn) els.errorResetBtn.addEventListener('click', resetForm);
  }

  /* ---------------- İndirme sayfası: kopyalama ---------------- */

  // Sunucu tarafından basılan sayfada data-copy-target="shareUrl" düğmesi
  var downloadCopyBtn = document.querySelector('[data-copy-target]');
  if (downloadCopyBtn) {
    var targetId = downloadCopyBtn.getAttribute('data-copy-target');
    var targetInput = document.getElementById(targetId);
    downloadCopyBtn.addEventListener('click', function () {
      if (!targetInput) return;
      var value = targetInput.value || targetInput.textContent;
      copyText(value, targetInput).then(function (ok) {
        if (ok) {
          flashCopied(downloadCopyBtn, 'Kopyalandı!');
          toast('Bağlantı Kopyalandı!');
        } else {
          targetInput.focus();
          targetInput.select();
          toast('Kopyalanamadı. Bağlantıyı elle seçebilirsiniz.', 'error');
        }
      });
    });
  }
})();
