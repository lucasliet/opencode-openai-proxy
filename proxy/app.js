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
        const [providerId, modelId] = model.split('/');
        return { providerId, modelId };
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

        // 2. Create session
         const sessionRes = await client.session.create();
         const sessionId = sessionRes.data?.id;

         if (!sessionId) {
             throw new Error('Failed to create session');
         }
         
         if (stream) {
             res.setHeader('Content-Type', 'text/event-stream');
             res.setHeader('Cache-Control', 'no-cache');
             res.setHeader('Connection', 'keep-alive');

             const id = `chatcmpl-${crypto.randomUUID()}`;
             let completionTokens = 0;
             let reasoningTokens = 0;
             let insideReasoning = false;
             let hasStartedStreaming = false;
             const partTextMap = new Map();
             let userMessageId = null;

             try {
                 // 3. Send prompt (don't await - fire and forget)
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
                 }).catch(err => console.warn('Prompt error:', err.message));

                 // 4. Subscribe to real-time events (SSE)
                 const eventStreamResult = await client.event.subscribe();
                 const eventStream = eventStreamResult.stream;

                 // Keepalive interval
                 const keepaliveInterval = setInterval(() => {
                     if (!res.destroyed) {
                         res.write(': keepalive\n\n');
                     }
                 }, 15000);

                 // Process events
                 for await (const event of eventStream) {
                     if (res.destroyed) break;

                     const eventData = event;
                     
                     // Filter for our session
                     if (eventData.type === 'message.part.updated') {
                         const { part } = eventData.properties;
                         
                         // Skip if not our session or if this is the user's own echoed part
                         if (part.sessionID !== sessionId || part.messageID === userMessageId) continue;

                         // Server sends cumulative part.text; diff against last seen text per part
                         const hasFullText = part.text !== undefined;
                         const delta = hasFullText
                             ? part.text.slice((partTextMap.get(part.id) || '').length)
                             : (eventData.properties.delta || '');
                         if (hasFullText) partTextMap.set(part.id, part.text || '');

                         // Handle reasoning parts
                         if (part.type === 'reasoning') {
                             if (delta) {
                                 if (!insideReasoning) {
                                     res.write(`data: ${JSON.stringify({
                                         id,
                                         object: 'chat.completion.chunk',
                                         created: Math.floor(Date.now() / 1000),
                                         model: `${providerId}/${modelId}`,
                                         choices: [{
                                             index: 0,
                                             delta: { content: '<think>\n' },
                                             finish_reason: null
                                         }]
                                     })}\n\n`);
                                     insideReasoning = true;
                                     hasStartedStreaming = true;
                                 }

                                 reasoningTokens += Math.ceil(delta.length / 4);
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: delta },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                             }
                         }
                         // Handle text parts
                         else if (part.type === 'text') {
                             // Close reasoning tag if we were inside it
                             if (insideReasoning) {
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: '\n</think>\n\n' },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                                 insideReasoning = false;
                             }

                             if (delta) {
                                 completionTokens += Math.ceil(delta.length / 4);
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: delta },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                                 hasStartedStreaming = true;
                             }
                         }
                     }

                     // Check if message is complete
                     if (eventData.type === 'message.updated') {
                         const messageInfo = eventData.properties?.info;
                         
                         if (messageInfo?.sessionID === sessionId && messageInfo?.role === 'user' && !userMessageId) {
                             userMessageId = messageInfo.id;
                         }

                         if (messageInfo?.sessionID === sessionId && messageInfo?.finish === 'stop') {
                             // Close reasoning tag if still open
                             if (insideReasoning) {
                                 res.write(`data: ${JSON.stringify({
                                     id,
                                     object: 'chat.completion.chunk',
                                     created: Math.floor(Date.now() / 1000),
                                     model: `${providerId}/${modelId}`,
                                     choices: [{
                                         index: 0,
                                         delta: { content: '\n</think>\n\n' },
                                         finish_reason: null
                                     }]
                                 })}\n\n`);
                             }

                             // Calculate usage
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
                                     finish_reason: 'stop'
                                 }],
                                 usage
                             };
                             if (ignoredTools) {
                                 finalChunk.metadata = { tools_support: 'tools/function calling is not enabled in this branch yet and was ignored' };
                             }
                             res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                             res.write('data: [DONE]\n\n');
                             clearInterval(keepaliveInterval);
                             res.end();
                             break;
                         }
                     }
                 }

                 clearInterval(keepaliveInterval);
             } catch (streamError) {
                 clearInterval(keepaliveInterval);
                 console.error('Streaming error:', streamError);
                 if (!res.destroyed && !res.headersSent) {
                     res.status(500).json({ 
                         error: { 
                             message: 'Streaming error',
                             details: streamError.message
                         } 
                     });
                 } else if (!res.destroyed) {
                     res.write(`data: ${JSON.stringify({
                         error: { message: streamError.message }
                     })}\n\n`);
                     res.end();
                 }
             }
         } else {
             // 3. Non-streaming: await complete response
             const responseRes = await client.session.prompt({
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
             });

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
            let insideReasoning = false;
            const partTextMap = new Map();
            let userMessageId = null;

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

            try {
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
                }).catch((err) => console.warn('Prompt error:', err.message));

                const eventStreamResult = await client.event.subscribe();
                const eventStream = eventStreamResult.stream;

                const keepaliveInterval = setInterval(() => {
                    if (!res.destroyed) {
                        res.write(': keepalive\n\n');
                    }
                }, 15000);

                for await (const event of eventStream) {
                    if (res.destroyed) {
                        break;
                    }

                    if (event.type === 'message.part.updated') {
                        const { part } = event.properties;
                        if (part.sessionID !== sessionId || part.messageID === userMessageId) {
                            continue;
                        }

                        // Server sends cumulative part.text; diff against last seen text per part
                        const hasFullText = part.text !== undefined;
                        const delta = hasFullText
                            ? part.text.slice((partTextMap.get(part.id) || '').length)
                            : (event.properties.delta || '');
                        if (hasFullText) partTextMap.set(part.id, part.text || '');
                        if (!delta) continue;

                        if (part.type === 'reasoning') {
                            if (!insideReasoning) {
                                sendResponseSseEvent(res, {
                                    type: 'response.output_text.delta',
                                    response_id: responseId,
                                    output_index: 0,
                                    content_index: 0,
                                    delta: '<think>\n'
                                });
                                reasoningText += '<think>\n';
                                insideReasoning = true;
                            }

                            sendResponseSseEvent(res, {
                                type: 'response.output_text.delta',
                                response_id: responseId,
                                output_index: 0,
                                content_index: 0,
                                delta
                            });
                            reasoningText += delta;
                        } else if (part.type === 'text') {
                            if (insideReasoning) {
                                sendResponseSseEvent(res, {
                                    type: 'response.output_text.delta',
                                    response_id: responseId,
                                    output_index: 0,
                                    content_index: 0,
                                    delta: '\n</think>\n\n'
                                });
                                reasoningText += '\n</think>\n\n';
                                insideReasoning = false;
                            }

                            sendResponseSseEvent(res, {
                                type: 'response.output_text.delta',
                                response_id: responseId,
                                output_index: 0,
                                content_index: 0,
                                delta
                            });
                            completionText += delta;
                        }
                    }

                    if (event.type === 'message.updated') {
                        const messageInfo = event.properties?.info;
                        if (messageInfo?.sessionID === sessionId && messageInfo?.role === 'user' && !userMessageId) {
                            userMessageId = messageInfo.id;
                        }
                        if (messageInfo?.sessionID === sessionId && messageInfo?.finish === 'stop') {
                            if (insideReasoning) {
                                sendResponseSseEvent(res, {
                                    type: 'response.output_text.delta',
                                    response_id: responseId,
                                    output_index: 0,
                                    content_index: 0,
                                    delta: '\n</think>\n\n'
                                });
                                reasoningText += '\n</think>\n\n';
                            }

                            const usage = buildResponsesUsage(fullPromptText, completionText, reasoningText);

                            sendResponseSseEvent(res, {
                                type: 'response.output_item.done',
                                response_id: responseId,
                                output_index: 0,
                                item: {
                                    id: outputMessageId,
                                    type: 'message',
                                    role: 'assistant',
                                    status: 'completed',
                                    content: [{ type: 'output_text', text: `${reasoningText}${completionText}` }]
                                }
                            });

                            const finalResponseEvent = {
                                type: 'response.completed',
                                response: {
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
                            clearInterval(keepaliveInterval);
                            res.end();
                            break;
                        }
                    }
                }

                clearInterval(keepaliveInterval);
            } catch (streamError) {
                clearInterval(keepaliveInterval);
                console.error('Responses streaming error:', streamError);
                if (!res.destroyed) {
                    sendResponseSseEvent(res, {
                        type: 'error',
                        error: {
                            message: streamError.message
                        }
                    });
                    res.end();
                }
            }

            return;
        }

        const responseRes = await client.session.prompt({
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

        const parts = responseRes.data?.parts || [];
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
