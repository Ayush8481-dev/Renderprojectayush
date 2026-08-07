const corsProxy = require('cors-anywhere');
const PORT = process.env.PORT || 3000;

corsProxy.createServer({
    originWhitelist: [], // Allow all origins
    requireHeader: [],   // Allows you to use it directly in the browser URL bar
    removeHeaders: ['cookie', 'cookie2']
}).listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
