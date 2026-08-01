import app from './app.js';

const PORT = parseInt(process.env.PROXY_PORT || '4096', 10);
const HOST = process.env.PROXY_HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`OpenCode OpenAI Proxy listening on ${HOST}:${PORT}`);
    console.log(`Forwarding to OpenCode Server on port 4097`);
});
