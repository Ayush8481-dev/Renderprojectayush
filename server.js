const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ⚙️ GITHUB CONFIGURATION
// ==========================================
const GITHUB_OWNER = 'Ayush8481-dev'; // <--- CHANGE THIS
const GITHUB_REPO = 'Epgdata';        // <--- CHANGE THIS

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

const getXmltvTime = (epoch) => {
    const d = new Date(Number(epoch));
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
    const chunk = req.query.chunk || '1';
    const start = parseInt(req.query.start) || 0;
    const limit = parseInt(req.query.limit) || 200;
    const offset = parseInt(req.query.offset) || 0;
    const trigger = req.query.trigger === 'true';

    if (trigger) {
        res.send(`✅ Background task started for Chunk ${chunk} (Start: ${start}, Limit: ${limit}). Will fetch all at once. You can close this page!`);
        runEpgTask(chunk, start, limit, offset); 
    } else {
        await runEpgTask(chunk, start, limit, offset);
        res.send(`✅ Chunk ${chunk} completed and uploaded to GitHub instantly!`);
    }
});

// ==========================================
// 🛠️ HIGH-SPEED BACKGROUND WORKER
// ==========================================
async function runEpgTask(chunk, start, limit, offset) {
    try {
        console.log(`[Chunk ${chunk}] Fetching master channel list...`);
        
        const listResponse = await fetch('https://jtvxweb.pages.dev/jstr4web.json');
        const allChannels = await listResponse.json();

        const targetChannels = allChannels.slice(start, start + limit);
        console.log(`[Chunk ${chunk}] Firing ${targetChannels.length} requests concurrently...`);

        // 1. FORMAT: Generate ALL Channel Tags instantly at the top
        let channelsXml = '';
        for (const ch of targetChannels) {
            channelsXml += `  <channel id="${ch.id}">\n`;
            channelsXml += `    <display-name>${escapeXml(ch.name)}</display-name>\n`;
            if (ch.logo) channelsXml += `    <icon src="${escapeXml(ch.logo)}"/>\n`;
            channelsXml += `  </channel>\n`;
        }

        // 2. EXECUTION: Fire all 200 HTTP requests AT THE EXACT SAME TIME using Promise.all
        const fetchPromises = targetChannels.map(async (ch) => {
            const jioUrl = `https://jiotv.data.cdn.jio.com/apis/v1.3/getepg/get?channel_id=${ch.id}&offset=${offset}`;
            try {
                const epgResponse = await fetch(jioUrl, {
                    headers: { 'User-Agent': 'okhttp/4.2.2', 'os': 'android', 'Accept': '*/*' }
                });
                
                if (!epgResponse.ok) return { xml: '', firstEpoch: null };
                
                const epgData = await epgResponse.json();
                if (!epgData.epg || epgData.epg.length === 0) return { xml: '', firstEpoch: null };

                let tempProgXml = '';
                const firstEpoch = epgData.epg[0].startEpoch; // Extract epoch for Date later

                for (const prog of epgData.epg) {
                    const startTime = getXmltvTime(prog.startEpoch);
                    const stopTime = getXmltvTime(prog.endEpoch);
                    
                    tempProgXml += `  <programme start="${startTime}" stop="${stopTime}" channel="${ch.id}">\n`;
                    tempProgXml += `    <title>${escapeXml(prog.showname)}</title>\n`;
                    if (prog.description) tempProgXml += `    <desc>${escapeXml(prog.description)}</desc>\n`;
                    if (prog.showCategory) tempProgXml += `    <category>${escapeXml(prog.showCategory)}</category>\n`;
                    
                    let iconUrl = '';
                    if (prog.assets && prog.assets["16:9"] && prog.assets["16:9"].originalProgram) {
                        iconUrl = prog.assets["16:9"].originalProgram;
                    } else if (prog.episodeThumbnail) {
                        iconUrl = `https://jiotv.catchup.cdn.jio.com/dare_images/${prog.episodeThumbnail}`;
                    } else if (prog.episodePoster) {
                        iconUrl = `https://jiotv.catchup.cdn.jio.com/dare_images/shows/${prog.episodePoster}`;
                    }
                    if (iconUrl) tempProgXml += `    <icon src="${escapeXml(iconUrl)}"/>\n`;
                    tempProgXml += `  </programme>\n`;
                }

                return { xml: tempProgXml, firstEpoch: firstEpoch };
            } catch (err) {
                console.error(`[Chunk ${chunk}] Request failed for ${ch.name}: ${err.message}`);
                return { xml: '', firstEpoch: null };
            }
        });

        // ⏱️ Wait a maximum of ~2-3 seconds for all 200 channels to finish!
        const epgResults = await Promise.all(fetchPromises);

        // 3. Extract the correct exact File Date securely from the successful data
        let fileDate = '';
        for (const res of epgResults) {
            if (res.firstEpoch) {
                const epochDate = new Date(Number(res.firstEpoch));
                const yyyy = epochDate.getUTCFullYear();
                const mm = String(epochDate.getUTCMonth() + 1).padStart(2, '0');
                const dd = String(epochDate.getUTCDate()).padStart(2, '0');
                fileDate = `${yyyy}-${mm}-${dd}`;
                break; // Date acquired successfully, stop searching
            }
        }
        
        if (!fileDate) {
            const fallbackDate = new Date(Date.now() + (offset * 86400000));
            fileDate = fallbackDate.toISOString().substring(0, 10);
        }

        // 4. Combine all the extracted program data together at the bottom
        const programmesXml = epgResults.map(result => result.xml).join('');

        // 5. Perfect Output: <tv> -> All Channels -> All Programmes -> </tv>
        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${channelsXml}\n${programmesXml}</tv>`;

        // Upload to GitHub
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
    const fileContentBase64 = Buffer.from(xmlContent, 'utf-8').toString('base64');
    let fileSha = undefined;

    const checkExisting = await fetch(githubFileUrl, {
        headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` }
    });
    
    if (checkExisting.ok) {
        const existingFileData = await checkExisting.json();
        fileSha = existingFileData.sha;
    }

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

app.get('/', (req, res) => {
    res.send("EPG Generator is running! Trigger chunks via /generate");
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
