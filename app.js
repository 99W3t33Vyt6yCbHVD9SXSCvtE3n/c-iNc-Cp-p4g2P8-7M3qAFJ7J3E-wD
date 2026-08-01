/* =========================================================================
   ÁLBUM DE CUMPLEAÑOS — app.js
   Motor de reproducción (Parte 3). Lee window.ALBUM_DATA (definido en
   data.js — ver CONTRATO.md punto 5, nunca usa fetch()).

   Construye una única secuencia lineal de "pasos" (cartela de capítulo,
   fotos, mensajes, carta, final) y navega hacia delante/atrás sobre ella.
   Así, avanzar y retroceder es siempre lo mismo: mover un índice.

   Todavía NO incluido aquí (partes futuras):
   - Reproducción de música con fade in/out (Parte 4).
   - tools/build.py generando data.js/manifest.json reales a partir de
     las fotos que copies (Parte 7).
   ========================================================================= */

(function () {
  "use strict";

  var DATA = window.ALBUM_DATA || { config: {}, manifest: { chapters: [] } };
  var config = DATA.config || {};
  var manifest = DATA.manifest || { chapters: [] };

  // ================================================================
  // MOTOR DE TRANSICIONES
  // La transición se elige aleatoriamente EN CADA CAMBIO AUTOMÁTICO.
  // Los cambios forzados por el usuario son siempre instantáneos.
  // ================================================================
  var TRANSITIONS = [
    { cls: "t-fade",       duration: 1200 },
    { cls: "t-zoom-in",    duration: 1500 },
    { cls: "t-zoom-out",   duration: 1500 },
    { cls: "t-zoom-soft",  duration: 2000 },
    { cls: "t-pan-left",   duration: 1500 },
    { cls: "t-pan-right",  duration: 1500 },
    { cls: "t-pan-up",     duration: 1500 },
    { cls: "t-pan-down",   duration: 1500 },
    { cls: "t-slide-left", duration: 1100 },
    { cls: "t-slide-right",duration: 1100 },
    { cls: "t-slide-up",   duration: 1100 },
    { cls: "t-slide-down", duration: 1100 },
    { cls: "t-blur",       duration: 1500 },
    { cls: "t-scale-fade", duration: 1400 },
    { cls: "t-kenburns",   duration: 2400 }
  ];

  function getRandomTransition() {
    return TRANSITIONS[Math.floor(Math.random() * TRANSITIONS.length)];
  }

  var ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

  var photoDurationMs =
    ((config.displaySettings && config.displaySettings.photoDurationSeconds) || 6) * 1000;
  var lastPhotoDurationMs =
    ((config.displaySettings && config.displaySettings.lastPhotoDurationSeconds) ||
      (photoDurationMs / 1000) * 2) * 1000;

  // -- Construcción de la secuencia lineal de pasos ---------------------
  var steps = [];
  var totalPhotos = 0;
  manifest.chapters.forEach(function (ch) {
    totalPhotos += (ch.photos || []).length;
  });

  var runningPhoto = 0;
  manifest.chapters.forEach(function (chManifest, chIdx) {
    var chConfig = (config.chapters || []).filter(function (c) {
      return c.id === chManifest.id;
    })[0] || {};

    steps.push({
      type: "chapter-title",
      chapterIndex: chIdx,
      numeral: ROMAN[chIdx] || String(chIdx + 1),
      title: chConfig.title || ""
    });

    var messages = (chConfig.messages || []).slice().sort(function (a, b) {
      return a.after - b.after;
    });
    var letter = chConfig.letter;
    var msgPointer = 0;
    var letterInserted = false;

    (chManifest.photos || []).forEach(function (photoPath, i) {
      var photoNumInChapter = i + 1;
      runningPhoto += 1;

      steps.push({
        type: "photo",
        chapterIndex: chIdx,
        src: photoPath,
        chapterPhotoNum: photoNumInChapter,
        globalPhotoNum: runningPhoto,
      });

      while (msgPointer < messages.length && messages[msgPointer].after === photoNumInChapter) {
        steps.push({ type: "message", chapterIndex: chIdx, text: messages[msgPointer].text });
        msgPointer++;
      }
      if (letter && !letterInserted && letter.afterPhoto === photoNumInChapter) {
        steps.push({
          type: "letter",
          chapterIndex: chIdx,
          image: letter.image,
          zoomImage: letter.zoomImage,
          continueText: letter.continueText || "Continuar"
        });
        letterInserted = true;
      }
    });

    // Mensajes cuyo "after" apunta más allá de la última foto del capítulo:
    // se muestran igualmente, al final del capítulo, en vez de perderse.
    while (msgPointer < messages.length) {
      steps.push({ type: "message", chapterIndex: chIdx, text: messages[msgPointer].text });
      msgPointer++;
    }
  });
  // Marca la última foto de TODO el álbum (la anterior a la pantalla
  // final), para poder darle una duración distinta (más larga).
  for (var si = steps.length - 1; si >= 0; si--) {
    if (steps[si].type === "photo") {
      steps[si].isLastPhoto = true;
      break;
    }
  }

  steps.push({ type: "final" });

  // -- Precarga de fotos ---------------------------------------------------
  // Se precarga TODO el capítulo al entrar en él. Así no dependemos de la
  // latencia de red durante la reproducción. Como refuerzo, también se
  // precargan las primeras fotos del álbum antes de pedir la contraseña.
  var preloadedSrcs = {};
  function preloadImage(src) {
    if (!src || preloadedSrcs[src]) return;
    preloadedSrcs[src] = true;
    var img = new Image();
    img.decoding = "async";
    img.src = src;
  }
  function preloadChapter(chapterIndex) {
    var ch = manifest.chapters[chapterIndex];
    if (!ch) return;
    (ch.photos || []).forEach(preloadImage);
  }
  function preloadUpcoming(fromIndex, count) {
    var found = 0;
    for (var i = fromIndex; i < steps.length && found < count; i++) {
      if (steps[i].type === "photo") {
        preloadImage(steps[i].src);
        found++;
      }
    }
  }
  preloadChapter(0);

  // -- Estado -------------------------------------------------------------
  var stepIndex = -1;
  var timerHandle = null;
  var letterZoomed = false;
  var wrongAttempt = 0;

  var screens = {};
  document.querySelectorAll(".screen").forEach(function (el) {
    screens[el.dataset.screen] = el;
  });

  // Listener de entrada registrado al principio de la inicialización.
  // La pantalla de entrada debe seguir siendo funcional aunque una mejora
  // opcional (audio, Wake Lock, etc.) falle en un navegador concreto.
  var entryButton = document.querySelector('[data-action="unlock-audio-and-continue"]');
  if (entryButton) {
    entryButton.addEventListener("click", function () {
      requestFullscreenSafe();
      unlockAllAudio();
      requestWakeLock();
      activateScreen("password");
      if (pauseBtn) pauseBtn.hidden = false;
      setTimeout(function () {
        if (passwordInput) passwordInput.focus();
      }, 50);
    });
  }

  var bgLayers = [
    screens.photo.querySelector('[data-role="photo-bg-0"]'),
    screens.photo.querySelector('[data-role="photo-bg-1"]')
  ];
  var bgTopIndex = 0;

  var frameLayers = [
    screens.photo.querySelector('[data-role="photo-frame-0"]'),
    screens.photo.querySelector('[data-role="photo-frame-1"]')
  ];
  var frameTopIndex = 0;

  // Token de navegación: invalida cualquier cambio de fondo pendiente
  // cuando el usuario fuerza siguiente/anterior.
  var navigationToken = 0;
  var backgroundTimer = null;
  var lastPhotoSrc = null;

  function invalidatePendingTransition() {
    navigationToken += 1;
    if (backgroundTimer) {
      clearTimeout(backgroundTimer);
      backgroundTimer = null;
    }
  }

  function clearLayerTransition(layer) {
    if (!layer) return;
    layer.className = layer.className
      .replace(/\bt-[^\s]+\b/g, "")
      .trim();
    layer.style.animation = "none";
    layer.style.transition = "none";
  }

  function restoreLayerTransition(layer) {
    if (!layer) return;
    layer.style.animation = "";
    layer.style.transition = "";
  }

  function clearTimer() {
    if (timerHandle) {
      clearTimeout(timerHandle);
      timerHandle = null;
    }
  }

  function activateScreen(name) {
    Object.keys(screens).forEach(function (key) {
      screens[key].classList.remove("is-active");
    });
    if (screens[name]) screens[name].classList.add("is-active");
  }

  function renderStep(instant) {
    clearTimer();
    var step = steps[stepIndex];
    if (!step) return;

    if (instant && step.type !== "photo") {
      invalidatePendingTransition();
    }

    if (step.type === "chapter-title") {
      screens["chapter-title"].querySelector('[data-role="chapter-numeral"]').textContent = step.numeral;
      screens["chapter-title"].querySelector('[data-role="chapter-title"]').textContent = step.title;
      activateScreen("chapter-title");
      playChapterTrack(step.chapterIndex);
      preloadChapter(step.chapterIndex);
      preloadUpcoming(stepIndex + 1, 2);
      scheduleAdvance(2600);
    } else if (step.type === "photo") {
      var standbyFrame = frameLayers[1 - frameTopIndex];
      var currentFrame = frameLayers[frameTopIndex];
      var standbyBg = bgLayers[1 - bgTopIndex];
      var currentBg = bgLayers[bgTopIndex];
      var token = navigationToken;
      var transition = instant ? null : getRandomTransition();
      var isFirstPhoto = lastPhotoSrc === null;

      // En un cambio forzado se cancela TODO lo pendiente antes de tocar
      // las capas. No queda ninguna animación ni cambio de fondo antiguo
      // capaz de ejecutarse después.
      if (instant) {
        invalidatePendingTransition();
        token = navigationToken;
      }

      clearLayerTransition(standbyFrame);
      clearLayerTransition(currentFrame);
      clearLayerTransition(standbyBg);
      clearLayerTransition(currentBg);

      var standbyImg = standbyFrame.querySelector("img");
      standbyImg.src = step.src;
      standbyImg.alt = "";
      standbyFrame.className = "photo-frame";
      currentFrame.className = "photo-frame";

      var bgSrc = step.src;
      standbyBg.style.backgroundImage = 'url("' + bgSrc + '")';
      standbyBg.className = "photo-bg";
      currentBg.className = "photo-bg";

      // Cambio instantáneo: ambas capas quedan directamente en su estado
      // final. No hay fade, zoom, pan ni espera del fondo.
      if (instant) {
        standbyFrame.classList.add("is-top");
        standbyBg.classList.add("is-top");
        currentFrame.classList.remove("is-top");
        currentBg.classList.remove("is-top");
      } else {
        // La foto principal entra primero. El fondo conserva la foto
        // anterior durante un retraso y después hace su propio crossfade.
        void standbyFrame.offsetWidth;
        standbyFrame.classList.add("is-top", transition.cls);
        currentFrame.classList.remove("is-top");

        // En la primera foto no existe un fondo anterior útil: lo mostramos
        // inmediatamente para evitar arrancar con un fondo negro. A partir
        // de la segunda foto se respeta el retraso respecto a la principal.
        if (isFirstPhoto) {
          standbyBg.classList.add("is-top");
          currentBg.classList.remove("is-top");
        } else {
          // Mantener el fondo actual visible durante la entrada de la foto.
          currentBg.classList.add("is-top");
          standbyBg.classList.remove("is-top");

          var scheduledToken = token;
          backgroundTimer = setTimeout(function () {
            backgroundTimer = null;
            if (scheduledToken !== navigationToken) return;

            var oldBg = bgLayers[bgTopIndex];
            var newBg = bgLayers[1 - bgTopIndex];

            newBg.className = "photo-bg";
            newBg.style.backgroundImage = 'url("' + bgSrc + '")';
            void newBg.offsetWidth;
            newBg.classList.add("is-top", "bg-crossfade");
            oldBg.classList.remove("is-top");
            bgTopIndex = 1 - bgTopIndex;

            setTimeout(function () {
              newBg.classList.remove("bg-crossfade");
            }, 850);
          }, transition.duration + 350);
        }
      }

      frameTopIndex = 1 - frameTopIndex;
      if (isFirstPhoto) {
        bgTopIndex = 1 - bgTopIndex;
      }
      lastPhotoSrc = step.src;

      screens.photo.querySelector('[data-role="counter-photo"]').textContent =
        step.globalPhotoNum + " / " + totalPhotos;
      activateScreen("photo");
      preloadChapter(step.chapterIndex);
      preloadUpcoming(stepIndex + 1, 2);
      scheduleAdvance(step.isLastPhoto ? lastPhotoDurationMs : photoDurationMs);

      // Tras un cambio forzado, restauramos las propiedades CSS después de
      // pintar el estado final para que la siguiente reproducción automática
      // pueda volver a animarse normalmente.
      if (instant) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            restoreLayerTransition(currentFrame);
            restoreLayerTransition(standbyFrame);
            restoreLayerTransition(currentBg);
            restoreLayerTransition(standbyBg);
          });
        });
      }
    } else if (step.type === "message") {
      screens.message.querySelector('[data-role="message-text"]').textContent = step.text;
      activateScreen("message");
      preloadUpcoming(stepIndex + 1, 2);
    } else if (step.type === "letter") {
      letterZoomed = false;
      var lFrame = screens.letter.querySelector('[data-role="letter-frame"]');
      var lImg = screens.letter.querySelector('[data-role="letter-img"]');
      var lHint = screens.letter.querySelector('[data-role="letter-hint"]');
      var lBtn = screens.letter.querySelector('[data-role="letter-continue"]');
      lImg.src = step.image;
      lFrame.dataset.state = "full";
      lHint.hidden = false;
      lBtn.hidden = true;
      activateScreen("letter");
      preloadUpcoming(stepIndex + 1, 2);
    } else if (step.type === "final") {
      activateScreen("final");
    }
  }

  function goNext(instant) {
    clearTimer();
    if (stepIndex < steps.length - 1) {
      stepIndex++;
      renderStep(!!instant);
    }
  }

  function goBack(instant) {
    clearTimer();
    if (stepIndex > 0) {
      stepIndex--;
      renderStep(!!instant);
    }
  }

  function start() {
    clearTimer();
    invalidatePendingTransition();
    stepIndex = 0;
    lastPhotoSrc = null;
    frameTopIndex = 0;
    bgTopIndex = 0;
    renderStep();
  }

  // -- Textos editables desde config.json (entrada y pantalla final) -------
  // index.html trae texto de ejemplo por defecto; aquí se sustituye por el
  // contenido real de config.json en cuanto carga la página, para que
  // editar config.json sea suficiente y nunca haga falta tocar el HTML.
  function applyStaticText() {
    var entry = config.entry || {};
    var entryLines = document.querySelectorAll(".screen-entry .entry-line");
    if (entryLines[0] && entry.line1) entryLines[0].textContent = entry.line1;
    if (entryLines[1] && entry.line2) entryLines[1].textContent = entry.line2;
    var entryBtn = document.querySelector('[data-action="unlock-audio-and-continue"]');
    if (entryBtn && entry.buttonText) entryBtn.textContent = entry.buttonText;

    var final = config.final || {};
    var setText = function (role, value) {
      var el = document.querySelector('.screen-final [data-role="' + role + '"]');
      if (el && value) el.textContent = value;
    };
    setText("final-greeting", final.greeting);
    setText("final-emotional", final.emotionalText);
    setText("final-phrase", final.memorablePhrase);
    var hintEl = document.querySelector('.screen-final-hint [data-role="final-hint"]');
    if (hintEl && final.giftHint) hintEl.textContent = final.giftHint;
    var adventureBtn = document.querySelector('[data-role="adventure-button"]');
    if (adventureBtn && final.adventureButtonText) adventureBtn.textContent = final.adventureButtonText;
    var replayBtn = document.querySelector('[data-action="replay"]');
    if (replayBtn && final.replayButtonText) replayBtn.textContent = final.replayButtonText;
    var downloadBtn = document.querySelector('[data-action="download"]');
    if (downloadBtn && final.downloadButtonText) downloadBtn.textContent = final.downloadButtonText;
  }
  applyStaticText();

  // -- Música -----------------------------------------------------------
  // UN <audio> POR CAPÍTULO (creado aquí, no en el HTML), precargado con
  // su pista desde el principio y NUNCA se le reasigna el src después.
  //
  // Por qué: la versión anterior usaba un único <audio> compartido y le
  // cambiaba el src en cada capítulo. Eso es lo que probablemente causaba
  // que "la música solo se reproduzca alguna vez": algunos navegadores
  // móviles (sobre todo Safari/iOS) solo consideran "desbloqueado" un
  // elemento de audio para el MISMO recurso con el que se desbloqueó; al
  // cambiarle el src más tarde, pueden volver a exigir un gesto del
  // usuario, y como el cambio de capítulo lo dispara un temporizador (no
  // un toque), la reproducción fallaba en silencio de forma intermitente.
  //
  // Con un elemento fijo por capítulo, desbloqueados TODOS a la vez en el
  // gesto de ENTRAR, cada uno mantiene su propio estado "permitido" para
  // el resto de la sesión. Como beneficio adicional, ahora el cruce entre
  // capítulos es un crossfade real (dos pistas sonando a la vez mientras
  // se cruzan), no un fundido a negro seguido de un fundido de entrada.
  var chapterAudios = (config.chapters || []).map(function (ch) {
    var el = document.createElement("audio");
    el.preload = "auto";
    el.loop = false; // Regla fija de la spec (punto 14): nunca hace loop.
    if (ch.track) el.src = ch.track;
    el.style.display = "none";
    document.body.appendChild(el);
    return el;
  });

  var fadeOutMs = ((config.musicSettings && config.musicSettings.fadeOutSeconds) || 2) * 1000;
  var fadeInMs = ((config.musicSettings && config.musicSettings.fadeInSeconds) || 2) * 1000;
  var activeAudioIndex = -1;

  function fadeElementVolume(el, target, durationMs, done) {
    el._fadeToken = (el._fadeToken || 0) + 1;
    var myToken = el._fadeToken;
    var start = el.volume;
    var startTime = performance.now();
    if (durationMs <= 0) {
      el.volume = target;
      if (done) done();
      return;
    }
    function step(now) {
      if (myToken !== el._fadeToken) return; // otro fade en este mismo elemento lo canceló
      var elapsed = now - startTime;
      var t = Math.min(1, elapsed / durationMs);
      var value = start + (target - start) * t;
      // Corrige el desbordamiento por coma flotante (p. ej. 1.00015 o
      // -0.0004): asignar un volumen fuera de [0,1] lanza una excepción
      // que detenía el fundido a mitad de camino — la causa más probable
      // de que la música sonara de forma intermitente.
      el.volume = Math.max(0, Math.min(1, value));
      if (t < 1) {
        requestAnimationFrame(step);
      } else if (done) {
        done();
      }
    }
    requestAnimationFrame(step);
  }

  function playChapterTrack(chapterIndex) {
    if (chapterIndex === activeAudioIndex) return;
    var incoming = chapterAudios[chapterIndex];
    var outgoing = activeAudioIndex >= 0 ? chapterAudios[activeAudioIndex] : null;
    activeAudioIndex = chapterIndex;

    if (outgoing && !outgoing.paused) {
      fadeElementVolume(outgoing, 0, fadeOutMs, function () {
        outgoing.pause();
      });
    }
    if (incoming && incoming.src) {
      incoming.currentTime = 0;
      incoming.volume = 0;
      var p = incoming.play();
      if (p && p.catch) {
        // Falta el mp3, o el navegador bloquea la reproducción: no rompemos
        // la navegación del álbum por un fallo de audio.
        p.catch(function () {});
      }
      fadeElementVolume(incoming, 1, fadeInMs, null);
    }
  }

  function pauseActiveAudio() {
    if (activeAudioIndex >= 0) chapterAudios[activeAudioIndex].pause();
  }
  function resumeActiveAudio() {
    if (activeAudioIndex >= 0) {
      var p = chapterAudios[activeAudioIndex].play();
      if (p && p.catch) p.catch(function () {});
    }
  }

  function unlockAllAudio() {
    chapterAudios.forEach(function (el) {
      if (!el.src) return;
      el.muted = true;
      var p = el.play();
      if (p && p.then) {
        p.then(function () {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        }).catch(function () {
          el.muted = false;
        });
      } else {
        el.muted = false;
      }
    });
  }

  // -- Pausa/continuar (botón discreto) — pausa fotos y música a la vez ---
  var isPaused = false;
  var timerDurationMs = 0;
  var timerStartedAt = 0;
  var pendingRemainingMs = null;
  var pauseBtn = document.getElementById("pause-toggle");

  function scheduleAdvance(ms) {
    clearTimer();
    timerDurationMs = ms;
    timerStartedAt = performance.now();
    timerHandle = setTimeout(goNext, ms);
  }

  function updatePauseButton() {
    pauseBtn.textContent = isPaused ? "▶" : "❚❚";
    pauseBtn.setAttribute("aria-label", isPaused ? "Continuar" : "Pausar");
  }

  function togglePause() {
    if (isPaused) {
      isPaused = false;
      if (pendingRemainingMs != null) {
        scheduleAdvance(pendingRemainingMs);
        pendingRemainingMs = null;
      }
      resumeActiveAudio();
    } else {
      isPaused = true;
      if (timerHandle) {
        var elapsed = performance.now() - timerStartedAt;
        pendingRemainingMs = Math.max(0, timerDurationMs - elapsed);
        clearTimer();
      }
      pauseActiveAudio();
    }
    updatePauseButton();
  }
  pauseBtn.addEventListener("click", togglePause);

  // -- Entrada: pantalla completa, desbloqueo de audio, foco en contraseña -
  // Los tres deben ir dentro de este mismo gesto de clic — los navegadores
  // exigen que pantalla completa y reproducción de audio partan de una
  // interacción directa del usuario, no de código posterior.
  function requestFullscreenSafe() {
    var el = document.documentElement;
    var req =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.mozRequestFullScreen ||
      el.msRequestFullscreen;
    if (!req) return; // p. ej. iOS Safari fuera de modo "añadir a inicio": no soportado, se ignora sin romper nada
    try {
      var result = req.call(el);
      if (result && result.catch) result.catch(function () {});
    } catch (e) {
      /* ignorar: pantalla completa es una mejora, no un requisito */
    }
  }

  // -- Mantener la pantalla encendida (Wake Lock API) ----------------------
  // Soportado en Chrome/Edge/Android desde hace tiempo, y en Safari/iOS
  // desde la versión 16.4. Donde no exista, simplemente no hace nada — no
  // rompe el álbum, solo no evita que la pantalla se apague.
  var wakeLock = null;
  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock
      .request("screen")
      .then(function (lock) {
        wakeLock = lock;
      })
      .catch(function () {
        /* algunos navegadores lo rechazan si la pestaña no está visible;
           no es grave, simplemente no se mantiene encendida */
      });
  }
  // Si el sistema operativo libera el wake lock (p. ej. al cambiar de app
  // y volver), se vuelve a pedir automáticamente en cuanto la pestaña
  // vuelve a estar visible.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && wakeLock === null) {
      requestWakeLock();
    }
  });


  // -- Contraseña -----------------------------------------------------------
  var passwordInput = document.querySelector('[data-role="password-input"]');
  var passwordError = document.querySelector('[data-role="password-error"]');

  function submitPassword() {
    var value = (passwordInput.value || "").trim();
    var expected = String(config.password || "");
    if (value.toLowerCase() === expected.toLowerCase() && expected.length > 0) {
      passwordError.classList.remove("is-visible");
      start();
    } else {
      var options =
        config.wrongPassword && config.wrongPassword.length
          ? config.wrongPassword
          : ["Mmm... creo que necesitas recordar algo 😉"];
      passwordError.textContent = options[wrongAttempt % options.length];
      passwordError.classList.add("is-visible");
      wrongAttempt++;
      passwordInput.value = "";
      passwordInput.focus();
    }
  }
  document.querySelector('[data-action="submit-password"]').addEventListener("click", submitPassword);
  passwordInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitPassword();
  });

  // -- Mensajes: solo avanzan con el botón, nunca solos --------------------
  document.querySelector('[data-action="advance-message"]').addEventListener("click", function () {
    goNext(true);
  });

  // -- Carta: primer toque hace zoom, luego aparece "Continuar" ------------
  var letterFrame = document.querySelector('[data-role="letter-frame"]');
  letterFrame.addEventListener("click", function () {
    if (letterZoomed) return;
    letterZoomed = true;
    var step = steps[stepIndex];
    document.querySelector('[data-role="letter-img"]').src = step.zoomImage;
    letterFrame.dataset.state = "zoom";
    document.querySelector('[data-role="letter-hint"]').hidden = true;
    document.querySelector('[data-role="letter-continue"]').hidden = false;
  });
  document
    .querySelector('[data-action="continue-after-letter"]')
    .addEventListener("click", function (e) {
      e.stopPropagation();
      goNext(true);
    });

  // -- Fotos y cartelas: zona táctil izquierda = atrás, derecha = adelante -
  // (sin controles visibles, para mantener la pantalla limpia; el temporizador
  // de la foto sigue corriendo en paralelo y se cancela al pulsar). Al forzar
  // el cambio con un toque, va SIN transición (instant=true) — solo el
  // avance automático por tiempo mantiene el efecto cinematográfico.
  ["photo", "chapter-title"].forEach(function (name) {
    screens[name].addEventListener("click", function (e) {
      var rect = screens[name].getBoundingClientRect();
      var x = e.clientX - rect.left;
      if (x < rect.width * 0.35) {
        goBack(true);
      } else {
        goNext(true);
      }
    });
  });

  // -- Pantalla final --------------------------------------------------------
  document.querySelector('[data-action="go-final-hint"]').addEventListener("click", function () {
    activateScreen("final-hint");
  });
  document.querySelector('[data-action="replay"]').addEventListener("click", start);
  document.querySelector('[data-action="download"]').addEventListener("click", function () {
    var file = (config.final && config.final.downloadFile) || "album.zip";
    window.location.href = file;
  });
})();
