const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ⚙️ GITHUB CONFIGURATION
// ==========================================
const GITHUB_OWNER = 'Ayush8481-dev'; // <--- CHANGE THIS
const GITHUB_REPO = 'Epgdata';        // <--- CHANGE THIS

// Helper to escape special characters for valid XML (Safely converted to String)
const escapeXml = (unsafe) => {
    if (unsafe === null || unsafe === undefined || unsafe === '') return '';
    return String(unsafe).replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
};

// Helper to convert Epoch time (1786041000000) to XMLTV format (YYYYMMDDHHMMSS +0000)
const getXmltvTime = (epoch) => {
    const d = new Date(Number(epoch)); // Wrapped in Number() to prevent string parse errors
    const pad = (n) => n.toString().padStart(2, '0');
    const YYYY = d.getUTCFullYear();
    const MM = pad(d.getUTCMonth() + 1);
    const DD = pad(d.getUTCDate());
    const HH = pad(d.getUTCHours());
    const mm = pad(d.getUTCMinutes());
    const ss = pad(d.getUTCSeconds());
    return `${YYYY}${MM}${DD}${HH}${mm}${ss} +0000`;
};

// ==========================================
// 🚀 THE MAIN API ENDPOINT
// ==========================================
app.get('/generate', async (req, res) => {
    // Get parameters from URL
    const chunk = req.query.chunk || '1';
    const start = parseInt(req.query.start) || 0;
    const limit = parseInt(req.query.limit) || 200;
    const offset = parseInt(req.query.offset) || 0;
    const trigger = req.query.trigger === 'true';

    // FIRE AND FORGET: Reply instantly so cron-job.org marks it as successful
    if (trigger) {
        res.send(`✅ Background task started for Chunk ${chunk} (Start: ${start}, Limit: ${limit}, Offset: ${offset}). You can close this page!`);
        runEpgTask(chunk, start, limit, offset); 
    } else {
        // If trigger is not true, wait for it to finish (Good for testing manually)
        await runEpgTask(chunk, start, limit, offset);
        res.send(`✅ Chunk ${chunk} completed and uploaded to GitHub!`);
    }
});

// ==========================================
// 🛠️ THE BACKGROUND WORKER
// ==========================================
async function runEpgTask(chunk, start, limit, offset) {
    try {
        console.log(`[Chunk ${chunk}] Fetching master channel list...`);
        
        // 1. Fetch the master JSON list of channels
        const listResponse = await fetch('https://jtvxweb.pages.dev/jstr4web.json');
        const allChannels = await listResponse.json();

        // Slice the list based on chunk limits (e.g., 0 to 200)
        const targetChannels = allChannels.slice(start, start + limit);
        console.log(`[Chunk ${chunk}] Processing ${targetChannels.length} channels...`);

        let channelsXml = '';
        let programmesXml = '';
        
        // Calculate the date upfront instead of extracting it from the API!
        // This prevents the loop from crashing on starting channels that miss 'serverDate'.
        const targetDate = new Date(Date.now() + (offset * 86400000));
        const fileDate = targetDate.toISOString().substring(0, 10);

        // 2. Loop through our chunk of channels safely
        for (let i = 0; i < targetChannels.length; i++) {
            const ch = targetChannels[i];
            
            // Generate the <channel> XML header
            channelsXml += `  <channel id="${ch.id}">\n`;
            channelsXml += `    <display-name>${escapeXml(ch.name)}</display-name>\n`;
            if (ch.logo) channelsXml += `    <icon src="${escapeXml(ch.logo)}"/>\n`;
            channelsXml += `  </channel>\n`;

            // 3. Fetch EPG Data for this channel
            const jioUrl = `https://jiotvapi.cdn.jio.com/apis/v1.3/getepg/get?channel_id=${ch.id}&offset=${offset}&langId=6`;
            
            try {
                const epgResponse = await fetch(jioUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                
                if (epgResponse.ok) {
                    const epgData = await epgResponse.json();

                    if (epgData.epg && epgData.epg.length > 0) {
                        // Generate <programme> XML tags
                        for (const prog of epgData.epg) {
                            const startTime = getXmltvTime(prog.startEpoch);
                            const stopTime = getXmltvTime(prog.endEpoch);
                            
                            programmesXml += `  <programme start="${startTime}" stop="${stopTime}" channel="${ch.id}">\n`;
                            programmesXml += `    <title>${escapeXml(prog.showname)}</title>\n`;
                            if (prog.description) programmesXml += `    <desc>${escapeXml(prog.description)}</desc>\n`;
                            if (prog.showCategory) programmesXml += `    <category>${escapeXml(prog.showCategory)}</category>\n`;
                            
                            // Try to get a high-quality poster, otherwise fallback to thumbnail
                            let iconUrl = '';
                            if (prog.assets && prog.assets["16:9"] && prog.assets["16:9"].originalProgram) {
                                iconUrl = prog.assets["16:9"].originalProgram;
                            } else if (prog.episodeThumbnail) {
                                iconUrl = `https://jiotv.catchup.cdn.jio.com/dare_images/${prog.episodeThumbnail}`;
                            } else if (prog.episodePoster) {
                                iconUrl = `https://jiotv.catchup.cdn.jio.com/dare_images/shows/${prog.episodePoster}`;
                            }
                            if (iconUrl) programmesXml += `    <icon src="${escapeXml(iconUrl)}"/>\n`;
                            
                            programmesXml += `  </programme>\n`;
                        }
                    }
                }
            } catch (err) {
                console.error(`[Chunk ${chunk}] Failed to fetch EPG for channel ${ch.name}`);
            }

            // ⏱️ THE MAGIC DELAY: Wait 500ms (2 requests per second) to prevent bans
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 4. Combine all the XML data perfectly
        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${channelsXml}\n${programmesXml}</tv>`;

        // 5. Upload to GitHub
        const FILE_PATH = `Epg/${fileDate}-${chunk}.xml`;
        await uploadToGitHub(FILE_PATH, finalXml, chunk);

    } catch (error) {
        console.error(`[Chunk ${chunk}] FATAL ERROR:`, error.message);
    }
}

// ==========================================
// ☁️ GITHUB UPLOADER
// ==========================================
async function uploadToGitHub(filePath, xmlContent, chunkName) {
    console.log(`[Chunk ${chunkName}] Preparing to upload: ${filePath}`);
    
    const githubFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    
    // GitHub API strictly requires files to be Base64 encoded
    const fileContentBase64 = Buffer.from(xmlContent, 'utf-8').toString('base64');
    let fileSha = undefined;

    // Check if file already exists so we can overwrite it
    const checkExisting = await fetch(githubFileUrl, {
        headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` }
    });
    
    if (checkExisting.ok) {
        const existingFileData = await checkExisting.json();
        fileSha = existingFileData.sha;
    }

    // Upload / Overwrite File
    const uploadResponse = await fetch(githubFileUrl, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: `Auto-updated EPG Chunk ${chunkName}`,
            content: fileContentBase64,
            sha: fileSha 
        })
    });

    if (uploadResponse.ok) {
        console.log(`🎉 [Chunk ${chunkName}] Uploaded successfully to GitHub!`);
    } else {
        const errorData = await uploadResponse.json();
        console.error(`❌ [Chunk ${chunkName}] GitHub Upload Error:`, errorData);
    }
}

// Home route
app.get('/', (req, res) => {
    res.send("EPG Generator is running! Trigger chunks via /generate");
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
