// Routing: explicit user intent overrides keyword matching

/** Mode commands: /python, /js, mode:python, mode:js */
const MODE_PYTHON = /^(\/python|mode:\s*python)\b/i;
const MODE_JS = /^(\/js|mode:\s*js)\b/i;

/** Explicit Python intent — higher priority than keyword routing */
const FORCE_PYTHON = /\b(use\s+python|run\s+it|execute|use\s+pandas|use\s+matplotlib|use\s+seaborn)\b/i;

/** Explicit JS intent */
const FORCE_JS = /\b(use\s+js|use\s+javascript|javascript\s+path)\b/i;

/** Fallback: "just do whatever you can" when Python can't run */
const ALLOW_FALLBACK = /\b(just\s+do\s+whatever\s+you\s+can|whatever\s+works|fallback|use\s+js\s+instead)\b/i;

/** Needs Google Search — weather, real-time, current events, stocks. Route to stream path. */
export const NEEDS_SEARCH = /\b(weather|天气|气温|temperature|real.?time|current|today'?s?|latest|stock\s+price|股价|汇率|exchange\s+rate|news|新闻|热搜|trending|几度|多少度|how'?s?\s+the\s+weather|what'?s?\s+the\s+weather)\b/i;

/** Remove mode commands from message for Gemini (strip leading /python, /js, etc.) */
function stripModeCommands(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/^\/python\b\s*/i, '')
    .replace(/^\/js\b\s*/i, '')
    .replace(/^mode:\s*python\b\s*/i, '')
    .replace(/^mode:\s*js\b\s*/i, '')
    .trim();
}

/**
 * Detect user intent from message.
 * @param {string} text - Raw user message
 * @returns {{ forcePython: boolean, forceJs: boolean, allowFallback: boolean, cleanedText: string }}
 */
export function detectIntent(text) {
  const cleaned = stripModeCommands(text);
  const forcePython = MODE_PYTHON.test(text) || FORCE_PYTHON.test(text);
  const forceJs = MODE_JS.test(text) || FORCE_JS.test(text);
  const allowFallback = ALLOW_FALLBACK.test(text);

  return {
    forcePython,
    forceJs,
    allowFallback,
    cleanedText: cleaned || text,
  };
}

/** Typed routing errors for deterministic handling */
export const ROUTING_ERRORS = {
  PYTHON_PREREQ_MISSING: 'PYTHON_PREREQ_MISSING',
  NO_DATA_ATTACHED: 'NO_DATA_ATTACHED',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
};
