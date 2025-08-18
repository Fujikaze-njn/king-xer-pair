const express = require('express');
const { put, list, del } = require('@vercel/blob');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('baileys');
const { createClient } = require('@supabase/supabase-js');
const { Mutex } = require('async-mutex');
const config = require('./config');
const path = require('path');

const app = express();
const port = config.PORT || 3000;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();
let session;

// Initialize Supabase client
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

// Function to upload session files to Vercel Blob
async function uploadSessionToBlob(sessionFiles) {
    try {
        const sessionId = Date.now().toString(); // Unique ID for the session
        const uploadedFiles = [];
        
        // Upload each file to Vercel Blob
        for (const [fileName, fileContent] of Object.entries(sessionFiles)) {
            const { url } = await put(`${sessionId}/${fileName}`, fileContent, {
                access: 'public',
                addRandomSuffix: false
            });
            uploadedFiles.push(url);
        }
        
        return { sessionId, urls: uploadedFiles };
    } catch (error) {
        console.error('Vercel Blob upload error:', error);
        throw error;
    }
}

// WhatsApp connection handler
async function connector(phoneNumber, res) {
    // Use in-memory storage for session files instead of temp directory
    const sessionFiles = {};
    
    const { state, saveCreds } = await useMultiFileAuthState(
        './temp_session', // This path is virtual when using in-memory
        {
            // Custom read/write functions to avoid filesystem
            readFile: async (filePath) => {
                const fileName = path.basename(filePath);
                return sessionFiles[fileName] || null;
            },
            writeFile: async (filePath, data) => {
                const fileName = path.basename(filePath);
                sessionFiles[fileName] = data;
            },
            removeFile: async (filePath) => {
                const fileName = path.basename(filePath);
                delete sessionFiles[fileName];
            }
        }
    );

    session = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        msgRetryCounterCache
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await session.requestPairingCode(cleanNumber);
        
        if (!res.headersSent) {
            res.json({ 
                success: true,
                code: code?.match(/.{1,4}/g)?.join('-'),
                message: 'Use this code to pair your device'
            });
        }
    }

    session.ev.on('creds.update', saveCreds);

    session.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log('WhatsApp connected successfully');
            await delay(5000);
            
            try {
                // Upload session to Vercel Blob
                const { sessionId, urls } = await uploadSessionToBlob(sessionFiles);
                const fullSessionId = config.PREFIX + sessionId;
                
                // Send confirmation with session ID
                await session.sendMessage(session.user.id, { 
                    text: `*Session ID*\n\n${fullSessionId}\n\n${config.MESSAGE}`
                });
                
                if (config.IMAGE) {
                    await session.sendMessage(session.user.id, { 
                        image: { url: config.IMAGE },
                        caption: 'Your session has been created successfully!'
                    });
                }
            } catch (error) {
                console.error('Session handling error:', error);
            } finally {
                // Clean up session files from memory
                Object.keys(sessionFiles).forEach(key => delete sessionFiles[key]);
                session.end();
            }
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            handleDisconnect(reason);
        }
    });
}

function handleDisconnect(reason) {
    if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired].includes(reason)) {
        console.log('Connection lost, attempting to reconnect...');
        connector();
    } else {
        console.log(`Disconnected! Reason: ${reason}`);
        if (session) session.end();
    }
}

// Pairing endpoint
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.number;
    if (!phoneNumber) {
        return res.status(400).json({ 
            success: false,
            error: 'Phone number is required'
        });
    }
  
    const release = await mutex.acquire();
    try {
        await connector(phoneNumber, res);
    } catch (error) {
        console.error('Pairing error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to generate pairing code'
        });
    } finally {
        release();
    }
});

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});