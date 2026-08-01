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

  var ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

  // Transiciones disponibles. Se elige una nueva en cada avance automático.
  // Un avance/retroceso forzado nunca utiliza una transición.
  var TRANSITION_DEFINITIONS = [
    { name: "fade",        className: "t-fade",        duration: 1200 },
    { name: "zoom-in",     className: "t-zoom-in",     duration: 1500 },
    { name: "zoom-out",    className: "t-zoom-out",    duration: 1500 },
    { name: "zoom-soft",   className: "t-zoom-soft",   duration: 2000 },
    { name: "pan-left",    className: "t-pan-left",    duration: 1500 },
    { name: "pan-right",   className: "t-pan-right",   duration: 1500 },
    { name: "pan-up",      className: "t-pan-up",      duration: 1500 },
    { name: "pan-down",    className: "t-pan-down",    duration: 1500 },
    { name: "slide-left",  className: "t-slide-left",  duration: 1100 },
    { name: "slide-right", className: "t-slide-right", duration: 1100 },
    { name: "slide-up",    className: "t-slide-up",    duration: 1100 },
    { name: "slide-down",  className: "t-slide-down",  duration: 1100 },
    { name: "blur",        className: "t-blur",        duration: 1500 },
    { name: "scale-fade",  className: "t-scale-fade",  duration: 1400 },
    { name: "kenburns",    className: "t-kenburns",    duration: 2400 }
  ];

  function getRandomTransition() {
    return TRANSITION_DEFINITIONS[
      Math.floor(Math.random() * TRANSITION_DEFINITIONS.length)
    ];
  }

  var photoDurationMs =
    ((config.displaySettings && config.displaySettings.photoDurationSeconds) || 6) * 1000;
  // Duración especial para la ÚLTIMA foto de todo el álbum (justo antes
  // del final): por defecto, el doble de una foto normal si no se
  // configura explícitamente.
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
      var transitionClass = TRANSITIONS[Math.floor(rng() * TRANSITIONS.length)];

      steps.push({
        type: "photo",
        chapterIndex: chIdx,
        src: photoPath,
        chapterPhotoNum: photoNumInChapter,
        globalPhotoNum: runningPhoto,
        transitionClass: transitionClass
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
    img.decoding = "async";
    img.src = src;
  }

  // Precarga TODO el capítulo. Los capítulos tienen menos de 30 fotos.
  function preloadChapter(chapterIndex) {
    var chapter = manifest.chapters[chapterIndex];
    if (!chapter) return;
    (chapter.photos || []).forEach(function (src) {
      preloadImage(src);
    });
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
  preloadUpcoming(0, 3);

  // -- Estado -------------------------------------------------------------
  var stepIndex = -1;
  var timerHandle = null;
  var backgroundTimer = null;
  var transitionToken = 0;
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

  function clearTimer() {
    if (timerHandle) {
      clearTimeout(timerHandle);
      timerHandle = null;
    }
  }

  function cancelBackgroundChange() {
    if (backgroundTimer) {
      clearTimeout(backgroundTimer);
      backgroundTimer = null;
    }
  }

  function invalidateTransitions() {
    transitionToken += 1;
    cancelBackgroundChange();
  }

  function clearTransitionClasses(layer) {
    if (!layer) return;
    layer.className = layer.className.replace(/\bt-[^\s]+\b/g, "").trim();
    layer.style.animation = "none";
    layer.style.transition = "none";
  }

  function restoreTransitionStyles() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        frameLayers.forEach(function (layer) {
          layer.style.animation = "";
          layer.style.transition = "";
        });
        bgLayers.forEach(function (layer) {
          layer.style.animation = "";
          layer.style.transition = "";
        });
      });
    });
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

    if (instant || step.type !== "photo") {
      invalidateTransitions();
    }

    if (step.type === "chapter-title") {
      screens["chapter-title"].querySelector('[data-role="chapter-numeral"]').textContent = step.numeral;
      screens["chapter-title"].querySelector('[data-role="chapter-title"]').textContent = step.title;
      preloadChapter(step.chapterIndex);
      activateScreen("chapter-title");
      playChapterTrack(step.chapterIndex);
      preloadUpcoming(stepIndex + 1, 2);
      scheduleAdvance(2600);
    } else if (step.type === "photo") {
      var token = ++transitionToken;
      var standbyFrame = frameLayers[1 - frameTopIndex];
      var currentFrame = frameLayers[frameTopIndex];
      var standbyBg = bgLayers[1 - bgTopIndex];
      var currentBg = bgLayers[bgTopIndex];

      preloadChapter(step.chapterIndex);
      preloadImage(step.src);

      if (instant) {
        [currentFrame, standbyFrame, currentBg, standbyBg].forEach(function (layer) {
          clearTransitionClasses(layer);
        });
      }

      var standbyImg = standbyFrame.querySelector("img");
      standbyImg.src = step.src;
      standbyImg.alt = "";
      standbyFrame.className = "photo-frame";
      standbyFrame.style.animation = "none";
      standbyFrame.style.transition = "none";

      if (instant) {
        standbyFrame.classList.add("is-top");
      } else {
        var transition = getRandomTransition();
        standbyFrame.classList.add("is-top", transition.className);
      }

      currentFrame.classList.remove("is-top");
      frameTopIndex = 1 - frameTopIndex;

      standbyBg.style.backgroundImage = 'url("' + step.src + '")';
      standbyBg.className = "photo-bg";
      standbyBg.style.animation = "none";
      standbyBg.style.transition = "none";

      if (instant) {
        standbyBg.classList.add("is-top");
        currentBg.classList.remove("is-top");
        bgTopIndex = 1 - bgTopIndex;
        restoreTransitionStyles();
      } else {
        var backgroundDelay = transition.duration + 350;
        backgroundTimer = setTimeout(function () {
          backgroundTimer = null;
          if (token !== transitionToken) return;

          standbyBg.classList.add("is-top");
          currentBg.classList.remove("is-top");
          bgTopIndex = 1 - bgTopIndex;

          setTimeout(function () {
            if (token !== transitionToken) return;
            standbyBg.style.transition = "";
            currentBg.style.transition = "";
          }, 1200);
        }, backgroundDelay);
      }

      screens.photo.querySelector('[data-role="counter-photo"]').textContent =
        step.globalPhotoNum + " / " + totalPhotos;
      activateScreen("photo");
      preloadUpcoming(stepIndex + 1, 2);
      scheduleAdvance(step.isLastPhoto ? lastPhotoDurationMs : photoDurationMs);
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
    if (instant) invalidateTransitions();
    if (stepIndex < steps.length - 1) {
      stepIndex++;
      renderStep(!!instant);
    }
  }

  function goBack(instant) {
    clearTimer();
    if (instant) invalidateTransitions();
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
