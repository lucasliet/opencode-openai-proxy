import request from 'supertest';
import { jest } from '@jest/globals';

// Define mock before importing the app
jest.unstable_mockModule('axios', () => ({
    default: {
        get: jest.fn(async () => ({
            data: Buffer.from('fake-image-data'),
            headers: { 'content-type': 'image/png' }
        }))
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => {
    const client = {
        config: {
            providers: jest.fn(async () => ({
                data: {
                    providers: [
                        {
                            id: 'opencode',
                            models: {
                                'big-pickle': { id: 'big-pickle' }
                            }
                        }
                    ]
                }
            })),
            update: jest.fn(async () => ({}))
        },
        session: {
            create: jest.fn(async () => ({
                data: { id: 'test-session-id' }
            })),
            prompt: jest.fn(async (args) => {
                const promptText = args.body.prompt || '';
                const parts = [{ type: 'text', text: 'Simulated response' }];

                if (promptText.includes('reasoning')) {
                    parts.unshift({ type: 'reasoning', text: 'Thinking process...' });
                }

                return {
                    data: { parts }
                };
            })
        },
        event: {
            subscribe: jest.fn(async () => {
                const sessionId = 'test-session-id';
                const mockEvents = [
                    { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'Thinking...' } },
                    { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'Simulated' } },
                    { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: ' response' } },
                    { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
                ];

                return {
                    stream: (async function* () {
                        for (const event of mockEvents) {
                            yield event;
                        }
                    })()
                };
            })
        }
    };
    return { createOpencodeClient: jest.fn(() => client) };
});


const { default: app } = await import('../app.js');
const { createOpencodeClient } = await import('@opencode-ai/sdk');

describe('Proxy OpenAI API', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, OPENCODE_SERVER_PASSWORD: 'test-password' };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('GET /health should return status ok without auth', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toEqual({ status: 'ok', proxy: true });
    });

    test('should fail without authentication on v1 endpoints', async () => {
        const res = await request(app).get('/v1/models');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /v1/models should return OpenAI-compatible model list', async () => {
        const res = await request(app)
            .get('/v1/models')
            .set('Authorization', 'Bearer test-password');

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('list');
        expect(res.body.data[0].id).toEqual('opencode/big-pickle');
    });

    test('POST /v1/chat/completions should return chat completion', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
        expect(res.body.choices[0].message.content).toEqual('Simulated response');
    });

    test('POST /v1/chat/completions should support streaming with <think> tags', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: {"id"');
        expect(res.text).toContain('data: [DONE]');
        expect(res.text).toContain('Simulated');
    });

    test('POST /v1/chat/completions should support streaming with inline reasoning', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('<think>');
        expect(res.text).toContain('</think>');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should support multimodal content (images)', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ 
                    role: 'user', 
                    content: [
                        { type: 'text', text: 'What is in this image?' },
                        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
                    ]
                }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('Simulated response');
    });

    test('POST /v1/chat/completions should not generate empty think tags when reasoning has no content (issue #1)', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'The user is asking' } };
                yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: ' a simple math question' } };
                yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: '. The answer is 2.' } };
                yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: '1+1' } };
                yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: ' = 2' } };
                yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: null } };
                yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: undefined } };
                yield { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } };
            })()
        }));

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: '1+1=?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);

        const thinkOpenCount = (res.text.match(/<think>/g) || []).length;
        const thinkCloseCount = (res.text.match(/<\/think>/g) || []).length;
        expect(thinkOpenCount).toEqual(1);
        expect(thinkCloseCount).toEqual(1);
    });

    test('POST /v1/chat/completions should stream cumulative part.text and skip user echo', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield { type: 'message.updated', properties: { info: { id: 'msg_user', sessionID: sessionId, role: 'user' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_user', messageID: 'msg_user', sessionID: sessionId, type: 'text', text: 'Stream a short answer' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_reasoning', messageID: 'msg_assistant', sessionID: sessionId, type: 'reasoning', text: 'Think' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_reasoning', messageID: 'msg_assistant', sessionID: sessionId, type: 'reasoning', text: 'Thinking...' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_text', messageID: 'msg_assistant', sessionID: sessionId, type: 'text', text: '' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_text', messageID: 'msg_assistant', sessionID: sessionId, type: 'text', text: 'Banana' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_text', messageID: 'msg_assistant', sessionID: sessionId, type: 'text', text: 'Banana!' } } };
                yield { type: 'message.updated', properties: { info: { id: 'msg_assistant', sessionID: sessionId, role: 'assistant', finish: 'stop' } } };
            })()
        }));

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Stream a short answer' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('<think>');
        expect(res.text).toContain('</think>');
        expect(res.text).toContain('"content":"Banana"');
        expect(res.text).toContain('"content":"!"');
        expect(res.text).not.toContain('Stream a short answer');
        expect(res.text).toContain('"finish_reason":"stop"');
        expect(res.text).toContain('data: [DONE]');
    });


    test('POST /v1/chat/completions should return reasoning tokens when available (non-streaming)', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Test with reasoning' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toContain('<think>\nThinking process...\n</think>\n\nSimulated response');
        expect(res.body.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
        expect(res.body.choices[0].message.reasoning_content).toBeUndefined();
    });

    test('POST /v1/responses should return response format in non-streaming', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.status).toEqual('completed');
        expect(res.body.output[0].type).toEqual('message');
        expect(res.body.output[0].content[0].type).toEqual('output_text');
    });

    test('POST /v1/responses should support streaming in responses format', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('"type":"response.created"');
        expect(res.text).toContain('"type":"response.output_text.delta"');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should stream cumulative part.text and skip user echo', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield { type: 'message.updated', properties: { info: { id: 'msg_user', sessionID: sessionId, role: 'user' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_user', messageID: 'msg_user', sessionID: sessionId, type: 'text', text: 'Stream a short answer' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_reasoning', messageID: 'msg_assistant', sessionID: sessionId, type: 'reasoning', text: 'Think' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_reasoning', messageID: 'msg_assistant', sessionID: sessionId, type: 'reasoning', text: 'Thinking...' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_text', messageID: 'msg_assistant', sessionID: sessionId, type: 'text', text: '' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_text', messageID: 'msg_assistant', sessionID: sessionId, type: 'text', text: 'Banana' } } };
                yield { type: 'message.part.updated', properties: { part: { id: 'prt_text', messageID: 'msg_assistant', sessionID: sessionId, type: 'text', text: 'Banana!' } } };
                yield { type: 'message.updated', properties: { info: { id: 'msg_assistant', sessionID: sessionId, role: 'assistant', finish: 'stop' } } };
            })()
        }));

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Stream a short answer',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"type":"response.created"');
        expect(res.text).toContain('Banana!');
        expect(res.text).not.toContain('Stream a short answer');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should support previous_response_id', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'First message'
            });

        expect(first.statusCode).toEqual(200);
        expect(first.body.id).toBeDefined();

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: first.body.id,
                input: 'Follow-up'
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.object).toEqual('response');
    });

    test('POST /v1/responses should reject invalid previous_response_id', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: 'resp_invalid',
                input: 'test'
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('previous_response_id');
    });

    test('POST /v1/responses should ignore tools and return warning in metadata', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Test',
                tools: [{ type: 'function', function: { name: 'weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.metadata.tools_support).toContain('ignored');
    });

    test('POST /v1/responses should not reject if tools is empty or tool_choice is none', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Test',
                tools: [],
                tool_choice: 'none'
            });

        expect(res.statusCode).toEqual(200);
    });

    test('POST /v1/chat/completions should ignore tools and return warning in metadata', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Test' }],
                tools: [{ type: 'function', function: { name: 'weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.metadata.tools_support).toContain('ignored');
    });

    test('POST /v1/chat/completions should not reject if tools is empty or tool_choice is none', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Test' }],
                tools: [],
                tool_choice: 'none'
            });

        expect(res.statusCode).toEqual(200);
    });
});
