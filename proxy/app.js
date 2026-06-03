import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';
import { createOpencodeClient } from '@opencode-ai/sdk';

const app = express();
const TARGET_PORT = 4097;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

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
        const { messages, model, stream } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: { message: 'messages array is required' } });
        }

        let providerId, modelId;

        if (model && model.includes('/')) {
            [providerId, modelId] = model.split('/');
        } else {
            providerId = 'opencode';
            modelId = 'big-pickle';
        }

        const client = getClient();

        console.log(`Using model: ${providerId}/${modelId}${stream ? ' (streaming)' : ''}`);

        // Process messages to OpenCode Parts
        const allParts = [];
        let fullPromptText = '';
        let systemPrompt = '';

        for (const m of messages) {
            if (m.role === 'system') {
                systemPrompt += (typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join('\n')) + '\n';
                continue;
            }

            const role = m.role === 'user' ? 'User' : 'Assistant';
            
            if (typeof m.content === 'string') {
                allParts.push({ type: 'text', text: m.content });
                fullPromptText += `${role}: ${m.content}\n\n`;
            } else if (Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (part.type === 'text') {
                        allParts.push({ type: 'text', text: part.text });
                        fullPromptText += `${role}: ${part.text}\n\n`;
                    } else if (part.type === 'image_url') {
                        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
                        try {
                            const dataUri = await getImageDataUri(url);
                            const mime = dataUri.split(';')[0].split(':')[1];
                            allParts.push({
                                type: 'file',
                                mime: mime,
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
        }
        
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

             const id = `chatcmpl-${Date.now()}`;
             let completionTokens = 0;
             let reasoningTokens = 0;
             let insideReasoning = false;
             let hasStartedStreaming = false;

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
                         const { part, delta } = eventData.properties;
                         
                         // Skip if not our session
                         if (part.sessionID !== sessionId) continue;

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

                             res.write(`data: ${JSON.stringify({
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
                             })}\n\n`);
                             res.write('data: [DONE]\n\n');
                             clearInterval(keepaliveInterval);
                             res.end();
                             break;
                         }
                     }
                 }

                 clearInterval(keepaliveInterval);
             } catch (streamError) {
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
                 id: `chatcmpl-${Date.now()}`,
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

app.get('/health', (req, res) => {
    res.json({ status: 'ok', proxy: true });
});

export default app;
