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

  // Transiciones: se eligen en cada cambio AUTOMÁTICO, no al construir
  // la secuencia. No se repite la misma consecutivamente.
  // La duración es la entrada de la foto principal. El fondo se retrasa
  // respecto a esta entrada y hace su propio crossfade.
  var TRANSITIONS = [
    { cls: "t-fade", enterAnimation: "albumFade", exitAnimation: "albumExitFade", duration: 1700, exitDuration: 700 },
    { cls: "t-zoom-in", enterAnimation: "albumZoomIn", exitAnimation: "albumExitFadeScale", duration: 2500, exitDuration: 700 },
    { cls: "t-zoom-out", enterAnimation: "albumZoomOut", exitAnimation: "albumExitFadeScale", duration: 2500, exitDuration: 700 },
    { cls: "t-zoom-soft", enterAnimation: "albumZoomSoft", exitAnimation: "albumExitFade", duration: 3500, exitDuration: 700 },
    { cls: "t-pan-left", enterAnimation: "albumPanLeft", exitAnimation: "albumExitFade", duration: 2700, exitDuration: 700 },
    { cls: "t-pan-right", enterAnimation: "albumPanRight", exitAnimation: "albumExitFade", duration: 2700, exitDuration: 700 },
    { cls: "t-pan-up", enterAnimation: "albumPanUp", exitAnimation: "albumExitFade", duration: 2700, exitDuration: 700 },
    { cls: "t-pan-down", enterAnimation: "albumPanDown", exitAnimation: "albumExitFade", duration: 2700, exitDuration: 700 },
    { cls: "t-slide-left", enterAnimation: "albumSlideLeft", exitAnimation: "albumExitSlideLeft", duration: 1700, exitDuration: 700 },
    { cls: "t-slide-right", enterAnimation: "albumSlideRight", exitAnimation: "albumExitSlideRight", duration: 1700, exitDuration: 700 },
    { cls: "t-slide-up", enterAnimation: "albumSlideUp", exitAnimation: "albumExitSlideUp", duration: 1700, exitDuration: 700 },
    { cls: "t-slide-down", enterAnimation: "albumSlideDown", exitAnimation: "albumExitSlideDown", duration: 1700, exitDuration: 700 },
    { cls: "t-blur", enterAnimation: "albumBlur", exitAnimation: "albumExitFadeBlur", duration: 2100, exitDuration: 700 },
    { cls: "t-kenburns", enterAnimation: "albumKenBurns", exitAnimation: "albumExitFade", duration: 3700, exitDuration: 700 },
    { cls: "t-cross-zoom", enterAnimation: "albumCrossZoom", exitAnimation: "albumExitFadeScale", duration: 2500, exitDuration: 700 }
  ];
  var lastTransitionIndex = -1;

  // Tiempo que cada foto permanece completamente visible DESPUÉS de
  // terminar su transición de entrada. La última foto del álbum tiene
  // más tiempo para que el cierre no resulte precipitado.
  var photoDurationMs = 5000;
  var lastPhotoDurationMs = 9000;

  function getRandomTransition() {
    if (TRANSITIONS.length < 2) return TRANSITIONS[0];
    var index;
    do {
      index = Math.floor(Math.random() * TRANSITIONS.length);
    } while (index === lastTransitionIndex);
    lastTransitionIndex = index;
    return TRANSITIONS[index];
  }

  var ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

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
        globalPhotoNum: runningPhoto
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
  // Sin esto, cada foto se pide al navegador justo en el instante en que
  // toca mostrarse. Con conexiones lentas o de alta latencia, eso provoca
  // que se vea la foto ANTERIOR unos instantes de más (sigue visible
  // mientras la nueva todavía no ha llegado) o directamente un salto/hueco.
  // Precargar con antelación evita ambos problemas.
  var preloadedSrcs = {};
  function preloadImage(src) {
    if (!src || preloadedSrcs[src]) return;
    preloadedSrcs[src] = true;
    var img = new Image();
    img.src = src;
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

  function preloadChapter(chapterIndex) {
    var chapter = manifest.chapters[chapterIndex];
    if (!chapter) return;
    (chapter.photos || []).forEach(function (src) {
      preloadImage(src);
    });
  }

  // Precarga completa del primer capítulo antes de comenzar.
  preloadChapter(0);

  // -- Estado -------------------------------------------------------------
  var stepIndex = -1;
  var timerHandle = null;
  var backgroundTransitionToken = 0;
  var letterZoomed = false;
  var wrongAttempt = 0;

  var screens = {};
  document.querySelectorAll(".screen").forEach(function (el) {
    screens[el.dataset.screen] = el;
  });

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

  function clearAdvanceTimer() {
    if (timerHandle) {
      clearTimeout(timerHandle);
      timerHandle = null;
    }
    timerDurationMs = 0;
    timerStartedAt = 0;
  }

  function clearTimer() {
    clearAdvanceTimer();
    // Invalida cualquier cambio de fondo retrasado pendiente.
    backgroundTransitionToken++;
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

    if (step.type === "chapter-title") {
      screens["chapter-title"].querySelector('[data-role="chapter-numeral"]').textContent = step.numeral;
      screens["chapter-title"].querySelector('[data-role="chapter-title"]').textContent = step.title;
      activateScreen("chapter-title");
      playChapterTrack(step.chapterIndex);
      preloadUpcoming(stepIndex + 1, 2);
      scheduleAdvance(2600);
    } else if (step.type === "photo") {
      var standbyFrame = frameLayers[1 - frameTopIndex];
      var currentFrame = frameLayers[frameTopIndex];
      var standbyBg = bgLayers[1 - bgTopIndex];
      var currentBg = bgLayers[bgTopIndex];
      var transition = instant ? null : getRandomTransition();
      var transitionDuration = transition ? transition.duration : 0;

      // Al entrar en un capítulo, todas sus fotos quedan precargadas.
      preloadChapter(step.chapterIndex);

      var standbyImg = standbyFrame.querySelector("img");
      standbyImg.src = step.src;
      standbyImg.alt = "";

      // Preparar ambas capas para una transición REAL entre dos fotos:
      // la nueva entra mientras la anterior sale simultáneamente.
      // Nunca dejamos la foto anterior simplemente "debajo" esperando
      // a la siguiente transición.
      standbyFrame.className = "photo-frame";
      currentFrame.className = "photo-frame is-top";
      standbyFrame.style.animation = "none";
      currentFrame.style.animation = "none";
      standbyFrame.style.transition = "none";
      currentFrame.style.transition = "none";
      standbyFrame.style.removeProperty("animation-name");
      currentFrame.style.removeProperty("animation-name");
      var exitDuration = transition ? transition.exitDuration : 0;
      void standbyFrame.offsetWidth;

      if (instant) {
        // Navegación forzada: detener cualquier animación de ambas capas
        // y mostrar únicamente la nueva foto de forma inmediata.
        standbyFrame.style.animation = "none";
        currentFrame.style.animation = "none";
        standbyFrame.style.removeProperty("animation-name");
        currentFrame.style.removeProperty("animation-name");
        standbyFrame.classList.add("is-top");
        currentFrame.classList.remove("is-top");
        frameTopIndex = 1 - frameTopIndex;
      } else {
        // La nueva foto queda por encima y entra. La antigua permanece
        // debajo SOLO durante esta transición y sale al mismo tiempo.
        standbyFrame.classList.add("is-top", "is-entering", transition.cls);
        currentFrame.classList.add("is-exiting", transition.exit);

        // Las animaciones se asignan explícitamente por estilo inline.
        // Así no dependen de la combinación de reglas CSS entre clases y
        // garantizamos que cada transición realmente se ejecute.
        standbyFrame.style.animationName = transition.enterAnimation;
        standbyFrame.style.animationDuration = transitionDuration + "ms";
        standbyFrame.style.animationTimingFunction = "cubic-bezier(.22,.61,.36,1)";
        standbyFrame.style.animationFillMode = "both";
        currentFrame.style.animationName = transition.exitAnimation;
        currentFrame.style.animationDuration = exitDuration + "ms";
        currentFrame.style.animationTimingFunction = "cubic-bezier(.22,.61,.36,1)";
        currentFrame.style.animationFillMode = "both";

        // Al terminar la transición, la capa antigua queda completamente
        // oculta y la nueva pasa a ser la capa estable.
        var oldFrame = currentFrame;
        var newFrame = standbyFrame;
        var frameToken = ++backgroundTransitionToken;
        setTimeout(function () {
          if (frameToken !== backgroundTransitionToken) return;
          oldFrame.className = "photo-frame";
          oldFrame.style.animation = "none";
          newFrame.className = "photo-frame is-top";
          newFrame.style.animation = "none";
          oldFrame.style.removeProperty("animation-name");
          oldFrame.style.removeProperty("animation-duration");
          oldFrame.style.removeProperty("animation-timing-function");
          oldFrame.style.removeProperty("animation-fill-mode");
          newFrame.style.removeProperty("animation-name");
          newFrame.style.removeProperty("animation-duration");
          newFrame.style.removeProperty("animation-timing-function");
          newFrame.style.removeProperty("animation-fill-mode");
        }, transitionDuration + 50);

        frameTopIndex = 1 - frameTopIndex;
      }

      // El fondo usa siempre la misma foto, pero NO comparte la transición
      // de la foto principal. Se mantiene el fondo anterior durante la
      // transición y se cambia después con crossfade.
      standbyBg.style.backgroundImage = 'url("' + step.src + '")';
      standbyBg.className = "photo-bg";
      standbyBg.style.transition = "none";
      currentBg.style.transition = "none";
      void standbyBg.offsetWidth;

      if (instant) {
        standbyBg.classList.add("is-top");
        currentBg.classList.remove("is-top");
        bgTopIndex = 1 - bgTopIndex;
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            currentFrame.style.transition = "";
            standbyFrame.style.transition = "";
            currentBg.style.transition = "";
            standbyBg.style.transition = "";
          });
        });
      } else {
        var bgToken = frameToken;
        var bgDelay = transitionDuration + 200;
        setTimeout(function () {
          if (bgToken !== backgroundTransitionToken) return;
          currentBg.style.transition = "";
          standbyBg.style.transition = "";
          standbyBg.classList.add("is-top");
          currentBg.classList.remove("is-top");
          bgTopIndex = 1 - bgTopIndex;
        }, bgDelay);
      }

      screens.photo.querySelector('[data-role="counter-photo"]').textContent =
        step.globalPhotoNum + " / " + totalPhotos;
      activateScreen("photo");
      preloadUpcoming(stepIndex + 1, 2);
      // photoDurationMs representa ahora el tiempo que la foto permanece
      // completamente visible DESPUÉS de terminar su transición.
      var holdDuration = step.isLastPhoto ? lastPhotoDurationMs : photoDurationMs;
      scheduleAdvance(holdDuration + transitionDuration);
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
    stepIndex = 0;
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
    // Programar el siguiente avance NO debe cancelar el cambio de fondo
    // retrasado de la foto actual. Solo sustituye el temporizador de avance.
    clearAdvanceTimer();
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

  document
    .querySelector('[data-action="unlock-audio-and-continue"]')
    .addEventListener("click", function () {
      requestFullscreenSafe();
      unlockAllAudio();
      requestWakeLock();
      activateScreen("password");
      pauseBtn.hidden = false;
      // pequeño retraso: en algunos navegadores móviles, enfocar el campo
      // en el mismo tick que el cambio de pantalla no siempre abre el
      // teclado; con la pantalla ya visible sí es fiable.
      setTimeout(function () {
        passwordInput.focus();
      }, 50);
    });

  // -- Contraseña -----------------------------------------------------------
  var passwordInput = document.querySelector('[data-role="password-input"]');
  var passwordError = document.querySelector('[data-role="password-error"]');

  function submitPassword() {
    var value = (passwordInput.value || "").trim();
    var expected = String(config.password || "");
    if (value.toLowerCase() === expected.toLowerCase() && expected.length > 0) {
      passwordError.classList.remove("is-visible");
      // Cierra el teclado virtual antes de entrar en el álbum.
      // El blur se hace sobre el elemento activo para funcionar tanto en
      // Android como en iOS sin depender de que el input siga enfocado.
      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
      passwordInput.blur();
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
    var screen = screens[name];
    if (!screen) return;
    screen.style.touchAction = "manipulation";
    screen.addEventListener("pointerup", function (e) {
      if (e.target.closest && e.target.closest("button, a, input, textarea, select")) return;
      var rect = screen.getBoundingClientRect();
      var x = e.clientX - rect.left;
      if (x < rect.width * 0.35) goBack(true);
      else goNext(true);
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
