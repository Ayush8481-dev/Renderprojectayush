const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ⚙️ GITHUB CONFIGURATION
// ==========================================
const GITHUB_OWNER = "Ayush8481-dev"; // <--- CHANGE THIS IF NEEDED
const GITHUB_REPO = "Epgdata";     // <--- CHANGE THIS IF NEEDED

// High-speed Native String replace for XML
const escapeMap = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const escapeXml = (unsafe) => {
    if (!unsafe) return "";
    return String(unsafe).replace(/[<>&'"]/g, c => escapeMap[c]);
};

// Ultra-Fast Native Date slicing into IST (+0530)
const formatXmltvTime = (epoch) => {
    const iso = new Date(Number(epoch) + 19800000).toISOString(); 
    return iso.substring(0,4) + iso.substring(5,7) + iso.substring(8,10) + iso.substring(11,13) + iso.substring(14,16) + iso.substring(17,19) + " +0530";
};

// ==========================================
// 🚀 API ENDPOINT
// ==========================================
app.get('/generate', async (req, res) => {
    const chunk = req.query.chunk || '1';
    const start = parseInt(req.query.start) || 0;
    const limit = parseInt(req.query.limit) || 200; 
    const offset = parseInt(req.query.offset) || 0;
    const trigger = req.query.trigger === 'true';

    if (trigger) {
        // Instantly release the cron-job connection
        res.status(200).json({ success: true, message: `Worker started for Chunk ${chunk}. Downloading directly from JioTV...` });
        runEpgTask(chunk, start, limit, offset); 
    } else {
        await runEpgTask(chunk, start, limit, offset);
        res.send(`✅ Chunk ${chunk} completed!`);
    }
});

// ==========================================
// 🛠️ HEAVY BACKGROUND WORKER
// ==========================================
async function runEpgTask(chunk, start, limit, offset) {
    try {
        console.log(`[Chunk ${chunk}] Fetching channel list...`);
        const chReq = await fetch("https://raw.githubusercontent.com/Ayush8481Lab/KuchuShow/refs/heads/main/ayushtv.json");
        const channelsData = await chReq.json();
        const channelsArray = Array.isArray(channelsData) ? channelsData : (channelsData.channels || []);

        const validChannels = channelsArray.map(c => ({
            name: c.name, logo: c.logo || c.logoUrl || "", jio_id: String(c.id || c.channel_id).trim()
        })).filter(c => c.jio_id && /^\d+$/.test(c.jio_id));

        const batch = validChannels.slice(start, start + limit);
        if (batch.length === 0) return console.log(`[Chunk ${chunk}] No more channels.`);

        console.log(`[Chunk ${chunk}] Firing ${batch.length} concurrent direct requests...`);

        // Resilient Fetch Function with 5 Retries (Handles random dropped requests)
        const fetchChannelWithRetry = async (channel) => {
            const jioUrl = `https://jiotvapi.cdn.jio.com/apis/v1.3/getepg/get?channel_id=${channel.jio_id}&offset=${offset}`;
            
            let retries = 5; 
            while (retries > 0) {
                try {
                    const epgRes = await fetch(jioUrl, {
                        headers: { 
                            'User-Agent': 'okhttp/4.2.2',
                            'os': 'android',
                            'Accept': '*/*'
                        }
                    });
                    
                    if (epgRes.ok) return { channel, data: await epgRes.json() };
                    if (epgRes.status === 404) return { channel, data: null };
                } catch (err) {
                    // Wait 500ms before retrying to let the network recover
                    await new Promise(r => setTimeout(r, 500));
                }
                retries--;
            }
            return { channel, data: null };
        };

        // Fire all requests concurrently! (No ScraperAPI needed)
        const fetchPromises = batch.map((channel) => fetchChannelWithRetry(channel));
        const results = await Promise.all(fetchPromises);

        const xmlLines = [];
        let dynamicServerDate = null;

        // Loop through results and apply exact Interleaved Layout (Channel -> Programs)
        for (let i = 0; i < results.length; i++) {
            const { channel, data } = results[i];
            
            // Format Logo Fallback
            let finalLogo = channel.logo;
            if (finalLogo && !finalLogo.startsWith("http")) finalLogo = `https://jiotv.catchup.cdn.jio.com/dare_images/images/${finalLogo}`;

            // Create <channel> Tag
            let channelBlock = `  <channel id="${channel.jio_id}">\n    <display-name>${escapeXml(channel.name)}</display-name>`;
            if (finalLogo) channelBlock += `\n    <icon src="${escapeXml(finalLogo)}" />`;
            channelBlock += `\n  </channel>`;
            
            xmlLines.push(channelBlock);

            // Create <programme> Tags immediately underneath
            if (data && data.epg && data.epg.length > 0) {
                if (!dynamicServerDate && data.epg[0].serverDate) {
                    dynamicServerDate = data.epg[0].serverDate.substring(0, 10); 
                }

                for (let j = 0; j < data.epg.length; j++) {
                    const show = data.epg[j];
                    const startXml = formatXmltvTime(show.startEpoch);
                    const stopXml = formatXmltvTime(show.endEpoch);
                    const titleXml = escapeXml(show.showname);
                    const descXml = show.description ? `\n    <desc>${escapeXml(show.description)}</desc>` : "";
                    const catXml = show.showCategory ? `\n    <category>${escapeXml(show.showCategory)}</category>` : "";
                    
                    xmlLines.push(`  <programme start="${startXml}" stop="${stopXml}" channel="${channel.jio_id}">\n    <title>${titleXml}</title>${descXml}${catXml}\n  </programme>`);
                }
            }
        }

        // Apply Server Date Fallback if missing
        if (!dynamicServerDate) {
            const istDate = new Date(Date.now() + 19800000 + (offset * 86400000)); 
            dynamicServerDate = istDate.toISOString().substring(0, 10);
        }

        // Combine into Final Output
        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${xmlLines.join('\n')}\n</tv>`;

        // Upload to GitHub
        const FILE_PATH = `Epg/${dynamicServerDate}-${chunk}.xml`;
        await uploadToGitHub(FILE_PATH, finalXml, chunk);

    } catch (error) {
        console.error(`[Chunk ${chunk}] FATAL ERROR:`, error.message);
    }
}

// ==========================================
// ☁️ GITHUB UPLOADER
// ==========================================
async function uploadToGitHub(filePath, xmlContent, chunkName) {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) return console.error("❌ MISSING GITHUB TOKEN!");

    console.log(`[Chunk ${chunkName}] Preparing to process: ${filePath}`);
    const githubFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    const fileContentBase64 = Buffer.from(xmlContent, 'utf-8').toString('base64');
    
    // STEP 1: Check if the exact same file exists
    let fileSha = undefined;
    try {
        const checkExisting = await fetch(`${githubFileUrl}?t=${Date.now()}`, { // cache buster ensures live check
            headers: { 
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Cache-Control': 'no-cache'
            }
        });
        if (checkExisting.ok) {
            const existingFileData = await checkExisting.json();
            fileSha = existingFileData.sha;
        }
    } catch(e) {
        console.error(`[Chunk ${chunkName}] Error checking for existing file.`);
    }

    // STEP 2: If the file exists, DELETE it first
    if (fileSha) {
        console.log(`[Chunk ${chunkName}] 🗑️ Exact same file found. Deleting it first...`);
        const deleteRes = await fetch(githubFileUrl, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Express-EPG-Generator'
            },
            body: JSON.stringify({
                message: `Deleting existing EPG Chunk ${chunkName} before new upload`,
                sha: fileSha
            })
        });

        if (deleteRes.ok) {
            console.log(`[Chunk ${chunkName}] ✅ Old file deleted successfully.`);
        } else {
            console.error(`[Chunk ${chunkName}] ⚠️ Failed to delete old file.`);
        }
    }

    // STEP 3: UPLOAD the fresh new file
    console.log(`[Chunk ${chunkName}] 📤 Uploading new file...`);
    const uploadResponse = await fetch(githubFileUrl, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Express-EPG-Generator'
        },
        body: JSON.stringify({
            message: `Auto-uploaded fresh EPG Chunk ${chunkName}`,
            content: fileContentBase64
        })
    });

    if (uploadResponse.ok) {
        console.log(`🎉 [Chunk ${chunkName}] Uploaded successfully to GitHub!`);
    } else {
        const errorData = await uploadResponse.json();
        console.error(`❌ [Chunk ${chunkName}] GitHub Upload Error:`, errorData);
    }
}

app.get('/', (req, res) => res.send("EPG Scraper is Running!"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
