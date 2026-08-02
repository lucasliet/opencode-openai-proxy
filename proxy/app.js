import crypto from 'crypto';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';
import { createOpencodeClient } from '@opencode-ai/sdk';

const app = express();
const TARGET_PORT = 4097;
const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000;
const responseState = new Map();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

setInterval(() => {
    const now = Date.now();
    for (const [id, state] of responseState.entries()) {
        if (state.expiresAt <= now) {
            responseState.delete(id);
        }
    }
}, 60 * 1000).unref();

/**
 * Downloads an image and returns it as a data URI.
 * If the input is already a data URI, it returns it directly.
 * 
 * @param {string} url The image URL or data URI
 * @returns {Promise<string>} The image as a data URI
 */
async function getImageDataUri(url) {
    if (url.startsWith('data:')) {
        return url;
    }
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || 'image/jpeg';
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (error) {
        console.error(`Failed to fetch image from ${url}:`, error.message);
        throw new Error(`Failed to fetch image: ${url}`);
    }
}

/**
 * Creates and returns an OpenCode SDK client configured with authentication.
 * 
 * @returns {object} The OpenCode SDK client
 */
function getClient() {
    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
    const baseUrl = `http://127.0.0.1:${TARGET_PORT}`;
    const headers = {};
    
    if (serverPassword) {
        headers['Authorization'] = 'Basic ' + Buffer.from(`opencode:${serverPassword}`).toString('base64');
    }

    return createOpencodeClient({ baseUrl, headers });
}

function parseModel(model) {
    if (model && model.includes('/')) {
        const separatorIndex = model.indexOf('/');
        return {
            providerId: model.slice(0, separatorIndex),
            modelId: model.slice(separatorIndex + 1)
        };
    }

    return { providerId: 'opencode', modelId: 'big-pickle' };
}

async function buildPromptPartsAndSystem(messages) {
    const allParts = [];
    let fullPromptText = '';
    let systemPrompt = '';

    for (const m of messages) {
        if (m.role === 'system') {
            if (typeof m.content === 'string') {
                systemPrompt += `${m.content}\n`;
            } else if (Array.isArray(m.content)) {
                systemPrompt += `${m.content.map((c) => c.text || '').join('\n')}\n`;
            }
            continue;
        }

        const role = m.role === 'assistant' ? 'Assistant' : 'User';

        if (typeof m.content === 'string') {
            allParts.push({ type: 'text', text: m.content });
            fullPromptText += `${role}: ${m.content}\n\n`;
            continue;
        }

        if (!Array.isArray(m.content)) {
            continue;
        }

        for (const part of m.content) {
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                const text = part.text || '';
                allParts.push({ type: 'text', text });
                fullPromptText += `${role}: ${text}\n\n`;
            } else if (part.type === 'image_url' || part.type === 'input_image') {
                const url =
                    typeof part.image_url === 'string'
                        ? part.image_url
                        : part.image_url?.url || part.url;

                if (!url) {
                    continue;
                }

                try {
                    const dataUri = await getImageDataUri(url);
                    const mime = dataUri.split(';')[0].split(':')[1];
                    allParts.push({
                        type: 'file',
                        mime,
                        url: dataUri,
                        filename: 'image'
                    });
                    fullPromptText += `${role}: [Image attached]\n\n`;
                } catch (e) {
                    console.warn('Skipping image due to error:', e.message);
                }
            }
        }
    }

    return {
        allParts,
        fullPromptText: fullPromptText.trim(),
        systemPrompt: systemPrompt.trim()
    };
}

function normalizeResponsesInputToMessages({ input, instructions }) {
    const messages = [];

    if (instructions && typeof instructions === 'string') {
        messages.push({ role: 'system', content: instructions });
    }

    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
        return messages;
    }

    if (input && typeof input === 'object' && !Array.isArray(input) && input.role && input.content !== undefined) {
        messages.push({ role: input.role, content: input.content });
        return messages;
    }

    if (!Array.isArray(input)) {
        return messages;
    }

    for (const item of input) {
        if (typeof item === 'string') {
            messages.push({ role: 'user', content: item });
            continue;
        }

        if (!item || typeof item !== 'object') {
            continue;
        }

        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: item.content || '' });
            continue;
        }

        if (item.type === 'input_text') {
            messages.push({
                role: 'user',
                content: [{ type: 'input_text', text: item.text || '' }]
            });
            continue;
        }

        if (item.type === 'input_image') {
            messages.push({
                role: 'user',
                content: [{ type: 'input_image', image_url: item.image_url || item.url || '' }]
            });
            continue;
        }

        if (item.role && item.content !== undefined) {
            messages.push({ role: item.role, content: item.content });
        }
    }

    return messages;
}

function storeResponseState(responseId, state) {
    responseState.set(responseId, {
        ...state,
        expiresAt: Date.now() + RESPONSE_STATE_TTL_MS
    });
}

function getResponseState(responseId) {
    const state = responseState.get(responseId);
    if (!state) {
        return null;
    }

    if (state.expiresAt <= Date.now()) {
        responseState.delete(responseId);
        return null;
    }

    return state;
}

function buildResponsesOutputText(content, reasoningContent) {
    if (!reasoningContent) {
        return content;
    }

    return `<think>\n${reasoningContent}\n</think>\n\n${content}`;
}

function buildResponsesUsage(promptText, content, reasoningContent) {
    const inputTokens = Math.ceil(promptText.length / 4);
    const outputTokens = Math.ceil((content.length + reasoningContent.length) / 4);
    const reasoningTokens = Math.ceil(reasoningContent.length / 4);

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        output_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function sendResponseSseEvent(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Refusal phrases produced by agent-style models when no tools are allowed.
// Word boundaries avoid matching subwords like "already" or "readily".
const REFUSAL_PATTERN = /\b(?:ready|nothing to do|no request|no task|can'?t see)\b|\bwhat would you (?:like|do|work on)\b|\bhelp\s+with\b/i;

/**
 * Consumes the OpenCode SSE stream for a single prompt attempt, extracting text
 * deltas from both the delta event flow (message.part.delta) and the cumulative
 * message.part.updated flow used by newer servers. For the cumulative flow the
 * delta is reconstructed by diffing part.text per part id, and the user's own
 * echoed parts are suppressed so the prompt is never streamed back as output.
 *
 * The caller owns session/prompt setup, keepalive and SSE formatting; this
 * function only drives the event loop and calls back for deltas/terminal states.
 *
 * @param {object} options
 * @param {AsyncIterator} options.eventIterator SSE event iterator for this attempt
 * @param {string} options.sessionId Session id to filter events by
 * @param {object} options.res Express response (used for res.destroyed checks)
 * @param {{ ended: boolean, streamedAnything: boolean, insideReasoning: boolean }} options.state
 *   Mutable state shared with the caller, mutated as events are processed.
 * @param {() => (Error|null)} options.getPromptError
 * @param {(finish: string) => void} options.onFinish Called on terminal finish
 * @param {(msg: string) => void} options.onFail Called on session.error / idle / errors
 * @param {() => void} options.onReasoningStart
 * @param {(delta: string) => void} options.onReasoningDelta
 * @param {() => void} options.onReasoningEnd
 * @param {(delta: string) => void} options.onTextDelta
 */
async function consumeStreamEvents({
    eventIterator,
    sessionId,
    res,
    state,
    getPromptError,
    onFinish,
    onFail,
    onReasoningStart,
    onReasoningDelta,
    onReasoningEnd,
    onTextDelta
}) {
    const partTypes = new Map();
    const partTexts = new Map();
    const userMessageIds = new Set();

    const emitDelta = (partType, delta) => {
        if (!delta) return;
        if (partType === 'reasoning') {
            if (!state.insideReasoning) {
                onReasoningStart();
                state.insideReasoning = true;
            }
            onReasoningDelta(delta);
            state.streamedAnything = true;
        } else {
            if (state.insideReasoning) {
                onReasoningEnd();
                state.insideReasoning = false;
            }
            onTextDelta(delta);
            state.streamedAnything = true;
        }
    };

    try {
        // IMPORTANT: keep a single pending next() promise — creating a new
        // one while the previous is pending discards events silently.
        let pendingNext = eventIterator.next();
        while (!res.destroyed && !state.ended) {
            const pollTimeout = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1000));
            const eventResult = await Promise.race([pendingNext, pollTimeout]);

            if (eventResult.timeout) {
                const promptError = getPromptError();
                if (promptError) {
                    console.warn('Ending stream due to prompt error:', promptError.message);
                    onFail(promptError.message);
                }
                continue;
            }

            pendingNext = eventIterator.next();

            if (eventResult.done) break;

            const event = eventResult.value;

            // Track user message ids so their echoed parts can be suppressed.
            if (event.type === 'message.updated') {
                const info = event.properties?.info;
                if (info?.sessionID === sessionId) {
                    if (info.role === 'user' && info.id) {
                        userMessageIds.add(info.id);
                    }
                    // Any terminal finish value ends the stream; tool-calls is
                    // intermediate (the model asked for tools) — keep streaming.
                    if (info.finish && info.finish !== 'tool-calls') {
                        onFinish(info.finish);
                        break;
                    }
                }
            }

            if (event.type === 'message.part.updated') {
                const { part, delta: legacyDelta } = event.properties || {};
                if (!part || part?.sessionID !== sessionId) continue;
                if (part?.id && part?.type) partTypes.set(part.id, part.type);

                // Skip the user's own echoed parts so the prompt is not
                // streamed back as assistant output.
                if (part.role === 'user') continue;
                if (part.messageID && userMessageIds.has(part.messageID)) continue;

                const partType = part.type || partTypes.get(part.id) || 'text';

                // Newer opencode servers only emit cumulative part.text (no
                // delta field) — reconstruct the delta by diffing per part id.
                // A snapshot shorter than the accumulated text means the server
                // rewrote/truncated it, not new content, so emit no delta.
                let delta = legacyDelta;
                if (typeof part.text === 'string') {
                    const prev = partTexts.get(part.id) || '';
                    delta = part.text.startsWith(prev) ? part.text.slice(prev.length) : '';
                    partTexts.set(part.id, part.text);
                }

                emitDelta(partType, delta);
                continue;
            }

            // Streaming deltas come as message.part.delta in opencode >= 1.18.
            // Keep partTexts in sync here too: opencode also emits cumulative
            // message.part.updated snapshots for the same part, so the snapshot
            // diff below must know how much text was already delivered.
            if (event.type === 'message.part.delta') {
                const { sessionID, partID, field, delta } = event.properties;
                if (sessionID !== sessionId || field !== 'text' || !delta) continue;
                emitDelta(partTypes.get(partID) || 'text', delta);
                partTexts.set(partID, (partTexts.get(partID) || '') + delta);
                continue;
            }

            // Session errored (e.g. model not found, provider failure)
            if (event.type === 'session.error') {
                const props = event.properties;
                if (props?.sessionID === sessionId) {
                    const msg = props?.error?.data?.message || props?.error?.message || 'Session error';
                    onFail(msg);
                }
            }

            // Session went idle: terminal signal for our session
            if (event.type === 'session.idle') {
                if (event.properties?.sessionID === sessionId) {
                    if (state.streamedAnything) {
                        onFinish('stop');
                        break;
                    } else {
                        onFail('Session went idle without producing content');
                    }
                }
            }
        }
    } catch (streamError) {
        console.error('Streaming error:', streamError);
        onFail(streamError.message);
    } finally {
        // Close the SSE subscription so no iterator stays open after the attempt.
        if (eventIterator?.return) {
            await eventIterator.return();
        }
    }
}

// Auth Middleware
app.use((req, res, next) => {
    // Permite health check sem auth
    if (req.path === '/health') return next();

    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
    
    if (serverPassword) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                error: { message: 'Missing or invalid Authorization header. Expected Bearer <OPENCODE_SERVER_PASSWORD>' } 
            });
        }

        const token = authHeader.split(' ')[1];
        if (token !== serverPassword) {
            return res.status(401).json({ error: { message: 'Invalid API key' } });
        }
    }
    next();
});

// Endpoint: GET /v1/models
app.get('/v1/models', async (req, res) => {
    try {
        const client = getClient();
        const providersRes = await client.config.providers();
        const providersRaw = providersRes.data?.providers || [];
        
        const models = [];
        
        // Handle both Array and Object (SDK compatibility)
        const providersList = Array.isArray(providersRaw) 
            ? providersRaw 
            : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));

        providersList.forEach((providerInfo) => {
            const providerId = providerInfo.id;
            if (providerInfo.models) {
                Object.entries(providerInfo.models).forEach(([modelId, modelData]) => {
                    models.push({
                        id: `${providerId}/${modelId}`,
                        name: typeof modelData === 'object' ? (modelData.name || modelData.label || modelId) : modelId,
                        object: 'model',
                        created: (modelData && modelData.release_date) 
                            ? Math.floor(new Date(modelData.release_date).getTime() / 1000) 
                            : 1704067200, // Fallback to 2024-01-01
                        owned_by: providerId
                    });
                });
            }
        });

        res.json({
            object: 'list',
            data: models
        });
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({ error: { message: 'Failed to fetch models from OpenCode' } });
    }
});

// Endpoint: POST /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const {
            messages,
            model,
            stream,
            tools,
            tool_choice: toolChoice,
            parallel_tool_calls: parallelToolCalls
        } = req.body || {};

        let ignoredTools = false;
        if (
            (Array.isArray(tools) && tools.length > 0) ||
            (toolChoice && toolChoice !== 'none' && toolChoice !== 'auto')
        ) {
            ignoredTools = true;
        }

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: { message: 'messages array is required' } });
        }

        const { providerId, modelId } = parseModel(model);

        const client = getClient();

        console.log(`Using model: ${providerId}/${modelId}${stream ? ' (streaming)' : ''}`);

        const { allParts, fullPromptText, systemPrompt } = await buildPromptPartsAndSystem(messages);
        
        // 1. Set active model
        try {
            await client.config.update({
                body: {
                    activeModel: { providerID: providerId, modelID: modelId }
                }
            });
        } catch (confError) {
            console.warn('Failed to set active model:', confError.message);
        }

         // 2. Sessions are created per attempt inside each branch below
         
         if (stream) {
             res.setHeader('Content-Type', 'text/event-stream');
             res.setHeader('Cache-Control', 'no-cache');
             res.setHeader('Connection', 'keep-alive');

             const id = `chatcmpl-${crypto.randomUUID()}`;
             let completionTokens = 0;
             let reasoningTokens = 0;

             // 3.-4. Send prompt + stream events (with retries for agent-style
             //        models that occasionally error or refuse before content)
             let attemptErrorMsg = null;

             for (let attempt = 1; attempt <= 3 && !res.destroyed; attempt++) {
                 const attemptSession = await client.session.create();
                 const sessionId = attemptSession.data?.id;
                 if (!sessionId) throw new Error('Failed to create session');

                 let promptError = null;
                 attemptErrorMsg = null;
                 const state = { ended: false, streamedAnything: false, insideReasoning: false };

                 client.session.prompt({
                     path: { id: sessionId },
                     body: { 
                         model: {
                             providerID: providerId,
                             modelID: modelId
                         },
                         prompt: fullPromptText.trim(),
                         system: systemPrompt.trim(),
                         parts: allParts
                     }
                 }).then(r => {
                     if (r?.response?.status >= 400) {
                         promptError = new Error('OpenCode server returned HTTP ' + r.response.status);
                         console.warn('Prompt error: HTTP', r.response.status);
                     }
                 }).catch(err => {
                     promptError = err;
                     console.warn('Prompt error:', err.message);
                 });

                 const eventStreamResult = await client.event.subscribe();
                 const eventStream = eventStreamResult.stream;
                 const eventIterator = eventStream[Symbol.asyncIterator]();

                 const keepaliveInterval = setInterval(() => {
                     if (!res.destroyed) {
                         res.write(': keepalive\n\n');
                     }
                 }, 15000);

                 const writeChatDelta = (content) => {
                     res.write(`data: ${JSON.stringify({
                         id,
                         object: 'chat.completion.chunk',
                         created: Math.floor(Date.now() / 1000),
                         model: `${providerId}/${modelId}`,
                         choices: [{
                             index: 0,
                             delta: { content },
                             finish_reason: null
                         }]
                     })}\n\n`);
                 };

                 const closeReasoningTag = () => {
                     if (!state.insideReasoning) return;
                     writeChatDelta('\n</think>\n\n');
                     state.insideReasoning = false;
                 };

                 const writeErrorChunk = (msg) => {
                     if (res.destroyed) return;
                     closeReasoningTag();
                     res.write(`data: ${JSON.stringify({
                         id,
                         object: 'chat.completion.chunk',
                         created: Math.floor(Date.now() / 1000),
                         model: `${providerId}/${modelId}`,
                         choices: [{
                             index: 0,
                             delta: {},
                             finish_reason: 'error'
                         }],
                         error: { message: msg }
                     })}\n\n`);
                     res.write('data: [DONE]\n\n');
                     res.end();
                 };

                 const finalize = (finishReason) => {
                     if (state.ended) return;
                     state.ended = true;
                     clearInterval(keepaliveInterval);
                     if (res.destroyed) return;
                     closeReasoningTag();

                     const promptTokens = Math.ceil(fullPromptText.length / 4);
                     const usage = {
                         prompt_tokens: promptTokens,
                         completion_tokens: completionTokens + reasoningTokens,
                         total_tokens: promptTokens + completionTokens + reasoningTokens,
                         completion_tokens_details: {
                             reasoning_tokens: reasoningTokens
                         }
                     };

                     const finalChunk = {
                         id,
                         object: 'chat.completion.chunk',
                         created: Math.floor(Date.now() / 1000),
                         model: `${providerId}/${modelId}`,
                         choices: [{
                             index: 0,
                             delta: {},
                             finish_reason: finishReason
                         }],
                         usage
                     };
                     if (ignoredTools) {
                         finalChunk.metadata = { tools_support: 'tools/function calling is not enabled in this branch yet and was ignored' };
                     }
                     res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                     res.write('data: [DONE]\n\n');
                     res.end();
                 };

                 const failAttempt = (msg) => {
                     if (state.ended) return;
                     state.ended = true;
                     clearInterval(keepaliveInterval);
                     if (res.destroyed) return;
                     if (state.streamedAnything) {
                         // can't retry after content was sent — surface the error
                         writeErrorChunk(msg);
                     } else {
                         attemptErrorMsg = msg;
                     }
                 };

                 // Process events (poll so prompt failures never hang the stream).
                 // The shared consumer reconstructs deltas from cumulative
                 // part.text, suppresses the user's echoed parts, and closes the
                 // SSE subscription when the attempt ends.
                 await consumeStreamEvents({
                     eventIterator,
                     sessionId,
                     res,
                     state,
                     getPromptError: () => promptError,
                     onFinish: (finish) => finalize(finish === 'stop' ? 'stop' : finish),
                     onFail: (msg) => failAttempt(msg),
                     onReasoningStart: () => {
                         writeChatDelta('<think>\n');
                     },
                     onReasoningDelta: (delta) => {
                         reasoningTokens += Math.ceil(delta.length / 4);
                         writeChatDelta(delta);
                     },
                     onReasoningEnd: () => closeReasoningTag(),
                     onTextDelta: (delta) => {
                         completionTokens += Math.ceil(delta.length / 4);
                         writeChatDelta(delta);
                     }
                 });

                 clearInterval(keepaliveInterval);

                 if (!state.ended) {
                     // stream closed without a terminal event
                     failAttempt(promptError?.message || 'Stream ended unexpectedly');
                 }

                 if (state.ended && state.streamedAnything) {
                     // success (or error after content) — response already closed
                     break;
                 }

                 if (attempt < 3) {
                     console.warn(`Stream attempt ${attempt}/3 failed before content, retrying:`, attemptErrorMsg || 'unknown');
                     continue;
                 }

                 // Last attempt failed before any content — surface the error
                 console.warn('All stream attempts failed:', attemptErrorMsg || 'unknown');
                 if (!res.destroyed) {
                     writeErrorChunk(attemptErrorMsg || 'All stream attempts failed');
                 }
                 break;
             }
         } else {
             // 3. Non-streaming: await complete response (with retries for
             //    agent-style models that occasionally error, refuse or hang)
             const MAX_ATTEMPTS = 3;
             const ATTEMPT_TIMEOUT_MS = 90000;
             let responseData = null;
             let lastError = null;

             for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                 const attemptSession = await client.session.create();
                 const attemptSessionId = attemptSession.data?.id;
                 if (!attemptSessionId) throw new Error('Failed to create session');

                 const attemptPromise = client.session.prompt({
                     path: { id: attemptSessionId },
                     body: { 
                         model: {
                             providerID: providerId,
                             modelID: modelId
                         },
                         prompt: fullPromptText.trim(),
                         system: systemPrompt.trim(),
                         parts: allParts
                     }
                 });
                 let timeoutHandle;
                 const timeoutPromise = new Promise((_, reject) => {
                     timeoutHandle = setTimeout(() => reject(new Error(`Attempt ${attempt} timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s`)), ATTEMPT_TIMEOUT_MS);
                 });

                 let responseRes;
                 try {
                     responseRes = await Promise.race([attemptPromise, timeoutPromise]);
                 } catch (e) {
                     lastError = e;
                     console.warn(`Chat attempt ${attempt}/${MAX_ATTEMPTS} failed:`, e.message);
                     if (attempt >= MAX_ATTEMPTS) break;
                     continue;
                 } finally {
                     clearTimeout(timeoutHandle);
                 }

                 if (responseRes?.response?.status >= 400) {
                     lastError = new Error(responseRes?.error?.message || responseRes?.response?.body?.error?.message || `OpenCode server returned HTTP ${responseRes.response.status}`);
                     console.warn(`Chat attempt ${attempt}/${MAX_ATTEMPTS} error:`, lastError.message);
                     if (attempt >= MAX_ATTEMPTS) break;
                     continue;
                 }

                 const attemptParts = responseRes.data?.parts || [];
                 const attemptText = attemptParts.filter(p => p.type === 'text').map(p => p.text).join('');
                 if (attemptText.trim() && REFUSAL_PATTERN.test(attemptText.slice(0, 150))) {
                     lastError = new Error('Model refused to answer (no tools allowed in this proxy branch)');
                     console.warn(`Chat attempt ${attempt}/${MAX_ATTEMPTS} refused: "${attemptText.slice(0, 60)}"`);
                     if (attempt >= MAX_ATTEMPTS) {
                         responseData = responseRes.data;
                     }
                     continue;
                 }

                 responseData = responseRes.data;
                 break;
             }

             if (!responseData) {
                 throw lastError || new Error('All chat attempts failed');
             }
             const responseRes = { data: responseData };

             // Format content
             let content = '';
             let reasoningContent = '';
             const parts = responseRes.data?.parts || [];
             
             content = parts
                 .filter(p => p.type === 'text')
                 .map(p => p.text)
                 .join('\n');
                 
             reasoningContent = parts
                 .filter(p => p.type === 'reasoning')
                 .map(p => p.text)
                 .join('\n');

             if (!content && responseRes.data) {
                 const data = responseRes.data;
                 if (typeof data === 'string') content = data;
                 else content = data?.message || JSON.stringify(data);
             }
             
             // Calculate usage
             const promptTokens = fullPromptText.length / 4; 
             const completionTokens = content.length / 4;
             const reasoningTokens = reasoningContent.length / 4;
             const totalTokens = promptTokens + completionTokens + reasoningTokens;

             const usage = {
                 prompt_tokens: Math.ceil(promptTokens),
                 completion_tokens: Math.ceil(completionTokens + reasoningTokens),
                 total_tokens: Math.ceil(totalTokens),
                 completion_tokens_details: {
                     reasoning_tokens: Math.ceil(reasoningTokens)
                 }
             };

             // Combine reasoning into content for non-streaming
             let finalContent = content;
             if (reasoningContent) {
                 finalContent = `<think>\n${reasoningContent}\n</think>\n\n${content}`;
             }

             const result = {
                 id: `chatcmpl-${crypto.randomUUID()}`,
                 object: 'chat.completion',
                 created: Math.floor(Date.now() / 1000),
                 model: `${providerId}/${modelId}`,
                 choices: [{
                     index: 0,
                     message: {
                         role: 'assistant',
                         content: finalContent
                     },
                     finish_reason: 'stop'
                 }],
                 usage: usage
             };
             if (ignoredTools) {
                 result.metadata = { tools_support: 'tools/function calling is not enabled in this branch yet and was ignored' };
             }
             return res.json(result);
         }

    } catch (error) {
        console.error('Proxy Processing Error:', error);
        const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
        res.status(500).json({ 
            error: { 
                message: 'Internal Proxy Error',
                details: errorMessage
            } 
        });
    }
});

app.post('/v1/responses', async (req, res) => {
    try {
        const {
            input,
            instructions,
            model,
            stream,
            previous_response_id: previousResponseId,
            tools,
            tool_choice: toolChoice,
            parallel_tool_calls: parallelToolCalls
        } = req.body || {};

        let ignoredTools = false;
        if (
            (Array.isArray(tools) && tools.length > 0) ||
            (toolChoice && toolChoice !== 'none' && toolChoice !== 'auto')
        ) {
            ignoredTools = true;
        }

        if (Array.isArray(input)) {
            const hasToolOutputs = input.some((item) => item?.type === 'function_call_output');
            if (hasToolOutputs) {
                return res.status(400).json({
                    error: {
                        message: 'function_call_output is not enabled in this branch yet',
                        type: 'invalid_request_error'
                    }
                });
            }
        }

        let previousState = null;
        if (previousResponseId) {
            previousState = getResponseState(previousResponseId);
            if (!previousState) {
                return res.status(400).json({
                    error: {
                        message: 'Invalid or expired previous_response_id',
                        type: 'invalid_request_error'
                    }
                });
            }
        }

        const selectedModel = model || previousState?.model || 'opencode/big-pickle';
        const { providerId, modelId } = parseModel(selectedModel);
        const client = getClient();

        try {
            await client.config.update({
                body: {
                    activeModel: { providerID: providerId, modelID: modelId }
                }
            });
        } catch (confError) {
            console.warn('Failed to set active model:', confError.message);
        }

        let sessionId = previousState?.sessionId;
        if (!sessionId) {
            const sessionRes = await client.session.create();
            sessionId = sessionRes.data?.id;
            if (!sessionId) {
                throw new Error('Failed to create session');
            }
        }

        const messages = normalizeResponsesInputToMessages({ input, instructions });
        if (messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'input is required when no usable previous_response_id context is provided',
                    type: 'invalid_request_error'
                }
            });
        }

        const { allParts, fullPromptText, systemPrompt } = await buildPromptPartsAndSystem(messages);

        const createdAt = Math.floor(Date.now() / 1000);
        const responseId = `resp_${crypto.randomUUID()}`;
        const outputMessageId = `msg_${crypto.randomUUID()}`;

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let completionText = '';
            let reasoningText = '';

            sendResponseSseEvent(res, {
                type: 'response.created',
                response: {
                    id: responseId,
                    object: 'response',
                    created_at: createdAt,
                    status: 'in_progress',
                    model: `${providerId}/${modelId}`
                }
            });

            sendResponseSseEvent(res, {
                type: 'response.output_item.added',
                response_id: responseId,
                output_index: 0,
                item: {
                    id: outputMessageId,
                    type: 'message',
                    role: 'assistant',
                    status: 'in_progress',
                    content: [{ type: 'output_text', text: '' }]
                }
            });

            let attemptErrorMsg = null;

            for (let attempt = 1; attempt <= 3 && !res.destroyed; attempt++) {
                // Reuse the (continuation) session on every attempt so retries
                // never lose conversation history for previous_response_id.
                let promptError = null;
                attemptErrorMsg = null;
                const state = { ended: false, streamedAnything: false, insideReasoning: false };

                client.session.prompt({
                    path: { id: sessionId },
                    body: {
                        model: {
                            providerID: providerId,
                            modelID: modelId
                        },
                        prompt: fullPromptText,
                        system: systemPrompt,
                        parts: allParts
                    }
                }).then(r => {
                    if (r?.response?.status >= 400) {
                        promptError = new Error('OpenCode server returned HTTP ' + r.response.status);
                        console.warn('Prompt error: HTTP', r.response.status);
                    }
                }).catch((err) => {
                    promptError = err;
                    console.warn('Prompt error:', err.message);
                });

                const eventStreamResult = await client.event.subscribe();
                const eventStream = eventStreamResult.stream;
                const eventIterator = eventStream[Symbol.asyncIterator]();

                const keepaliveInterval = setInterval(() => {
                    if (!res.destroyed) {
                        res.write(': keepalive\n\n');
                    }
                }, 15000);

                const sendTextDelta = (delta) => {
                    sendResponseSseEvent(res, {
                        type: 'response.output_text.delta',
                        response_id: responseId,
                        output_index: 0,
                        content_index: 0,
                        delta
                    });
                };

                const writeErrorEvent = (msg) => {
                    if (res.destroyed) return;
                    sendResponseSseEvent(res, {
                        type: 'error',
                        error: {
                            message: msg || 'stream ended without completion'
                        }
                    });
                    res.write('data: [DONE]\n\n');
                    res.end();
                };

                const closeReasoningTag = () => {
                    if (!state.insideReasoning) return;
                    sendTextDelta('\n</think>\n\n');
                    reasoningText += '\n</think>\n\n';
                    state.insideReasoning = false;
                };

                const finalize = (status) => {
                    if (state.ended) return;
                    state.ended = true;
                    clearInterval(keepaliveInterval);
                    if (res.destroyed) return;

                    closeReasoningTag();

                    const usage = buildResponsesUsage(fullPromptText, completionText, reasoningText);

                    sendResponseSseEvent(res, {
                        type: 'response.output_item.done',
                        response_id: responseId,
                        output_index: 0,
                        item: {
                            id: outputMessageId,
                            type: 'message',
                            role: 'assistant',
                            status: status === 'completed' ? 'completed' : 'incomplete',
                            content: [{ type: 'output_text', text: `${reasoningText}${completionText}` }]
                        }
                    });

                    const finalResponseEvent = {
                        type: status === 'completed' ? 'response.completed' : 'response.incomplete',
                        response: {
                            id: responseId,
                            object: 'response',
                            created_at: createdAt,
                            status,
                            model: `${providerId}/${modelId}`,
                            output: [{
                                id: outputMessageId,
                                type: 'message',
                                role: 'assistant',
                                status: status === 'completed' ? 'completed' : 'incomplete',
                                content: [{ type: 'output_text', text: `${reasoningText}${completionText}` }]
                            }],
                            usage,
                            error: null
                        }
                    };
                    if (ignoredTools) {
                        finalResponseEvent.response.metadata = { tools_support: 'tools/function calling for /v1/responses is not enabled in this branch yet and was ignored' };
                    }
                    sendResponseSseEvent(res, finalResponseEvent);

                    storeResponseState(responseId, {
                        sessionId,
                        model: `${providerId}/${modelId}`
                    });

                    res.write('data: [DONE]\n\n');
                    res.end();
                };

                const failAttempt = (msg) => {
                    if (state.ended) return;
                    state.ended = true;
                    clearInterval(keepaliveInterval);
                    if (res.destroyed) return;
                    if (state.streamedAnything) {
                        // can't retry after content was sent — surface the error
                        writeErrorEvent(msg);
                    } else {
                        attemptErrorMsg = msg;
                    }
                };

                // Process events (poll so prompt failures never hang the stream).
                // The shared consumer reconstructs deltas from cumulative
                // part.text, suppresses the user's echoed parts, and closes the
                // SSE subscription when the attempt ends.
                await consumeStreamEvents({
                    eventIterator,
                    sessionId,
                    res,
                    state,
                    getPromptError: () => promptError,
                    onFinish: (finish) => finalize(finish === 'stop' ? 'completed' : 'incomplete'),
                    onFail: (msg) => failAttempt(msg),
                    onReasoningStart: () => {
                        sendTextDelta('<think>\n');
                        reasoningText += '<think>\n';
                    },
                    onReasoningDelta: (delta) => {
                        sendTextDelta(delta);
                        reasoningText += delta;
                    },
                    onReasoningEnd: () => closeReasoningTag(),
                    onTextDelta: (delta) => {
                        sendTextDelta(delta);
                        completionText += delta;
                    }
                });

                clearInterval(keepaliveInterval);

                if (!state.ended) {
                    failAttempt(promptError?.message || 'Stream ended unexpectedly');
                }

                if (state.ended && state.streamedAnything) {
                    break;
                }

                if (attempt < 3) {
                    console.warn(`Responses stream attempt ${attempt}/3 failed before content, retrying:`, attemptErrorMsg || 'unknown');
                    continue;
                }

                console.warn('All responses stream attempts failed:', attemptErrorMsg || 'unknown');
                if (!res.destroyed) {
                    writeErrorEvent(attemptErrorMsg || 'All stream attempts failed');
                }
                break;
            }

            return;
        }

        const MAX_ATTEMPTS = 3;
        const ATTEMPT_TIMEOUT_MS = 90000;
        let responseData = null;
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            // Reuse the (continuation) session on every attempt so retries
            // never lose conversation history for previous_response_id.
            const attemptPromise = client.session.prompt({
                path: { id: sessionId },
                body: {
                    model: {
                        providerID: providerId,
                        modelID: modelId
                    },
                    prompt: fullPromptText,
                    system: systemPrompt,
                    parts: allParts
                }
            });
            let timeoutHandle;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error(`Attempt ${attempt} timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s`)), ATTEMPT_TIMEOUT_MS);
            });

            let responseRes;
            try {
                responseRes = await Promise.race([attemptPromise, timeoutPromise]);
            } catch (e) {
                lastError = e;
                console.warn(`Responses attempt ${attempt}/${MAX_ATTEMPTS} failed:`, e.message);
                if (attempt >= MAX_ATTEMPTS) break;
                continue;
            } finally {
                clearTimeout(timeoutHandle);
            }

            if (responseRes?.response?.status >= 400) {
                lastError = new Error(responseRes?.error?.message || responseRes?.response?.body?.error?.message || `OpenCode server returned HTTP ${responseRes.response.status}`);
                console.warn(`Responses attempt ${attempt}/${MAX_ATTEMPTS} error:`, lastError.message);
                if (attempt >= MAX_ATTEMPTS) break;
                continue;
            }

            const attemptParts = responseRes.data?.parts || [];
            const attemptText = attemptParts.filter(p => p.type === 'text').map(p => p.text).join('');
            if (attemptText.trim() && REFUSAL_PATTERN.test(attemptText.slice(0, 150))) {
                lastError = new Error('Model refused to answer (no tools allowed in this proxy branch)');
                console.warn(`Responses attempt ${attempt}/${MAX_ATTEMPTS} refused: "${attemptText.slice(0, 60)}"`);
                if (attempt >= MAX_ATTEMPTS) {
                    responseData = responseRes.data;
                }
                continue;
            }

            responseData = responseRes.data;
            break;
        }

        if (!responseData) {
            throw lastError || new Error('All responses attempts failed');
        }

        const parts = responseData.parts || [];
        const content = parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
        const reasoningContent = parts
            .filter((p) => p.type === 'reasoning')
            .map((p) => p.text)
            .join('\n');

        const finalOutputText = buildResponsesOutputText(content, reasoningContent);
        const usage = buildResponsesUsage(fullPromptText, content, reasoningContent);

        storeResponseState(responseId, {
            sessionId,
            model: `${providerId}/${modelId}`
        });

        const result = {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'completed',
            model: `${providerId}/${modelId}`,
            output: [{
                id: outputMessageId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: finalOutputText }]
            }],
            output_text: finalOutputText,
            parallel_tool_calls: false,
            usage,
            error: null
        };
        if (ignoredTools) {
            result.metadata = { tools_support: 'tools/function calling for /v1/responses is not enabled in this branch yet and was ignored' };
        }
        return res.json(result);
    } catch (error) {
        console.error('Responses API Proxy Error:', error);
        const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
        return res.status(500).json({
            error: {
                message: 'Internal Proxy Error',
                details: errorMessage
            }
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', proxy: true });
});

export default app;
