// ============================================================
//  FileTranslator Pro — Code.gs
//  Google Apps Script Backend
//  v3.0 — Auditado y corregido
// ============================================================
//
//  BUGS CORREGIDOS vs v2.x:
//  [B1] SPLIT_TOKEN (\x00) no sobrevive LanguageApp → eliminado.
//       Ahora se traduce línea a línea (único método 100% fiable).
//  [B2] Límite MAX_FILE_CHARS bloqueaba batches XLSX legítimos.
//       Reemplazado por MAX_PAYLOAD_CHARS más generoso.
//  [B3] Sin guardia de tiempo de ejecución → timeout silencioso de GAS.
//       Ahora lanza error descriptivo al llegar a los 5 min.
//  [B4] Sin pausa entre llamadas → agotamiento de cuota LanguageApp.
//       Utilities.sleep cada SLEEP_INTERVAL llamadas.
//  [B5] Fallback en error retornaba texto ORIGINAL (mezcla de idiomas).
//       Ahora retorna string vacío.
//  [B6] Validación de origen/destino igual podía bypassearse desde XLSX.
//       Validación reforzada antes de cualquier procesamiento.
// ============================================================

var CONFIG = {
  MAX_PAYLOAD_CHARS : 800000,  // ~800 KB — cubre batches XLSX grandes
  SLEEP_INTERVAL    : 15,      // Pausa cada N llamadas a LanguageApp
  SLEEP_MS          : 120,     // ms de pausa (evita quota exhaustion)
  MAX_EXEC_MS       : 300000,  // 5 min tope — GAS corta a 6 min
};

// ─── Entry point ────────────────────────────────────────────
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('FileTranslator Pro')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ─── Traducción principal ────────────────────────────────────
/**
 * Traduce el contenido completo recibido del frontend.
 * Cada línea del string es una unidad de traducción independiente
 * (línea de texto o valor de celda XLSX).
 *
 * @param {string} contenido - Líneas separadas por \n.
 * @param {string} origen    - Código ISO ('es','en',...) o 'auto'.
 * @param {string} destino   - Código ISO del idioma destino.
 * @returns {string} Líneas traducidas, misma cantidad y orden.
 */
function traducirArchivo(contenido, origen, destino) {

  // ── Validaciones de entrada ───────────────────────────────
  if (typeof contenido !== 'string' || !contenido.trim()) {
    throw new Error('El contenido recibido está vacío o no es texto válido.');
  }
  if (contenido.length > CONFIG.MAX_PAYLOAD_CHARS) {
    throw new Error(
      'El payload supera ' + Math.round(CONFIG.MAX_PAYLOAD_CHARS / 1000) +
      ' KB. Reducí el tamaño del archivo o el lote.'
    );
  }
  if (!destino || typeof destino !== 'string') {
    throw new Error('Idioma de destino no especificado.');
  }
  if (origen !== 'auto' && origen === destino) {
    throw new Error('El idioma de origen y destino no pueden ser el mismo.');
  }

  var lineas     = contenido.split('\n');
  var resultado  = new Array(lineas.length);
  var startTime  = Date.now();
  var callCount  = 0;

  for (var i = 0; i < lineas.length; i++) {

    // [B3] Guardia de tiempo de ejecución
    if (Date.now() - startTime > CONFIG.MAX_EXEC_MS) {
      throw new Error(
        'Tiempo límite alcanzado (' + Math.round(CONFIG.MAX_EXEC_MS / 60000) +
        ' min). El archivo es demasiado grande para una sola ejecución. ' +
        'Dividilo en archivos más pequeños.'
      );
    }

    var linea = lineas[i];

    // Líneas vacías no consumen cuota
    if (!linea.trim()) {
      resultado[i] = '';
      continue;
    }

    // [B4] Pausa periódica para no agotar cuota de LanguageApp
    if (callCount > 0 && callCount % CONFIG.SLEEP_INTERVAL === 0) {
      Utilities.sleep(CONFIG.SLEEP_MS);
    }

    try {
      resultado[i] = _llamarLanguageApp(linea, origen, destino);
      callCount++;
    } catch (e) {
      // [B5] En error retornar vacío, nunca el original (evita mezcla de idiomas)
      Logger.log('[ERROR] línea ' + i + ': ' + e.message + ' | texto: "' + linea.substring(0, 60) + '"');
      resultado[i] = '';
    }
  }

  return resultado.join('\n');
}

// ─── Idiomas disponibles ─────────────────────────────────────
/**
 * Lista de idiomas soportados para los <select> del frontend.
 * @returns {Array<{code:string, name:string, flag:string, onlyOrigin?:boolean}>}
 */
function obtenerIdiomas() {
  return [
    { code: 'auto', name: 'Detectar automáticamente', flag: '🌐', onlyOrigin: true },
    { code: 'es',   name: 'Español',    flag: '🇪🇸' },
    { code: 'en',   name: 'Inglés',     flag: '🇺🇸' },
    { code: 'pt',   name: 'Portugués',  flag: '🇧🇷' },
    { code: 'fr',   name: 'Francés',    flag: '🇫🇷' },
    { code: 'de',   name: 'Alemán',     flag: '🇩🇪' },
    { code: 'it',   name: 'Italiano',   flag: '🇮🇹' },
    { code: 'nl',   name: 'Neerlandés', flag: '🇳🇱' },
    { code: 'ru',   name: 'Ruso',       flag: '🇷🇺' },
    { code: 'zh',   name: 'Chino',      flag: '🇨🇳' },
    { code: 'ja',   name: 'Japonés',    flag: '🇯🇵' },
    { code: 'ko',   name: 'Coreano',    flag: '🇰🇷' },
    { code: 'ar',   name: 'Árabe',      flag: '🇸🇦' },
    { code: 'hi',   name: 'Hindi',      flag: '🇮🇳' },
    { code: 'tr',   name: 'Turco',      flag: '🇹🇷' },
    { code: 'pl',   name: 'Polaco',     flag: '🇵🇱' },
  ];
}

// ─── Helper privado ──────────────────────────────────────────
/**
 * Wrapper de LanguageApp.translate con manejo de detección automática.
 * @private
 */
function _llamarLanguageApp(texto, origen, destino) {
  // LanguageApp acepta string vacío como origen para auto-detección
  var src = (origen === 'auto') ? '' : origen;
  return LanguageApp.translate(texto, src, destino);
}
