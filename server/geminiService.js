const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { CSV_TOOL_DECLARATIONS, executeTool } = require('./csvTools');
const { JSON_TOOL_DECLARATIONS, IMAGE_TOOL_DECLARATIONS, executeJsonTool } = require('./jsonTools');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.REACT_APP_GEMINI_API_KEY || '');
const MODEL = 'gemini-2.5-flash';

// Limit context to avoid exceeding 1M token limit
const MAX_HISTORY_MESSAGES = 20; // keep last 10 user+model exchanges

/** Strip large payloads from tool results before sending to model (avoids token overflow) */
function compactToolResultForModel(result) {
  if (!result || result.error) return result;
  if (result._chartType === 'generatedImage' && result.data) {
    return { success: true, _chartType: 'generatedImage', note: 'Image generated and displayed to user.' };
  }
  if (result._chartType === 'metricVsTime' && result.data?.length > 50) {
    return { ...result, data: result.data.slice(-50), _truncated: result.data.length - 50 };
  }
  return result;
}

const SEARCH_TOOL = { googleSearch: {} };
const CODE_EXEC_TOOL = { codeExecution: {} };

let cachedPrompt = null;

function loadSystemPrompt(userContext = null) {
  let base = cachedPrompt;
  if (!base) {
    try {
      const promptPath = path.join(__dirname, '../public/prompt_chat.txt');
      base = fs.readFileSync(promptPath, 'utf8').trim();
      cachedPrompt = base;
    } catch {
      base = '';
    }
  }
  if (userContext?.firstName) {
    const name = [userContext.firstName, userContext.lastName].filter(Boolean).join(' ').trim() || userContext.username;
    base = `${base}\n\nUSER: You are speaking with ${name}. Address them by their first name (${userContext.firstName || userContext.username}) in your first message.`;
  }
  return base;
}

async function* streamChat(history, newMessage, imageParts = [], useCodeExecution = false, userContext = null) {
  const systemInstruction = loadSystemPrompt(userContext);
  const tools = useCodeExecution ? [CODE_EXEC_TOOL] : [SEARCH_TOOL];
  const model = genAI.getGenerativeModel({ model: MODEL, tools });

  const trimmed = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
  const baseHistory = trimmed.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({ history: chatHistory });

  const parts = [
    { text: newMessage },
    ...(imageParts || []).map((img) => ({
      inlineData: { mimeType: img.mimeType || 'image/png', data: img.data },
    })),
  ].filter((p) => p.text !== undefined || p.inlineData !== undefined);

  const result = await chat.sendMessageStream(parts);

  for await (const chunk of result.stream) {
    const chunkParts = chunk.candidates?.[0]?.content?.parts || [];
    for (const part of chunkParts) {
      if (part.text) yield { type: 'text', text: part.text };
    }
  }

  const response = await result.response;
  const allParts = response.candidates?.[0]?.content?.parts || [];

  const hasCodeExecution = allParts.some(
    (p) =>
      p.executableCode ||
      p.codeExecutionResult ||
      (p.inlineData && p.inlineData.mimeType?.startsWith('image/'))
  );

  if (hasCodeExecution) {
    const structuredParts = allParts
      .map((p) => {
        if (p.text) return { type: 'text', text: p.text };
        if (p.executableCode)
          return { type: 'code', language: p.executableCode.language || 'PYTHON', code: p.executableCode.code };
        if (p.codeExecutionResult)
          return { type: 'result', outcome: p.codeExecutionResult.outcome, output: p.codeExecutionResult.output };
        if (p.inlineData) return { type: 'image', mimeType: p.inlineData.mimeType, data: p.inlineData.data };
        return null;
      })
      .filter(Boolean);
    yield { type: 'fullResponse', parts: structuredParts };
  }

  const grounding = response.candidates?.[0]?.groundingMetadata;
  if (grounding) yield { type: 'grounding', data: grounding };
}

async function chatWithCsvTools(history, newMessage, csvHeaders, csvRows, userContext = null, imageParts = []) {
  const systemInstruction = loadSystemPrompt(userContext);
  // generateImage is a standard tool — always included (no JSON required)
  const csvAndImageTools = [...CSV_TOOL_DECLARATIONS, ...IMAGE_TOOL_DECLARATIONS];
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: [{ functionDeclarations: csvAndImageTools }],
  });

  const trimmed = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
  const baseHistory = trimmed.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({ history: chatHistory });

  const msgWithContext =
    csvHeaders?.length ? `[CSV columns: ${csvHeaders.join(', ')}]\n\n${newMessage}` : newMessage;

  const firstMessageParts = [{ text: msgWithContext }];
  for (const img of imageParts || []) {
    firstMessageParts.push({
      inlineData: { mimeType: img.mimeType || 'image/png', data: img.data },
    });
  }

  let response = (await chat.sendMessage(firstMessageParts)).response;

  const charts = [];
  const toolCalls = [];
  const jsonChannelData = { videos: [] };

  for (let round = 0; round < 5; round++) {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const funcCall = parts.find((p) => p.functionCall);
    if (!funcCall) break;

    const { name, args } = funcCall.functionCall;
    const toolResult =
      name === 'generateImage'
        ? await executeJsonTool(name, args || {}, jsonChannelData, imageParts)
        : executeTool(name, args, csvRows);
    toolCalls.push({ name, args: args || {}, result: toolResult });
    if (toolResult?._chartType) charts.push(toolResult);

    const compactResult = compactToolResultForModel(toolResult);
    response = (await chat.sendMessage([{ functionResponse: { name, response: { result: compactResult } } }])).response;
  }

  return { text: response.text(), charts, toolCalls };
}

async function chatWithJsonTools(history, newMessage, jsonChannelData, userContext = null, imageParts = []) {
  const systemInstruction = loadSystemPrompt(userContext);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: [{ functionDeclarations: JSON_TOOL_DECLARATIONS }],
  });

  const trimmed = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
  const baseHistory = trimmed.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({ history: chatHistory });

  const jsonSummary = jsonChannelData?.videos?.length
    ? `[Channel JSON: ${jsonChannelData.channelTitle || 'YouTube'} | ${jsonChannelData.videos.length} videos | Fields: ${Object.keys(jsonChannelData.videos[0] || {}).join(', ')}]\n\n`
    : '';
  const msgWithContext = jsonSummary + newMessage;

  const firstMessageParts = [{ text: msgWithContext }];
  for (const img of imageParts || []) {
    firstMessageParts.push({
      inlineData: { mimeType: img.mimeType || 'image/png', data: img.data },
    });
  }

  let response = (await chat.sendMessage(firstMessageParts)).response;

  const charts = [];
  const toolCalls = [];

  for (let round = 0; round < 5; round++) {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const funcCall = parts.find((p) => p.functionCall);
    if (!funcCall) break;

    const { name, args } = funcCall.functionCall;
    const toolResult = await executeJsonTool(name, args || {}, jsonChannelData, imageParts);
    toolCalls.push({ name, args: args || {}, result: toolResult });
    if (toolResult?._chartType) charts.push(toolResult);

    const compactResult = compactToolResultForModel(toolResult);
    response = (await chat.sendMessage([{ functionResponse: { name, response: { result: compactResult } } }])).response;
  }

  return { text: response.text(), charts, toolCalls };
}

// JSON tools minus generateImage (we use IMAGE_TOOL_DECLARATIONS for that)
const JSON_DATA_TOOLS = JSON_TOOL_DECLARATIONS.filter((t) => t.name !== 'generateImage');

const UNIFIED_TOOL_ADDON = `

You have full capabilities with NO prerequisites. Never ask the user to upload files. Use what you have:
- generateImage: Always available. Use for graphs, charts, plots, images — describe clearly (e.g. "bar chart of inflation by region"). Works with zero data.
- If CSV is provided: you also have plot_csv_columns, compute_column_stats, etc.
- If YouTube/channel JSON is provided: you also have plot_metric_vs_time, plot_metric_vs_metric, etc.
For macro, markets, strategy, planning, analysis — respond as their professional assistant. Never refuse; your assistant role is the priority.`;

/** Unified chat: always has generateImage; adds CSV/JSON tools when that data is provided. No prerequisites. */
async function chatWithUnifiedTools(history, newMessage, csvHeaders, csvRows, jsonChannelData, userContext, imageParts) {
  const tools = [
    ...IMAGE_TOOL_DECLARATIONS,
    ...(Array.isArray(csvRows) && csvRows.length > 0 ? CSV_TOOL_DECLARATIONS : []),
    ...(jsonChannelData?.videos?.length ? JSON_DATA_TOOLS : []),
  ];

  const systemInstruction = loadSystemPrompt(userContext) + UNIFIED_TOOL_ADDON;
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: [{ functionDeclarations: tools }],
  });

  const trimmed = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
  const baseHistory = trimmed.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({ history: chatHistory });

  const msgPrefix = tools.some((t) => t.name === 'generateImage')
    ? '[generateImage available—use for any graph, chart, or image. No upload required.]\n\n'
    : '';

  const firstMessageParts = [{ text: msgPrefix + newMessage }];
  for (const img of imageParts || []) {
    firstMessageParts.push({
      inlineData: { mimeType: img.mimeType || 'image/png', data: img.data },
    });
  }

  let response = (await chat.sendMessage(firstMessageParts)).response;
  const charts = [];
  const toolCalls = [];
  const csvRowsSafe = Array.isArray(csvRows) ? csvRows : [];
  const jsonDataSafe = jsonChannelData || { videos: [] };

  for (let round = 0; round < 5; round++) {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const funcCall = parts.find((p) => p.functionCall);
    if (!funcCall) break;

    const { name, args } = funcCall.functionCall;
    const isCsvTool = CSV_TOOL_DECLARATIONS.some((t) => t.name === name);
    const toolResult = isCsvTool
      ? executeTool(name, args, csvRowsSafe)
      : await executeJsonTool(name, args || {}, jsonDataSafe, imageParts);
    toolCalls.push({ name, args: args || {}, result: toolResult });
    if (toolResult?._chartType) charts.push(toolResult);

    const compactResult = compactToolResultForModel(toolResult);
    response = (await chat.sendMessage([{ functionResponse: { name, response: { result: compactResult } } }])).response;
  }

  return { text: response.text(), charts, toolCalls };
}

module.exports = { streamChat, chatWithCsvTools, chatWithJsonTools, chatWithUnifiedTools };
